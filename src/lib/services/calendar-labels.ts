import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { labelNameMatches, labelText, legendLabels } from '@/lib/calendar/labels';
import { NICK_ALIASES } from '@/lib/calendar/meetings';
import {
  suggestLabel,
  type LabelKnowledge,
  type LabelSuggestion,
} from '@/lib/calendar/label-suggest';
import {
  calendarSource,
  primaryCalendar,
  readCalendarList,
  readCalendarRange,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import type { CalendarInfo, EventLabel, RangeEvent } from '@/lib/calendar/range-types';
import { log } from '@/lib/security/redact';
import type {
  CalendarEvent,
  Deal,
  DealPerson,
  EmailMessage,
  NetworkContact,
  PortfolioCompany,
  PortfolioContact,
} from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { readFollowUps } from './follow-ups';

/**
 * Google Calendar's colour labels, where Copilot uses them beyond drawing:
 *
 * - The suggested label on an event's card (lib/calendar/label-suggest.ts):
 *   what Copilot already knows about the people on it (portfolio companies,
 *   deals in the pipeline and their founders, Fund II's LPs, other VC
 *   firms, the team), gathered here read-only and kept for a few minutes.
 * - Ask Arwin's calendar tool: each event's label name, and a filter by it.
 * - Diagnostics › Event labels: each calendar's labels and how many events
 *   in the next week carry each one, read-only.
 *
 * Nothing here writes anything, to Google or to the store.
 */

const KNOWLEDGE_TTL_MS = 5 * 60_000;

const knowledgeCache = processWide(
  'calendar-label-knowledge',
  () => new Map<string, { at: number; value: LabelKnowledge }>(),
);

/** Test hook. */
export function resetLabelKnowledgeCache(): void {
  knowledgeCache.clear();
}

const domainOf = (email: string) => email.toLowerCase().split('@')[1] ?? '';
const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `https://www.example.com/x` or `example.com` as `example.com`. */
function domainFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

const VC_FIRM = /\b(ventures?|capital|vc|partners)\b/i;
const VC_RELATIONSHIP = /\b(co-?investor|vc|venture|investor)\b/i;
const LP_RELATIONSHIP = /\b(lps?|limited partner|investor relations)\b/i;
const VC_DOMAIN = /(^|\.)([a-z0-9-]*(ventures|vc)[a-z0-9-]*\.[a-z.]+|[a-z0-9-]+\.vc)$/i;

async function safeList<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch {
    log.warn('Label knowledge source failed', { source: label });
    return [];
  }
}

