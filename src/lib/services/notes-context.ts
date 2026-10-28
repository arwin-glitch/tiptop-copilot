import 'server-only';
import { isLpList } from '@/lib/crm/lp-rule';
import { chunk } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { isTeamVisibleNote } from '@/lib/notes/visibility';
import { domainOf, pickTemplate, type TemplatePick } from '@/lib/notes/template-pick';
import { log } from '@/lib/security/redact';
import { readTeam, type TeamMember } from '@/lib/tasks/principal';
import type {
  CrmList,
  CrmListEntry,
  CrmRecord,
  Deal,
  MeetingNote,
  NetworkContact,
  PortfolioCompany,
} from '@/lib/types/domain';
import type { Meeting, MeetingParticipant, NoteTemplate } from '@/lib/types/notes';
import type { NotesContext } from './notes';

/**
 * What Kraken already knows about the people in a meeting (D-076): the
 * team (and whose promises are the principal's), the guests' companies in
 * the deal pipeline and the portfolio, who is on an LP list (stages only,
 * never amounts), the guests in the network, and earlier meetings with them.
 *
 * It feeds the notes (Granola's notes know only the meeting; Kraken's know
 * the deal stage), the template auto-pick and the chat. Every read is caught
 * on its own: a CRM table that is not there yet makes that part empty, never
 * the notes fail.
 */

export interface TeamInfo {
  members: TeamMember[];
  principalId: string | null;
  principalEmail: string | null;
  /** Bare domains of the team's sign-in addresses. */
  domains: Set<string>;
  /** Lowercased sign-in addresses of the team. */
  emails: Set<string>;
}

export async function readTeamInfo(store: DataStore, organizationId: string): Promise<TeamInfo> {
  try {
    const team = await readTeam(store, organizationId);
    const emails = new Set(
      team.members.map((m) => m.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)),
    );
    const principal = team.members.find((m) => m.userId === team.principal?.userId) ?? null;
    return {
      members: team.members,
      principalId: team.principal?.userId ?? null,
      principalEmail: principal?.email?.toLowerCase() ?? null,
      domains: new Set([...emails].map(domainOf).filter((d): d is string => Boolean(d))),
      emails,
    };
  } catch (error) {
    log.warn('Kraken Notes: the team could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      members: [],
      principalId: null,
      principalEmail: null,
      domains: new Set(),
      emails: new Set(),
    };
  }
}

export interface MeetingCrmContext {
  deals: { company: string; domain: string; stage: string }[];
  portfolio: { name: string; domain: string; stage: string | null }[];
  /** Guest emails and domains found on an LP list. Stages only: no amount is read. */
  lpKeys: Set<string>;
  contacts: {
    name: string;
    email: string;
    title: string | null;
    company: string | null;
    relationship: string | null;
  }[];
  earlier: { title: string; date: string; source: 'copilot' | 'granola'; excerpt: string }[];
}