/** What Copilot knows about people, for a suggested label. Read-only, cached for minutes. */
export async function labelKnowledge(
  store: DataStore,
  organizationId: string,
  ownEmails: readonly string[],
  now = Date.now(),
): Promise<LabelKnowledge> {
  const key = `${organizationId}|${[...ownEmails].sort().join(',')}`;
  const hit = knowledgeCache.get(key);
  if (hit && now - hit.at < KNOWLEDGE_TTL_MS) return hit.value;

  const [companies, contacts, deals, people, emails, network, followUps] = await Promise.all([
    safeList(
      'portfolio',
      () =>
        store.list('portfolio_companies', organizationId, {
          eq: { is_archived: false },
        }) as Promise<PortfolioCompany[]>,
    ),
    safeList(
      'portfolio contacts',
      () => store.list('portfolio_contacts', organizationId, {}) as Promise<PortfolioContact[]>,
    ),
    safeList(
      'deals',
      () => store.list('deals', organizationId, { eq: { is_archived: false } }) as Promise<Deal[]>,
    ),
    safeList(
      'deal people',
      () => store.list('deal_people', organizationId, {}) as Promise<DealPerson[]>,
    ),
    safeList(
      'emails',
      () =>
        store.list(
          'email_messages',
          organizationId,
          { in: { category: ['lp_or_advisor', 'co_investor'] } },
          { limit: 500, orderBy: [{ field: 'sent_at', direction: 'desc' }] },
        ) as Promise<EmailMessage[]>,
    ),
    safeList(
      'network',
      () => store.list('network_contacts', organizationId, {}) as Promise<NetworkContact[]>,
    ),
    readFollowUps(store, organizationId).catch(() => null),
  ]);

  const ownDomains = [...new Set([...ownEmails, ...NICK_ALIASES].map(domainOf))].filter(
    (d) => d && !/^(gmail|googlemail|outlook|hotmail|yahoo|icloud)\./.test(d),
  );

  const portfolioEmails = new Map<string, string>();
  const portfolioDomains = new Map<string, string>();
  const companyById = new Map(companies.map((c) => [c.id, c.name]));
  for (const c of companies) {
    for (const d of [domainFrom(c.domain), domainFrom(c.website)]) {
      if (d) portfolioDomains.set(d, c.name);
    }
  }
  for (const p of contacts) {
    const company = companyById.get(p.portfolio_company_id);
    if (p.email && company) portfolioEmails.set(p.email.toLowerCase(), company);
  }

  // In the pipeline: not passed on, not already a portfolio company.
  const live = deals.filter((d) => d.stage !== 'passed' && d.stage !== 'invested');
  const dealById = new Map(live.map((d) => [d.id, d]));
  const dealEmails = new Map<string, { name: string; stage: string }>();
  const dealDomains = new Map<string, { name: string; stage: string }>();
  for (const d of live) {
    for (const domain of [domainFrom(d.domain), domainFrom(d.website)]) {
      if (domain && !portfolioDomains.has(domain)) {
        dealDomains.set(domain, { name: d.company_name, stage: d.stage });
      }
    }
  }
  for (const p of people) {
    const deal = dealById.get(p.deal_id);
    if (p.email && deal) {
      dealEmails.set(p.email.toLowerCase(), { name: deal.company_name, stage: deal.stage });
    }
  }

  const lpEmails = new Set<string>();
  const vcEmails = new Map<string, string>();
  const vcDomains = new Map<string, string>();
  for (const m of emails) {
    const address = m.from_address.toLowerCase();
    if (m.category === 'lp_or_advisor') lpEmails.add(address);
    if (m.category === 'co_investor') vcEmails.set(address, m.from_name ?? domainOf(address));
  }
  for (const c of network) {
    const email = c.email?.toLowerCase();
    if (!email) continue;
    const relationship = c.relationship ?? '';
    if (LP_RELATIONSHIP.test(relationship)) {
      lpEmails.add(email);
    } else if (VC_RELATIONSHIP.test(relationship) || VC_FIRM.test(c.company ?? '')) {
      const firm = c.company?.trim() || domainOf(email);
      vcEmails.set(email, firm);
      const domain = domainOf(email);
      if (domain && !ownDomains.includes(domain)) vcDomains.set(domain, firm);
    }
  }
  const lps = followUps?.state === 'ok' ? (followUps.snapshot.lpPipeline?.lps ?? []) : [];
  const lpNames = new Set(lps.map((l) => l.who.trim().toLowerCase()));
  const lpFirms = new Set(
    lps.map((l) => (l.firm ? lettersOnly(l.firm) : '')).filter((f) => f.length >= 4),
  );
  // A VC-looking domain, unless Copilot knows its people as something else.
  for (const address of [...vcEmails.keys()]) {
    const domain = domainOf(address);
    if (VC_DOMAIN.test(domain) && !vcDomains.has(domain)) vcDomains.set(domain, domain);
  }

  const value: LabelKnowledge = {
    ownDomains,
    portfolioEmails,
    portfolioDomains,
    dealEmails,
    dealDomains,
    lpEmails,
    lpNames,
    lpFirms,
    vcEmails,
    vcDomains,
  };
  knowledgeCache.set(key, { at: now, value });
  return value;
}

/** The suggested label for one event, or null (see lib/calendar/label-suggest.ts). */
export async function suggestedLabelFor(
  store: DataStore,
  organizationId: string,
  event: RangeEvent,
  labels: readonly EventLabel[],
  ownEmails: readonly string[],
): Promise<LabelSuggestion | null> {
  if (event.labelId || labels.length === 0) return null;
  const knowledge = await labelKnowledge(store, organizationId, ownEmails);
  return suggestLabel(event, labels, knowledge, ownEmails);
}

/* ------------------------------------------------------- Ask's calendar tool */

export interface AskCalendarEvent {
  event: CalendarEvent;
  /** The event's colour label on Google Calendar, by name (null when it has none). */
  label: string | null;
}

export interface AskCalendarEvents {
  events: AskCalendarEvent[];
  /** The main calendar's labels by name, so the answer can name the right one. */
  labels: string[];
  /** False when the labels could not be read live (the events still list). */
  labelsRead: boolean;
}

const NO_LABEL = /^(none|no label|unlabel(l)?ed|without (a )?label)$/i;

/**
 * Ask Arwin's calendar tool: the synced events of the main calendar in a
 * window, each with its colour label's name read live from Google Calendar
 * (the same read the Calendar tab makes), and only those with a given label
 * when one is named ("Portcos", "no label"). Read-only.
 */