async function settle<T>(what: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log.warn('Kraken Notes: a context read failed', {
      what,
      reason: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/** Guests from outside the team: lowercased emails. */
export function externalEmailsOf(
  participants: readonly Pick<MeetingParticipant, 'email' | 'role'>[],
  team: Pick<TeamInfo, 'emails' | 'domains'>,
): string[] {
  return [
    ...new Set(
      participants
        .filter((p) => p.role !== 'self' && p.email)
        .map((p) => (p.email as string).toLowerCase())
        .filter((e) => !team.emails.has(e) && !team.domains.has(domainOf(e) ?? '')),
    ),
  ];
}

const EXCERPT = 400;

export async function meetingCrmContext(
  ctx: NotesContext,
  meeting: Pick<Meeting, 'id' | 'started_at' | 'scheduled_start' | 'created_at'>,
  participants: readonly Pick<MeetingParticipant, 'email' | 'role'>[],
  team: TeamInfo,
): Promise<MeetingCrmContext> {
  const store = ctx.store;
  const org = ctx.auth.organizationId;
  const emails = externalEmailsOf(participants, team);
  const domains = [...new Set(emails.map(domainOf).filter((d): d is string => Boolean(d)))];
  const empty: MeetingCrmContext = {
    deals: [],
    portfolio: [],
    lpKeys: new Set(),
    contacts: [],
    earlier: [],
  };
  if (emails.length === 0) return empty;

  const [deals, portfolio, contacts, lpKeys, earlier] = await Promise.all([
    settle('deals', [] as Deal[], async () =>
      domains.length
        ? ((await store.list('deals', org, { in: { domain: domains } }, { limit: 20 })) as Deal[])
        : [],
    ),
    settle('portfolio', [] as PortfolioCompany[], async () =>
      domains.length
        ? ((await store.list(
            'portfolio_companies',
            org,
            { in: { domain: domains } },
            { limit: 20 },
          )) as PortfolioCompany[])
        : [],
    ),
    settle(
      'network',
      [] as NetworkContact[],
      async () =>
        (await store.list(
          'network_contacts',
          org,
          { in: { email: emails } },
          { limit: 50 },
        )) as NetworkContact[],
    ),
    settle('lp lists', new Set<string>(), async () => lpKeysFor(store, org, emails, domains)),
    settle('earlier meetings', [] as MeetingCrmContext['earlier'], async () =>
      earlierMeetings(ctx, meeting, emails),
    ),
  ]);
  return {
    deals: deals
      .filter((d) => d.domain)
      .map((d) => ({
        company: d.company_name,
        domain: (d.domain as string).toLowerCase(),
        stage: d.stage,
      })),
    portfolio: portfolio
      .filter((p) => p.domain && !p.is_archived)
      .map((p) => ({
        name: p.name,
        domain: (p.domain as string).toLowerCase(),
        stage: p.current_stage,
      })),
    lpKeys,
    contacts: contacts
      .filter((c): c is NetworkContact & { email: string } => Boolean(c.email))
      .map((c) => ({
        name: c.full_name,
        email: c.email.toLowerCase(),
        title: c.title,
        company: c.company,
        relationship: c.relationship,
      })),
    earlier,
  };
}

/** Guest emails and domains that sit on a CRM list whose name reads as an LP list. */
async function lpKeysFor(
  store: DataStore,
  org: string,
  emails: string[],
  domains: string[],
): Promise<Set<string>> {
  const records = [
    ...((await store.list(
      'crm_records',
      org,
      { arrayOverlaps: { emails } },
      { limit: 50 },
    )) as CrmRecord[]),
    ...(domains.length
      ? ((await store.list(
          'crm_records',
          org,
          { in: { domain: domains } },
          { limit: 50 },
        )) as CrmRecord[])
      : []),
  ];
  if (records.length === 0) return new Set();
  const lists = ((await store.list('crm_lists', org, {}, { limit: 200 })) as CrmList[]).filter(
    isLpList,
  );
  if (lists.length === 0) return new Set();
  const entries: CrmListEntry[] = [];
  for (const part of chunk([...new Set(records.map((r) => r.id))], 100)) {
    entries.push(
      ...((await store.list('crm_list_entries', org, {
        in: { record_id: part, list_id: lists.map((l) => l.id) },
      })) as CrmListEntry[]),
    );
  }
  const onLp = new Set(entries.map((e) => e.record_id));
  const keys = new Set<string>();
  for (const r of records) {
    if (!onLp.has(r.id)) continue;
    for (const e of r.emails) if (emails.includes(e.toLowerCase())) keys.add(e.toLowerCase());
    if (r.domain && domains.includes(r.domain.toLowerCase())) keys.add(r.domain.toLowerCase());
  }
  return keys;
}

/**
 * Up to three earlier meetings with any of these guests, newest first:
 * Granola notes (team-visible) and Kraken notes the reader may see.
 */
async function earlierMeetings(
  ctx: NotesContext,
  meeting: Pick<Meeting, 'id' | 'started_at' | 'scheduled_start' | 'created_at'>,
  emails: string[],
): Promise<MeetingCrmContext['earlier']> {
  const before = meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at;
  const want = new Set(emails);
  const notes = (await ctx.store.list(
    'meeting_notes',
    ctx.auth.organizationId,
    { lt: { occurred_at: before } },
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 300 },
  )) as MeetingNote[];
  return notes
    .filter((n) => n.external_id !== meeting.id && isTeamVisibleNote(n, ctx.auth.userId))
    .filter((n) => n.attendees.some((a) => want.has(a.email.toLowerCase())))
    .slice(0, 3)
    .map((n) => ({
      title: n.title,
      date: n.occurred_at.slice(0, 10),
      source: n.provider,
      excerpt: n.content.length > EXCERPT ? `${n.content.slice(0, EXCERPT - 1)}…` : n.content,
    }));
}

/** The template a meeting's notes use when nobody picked one. */
export async function autoTemplateFor(
  ctx: NotesContext,
  meeting: Pick<Meeting, 'title' | 'kind'>,
  participants: readonly Pick<MeetingParticipant, 'email' | 'role'>[],
  team: TeamInfo,
  crm: MeetingCrmContext,
): Promise<TemplatePick> {
  const custom = await settle(
    'templates',
    [] as NoteTemplate[],
    async () =>
      (await ctx.store.list('note_templates', ctx.auth.organizationId, {
        eq: { archived: false },
      })) as NoteTemplate[],
  );
  const external = externalEmailsOf(participants, team);
  const others = participants.filter((p) => p.role !== 'self');
  return pickTemplate({
    title: meeting.title,
    externalEmails: external,
    internalOnly: external.length === 0 && others.length > 0,
    dealDomains: new Set(crm.deals.map((d) => d.domain)),
    portfolioDomains: new Set(crm.portfolio.map((p) => p.domain)),
    lpKeys: crm.lpKeys,
    customTemplates: custom,
  });
}