export async function listEventsWithLabels(
  store: DataStore,
  organizationId: string,
  options: {
    window: { start: Date; end: Date };
    timeZone: string;
    ownEmail: string;
    label?: string | null;
    /** Tests: read labels from this source instead of the runtime's. */
    source?: CalendarSource;
  },
): Promise<AskCalendarEvents> {
  const events = (await store.list(
    'calendar_events',
    organizationId,
    {
      gte: { starts_at: options.window.start.toISOString() },
      lt: { starts_at: options.window.end.toISOString() },
    },
    { orderBy: [{ field: 'starts_at', direction: 'asc' }] },
  )) as CalendarEvent[];

  const byId = new Map<string, RangeEvent>();
  let labels: string[] = [];
  let labelsRead = false;
  try {
    let source = options.source;
    if (!source) {
      const found = await calendarSource(store, organizationId, options.ownEmail);
      source = found.ok ? found.source : undefined;
    }
    if (source) {
      const from = localDateKey(options.window.start, options.timeZone);
      const to = addDaysToKey(
        localDateKey(new Date(options.window.end.getTime() - 1), options.timeZone),
        1,
      );
      const list = await readCalendarList(source, organizationId);
      const main = list.ok ? primaryCalendar(list.value.calendars) : null;
      if (main) {
        const read = await readCalendarRange(store, organizationId, {
          from,
          to,
          timeZone: options.timeZone,
          ownEmail: options.ownEmail,
          calendarIds: [main.id],
          source,
        });
        if (read.state === 'ok' && read.loaded.includes(main.id)) {
          labelsRead = true;
          for (const e of read.events) byId.set(e.id, e);
          const calendar = read.calendars.find((c) => c.id === main.id);
          labels = calendar ? legendLabels([calendar], [calendar.id]).map((l) => l.name) : [];
        }
      }
    }
  } catch (error) {
    log.warn('Calendar labels for Ask could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const withLabels = events.map((event) => {
    const live = byId.get(event.provider_event_id);
    return { event, label: live?.label ? labelText(live.label) : null };
  });
  const asked = options.label?.trim();
  const filtered = !asked
    ? withLabels
    : NO_LABEL.test(asked)
      ? withLabels.filter((e) => e.label === null)
      : withLabels.filter((e) => labelNameMatches(e.label, asked));
  return { events: filtered, labels, labelsRead };
}

/* ----------------------------------------------------------- Diagnostics */

export interface LabelReportCalendar {
  id: string;
  name: string;
  primary: boolean;
  /** The calendar's events could be read for the week. */
  read: boolean;
  labels: { label: EventLabel; count: number }[];
  unlabelled: number;
  /** Events pointing at a label the calendar no longer defines. */
  unknown: number;
}

export interface LabelReport {
  state: 'ok' | 'not_connected' | 'error';
  message?: string;
  from: string;
  to: string;
  calendars: LabelReportCalendar[];
}

/**
 * Diagnostics › Event labels: every calendar on the list (hidden ones left
 * out), its labels as Google has them, and how many events in the next seven
 * days carry each. One read per calendar; nothing is changed.
 */
export async function labelReport(
  store: DataStore,
  organizationId: string,
  options: { timeZone: string; ownEmail: string; now?: Date; source?: CalendarSource },
): Promise<LabelReport> {
  const from = localDateKey(options.now ?? new Date(), options.timeZone);
  const to = addDaysToKey(from, 7);
  const base = { from, to, calendars: [] as LabelReportCalendar[] };
  let source = options.source;
  if (!source) {
    const found = await calendarSource(store, organizationId, options.ownEmail);
    if (!found.ok) return { state: 'not_connected', ...base };
    source = found.source;
  }
  const list = await readCalendarList(source, organizationId);
  if (!list.ok) return { state: 'error', message: list.error.message, ...base };
  const data = await readCalendarRange(store, organizationId, {
    from,
    to,
    timeZone: options.timeZone,
    ownEmail: options.ownEmail,
    calendarIds: list.value.calendars.map((c) => c.id),
    source,
  });
  if (data.state !== 'ok') return { state: data.state, message: data.message, ...base };
  const calendars = data.calendars.map((c: CalendarInfo): LabelReportCalendar => {
    const events = data.events.filter((e) => e.calendarId === c.id);
    return {
      id: c.id,
      name: c.name,
      primary: c.primary,
      read: data.loaded.includes(c.id),
      labels: c.labels.map((label) => ({
        label,
        count: events.filter((e) => e.label?.id === label.id).length,
      })),
      unlabelled: events.filter((e) => !e.labelId).length,
      unknown: events.filter((e) => e.labelId && !e.label).length,
    };
  });
  return { state: 'ok', ...base, calendars };
}
