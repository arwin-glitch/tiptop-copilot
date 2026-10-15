import 'server-only';
import { NO_COUNTS, type AffinityCounts } from '@/lib/crm/affinity-csv';
import {
  partyKey,
  partyKeys,
  partyLabel,
  recordIntroKeys,
  type AffinityIntroductionPayload,
  type AffinityIntroductionsImportResult,
  type AffinityIntroductionsRequest,
  type IntroParty,
  type IntroductionSection,
} from '@/lib/crm/affinity-introductions';
import { ownAddressesFor } from '@/lib/crm/contact-evidence';
import { isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { AuditEvent, CrmRecord } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Introductions from Affinity, kept as `audit_events` sidecar rows (action
 * `crm.introduction`), linked to companies and people when a profile is read.
 *
 * Why this form, and not notes or a table of its own:
 *  - No migration. Like cadences and the email session's answers, the rows
 *    live in a table every deployment already has, so the import cannot run
 *    ahead of a hand-applied migration (the Sep 15 outage).
 *  - An introduction is a fact about two or three people, not text about one
 *    record, so a note would show up as prose on one profile and nowhere else.
 *  - Linked at read time, not import time. Each introduction is written once
 *    per party it names — `entity_id` is that party's key (`email:…`,
 *    `domain:…`, or a name when the export gives nothing better) and the
 *    metadata the whole introduction — so a profile finds its introductions
 *    with one indexed read of its own keys, and a company or person imported
 *    after the introductions still finds theirs.
 *  - Idempotent. Row ids are derived from the introduction's identity and the
 *    party key, so importing a file again, or the same introduction from a
 *    second list's export, adds nothing.
 *
 * The fund's own addresses are never a key (they would put every introduction
 * on one profile) but stay in the introduction, so it still reads "… with Nick".
 */

export const INTRODUCTION_ACTION = 'crm.introduction';

type Role = 'introducer' | 'introduced';

interface StoredIntroduction {
  v: 1;
  intro: string;
  role: Role;
  section: IntroductionSection;
  date: string | null;
  evidence: 'email' | 'chat' | null;
  introducer: IntroParty;
  introduced: IntroParty[];
}

/** A uuid-shaped id fixed by its parts, so the same row is never written twice. */
function rowId(organizationId: string, intro: string, role: Role, key: string): string {
  const h = sha256(`${organizationId}|${intro}|${role}|${key}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function clean(party: IntroParty): IntroParty {
  const out: IntroParty = {
    kind: party.kind,
    name: party.name?.trim() || null,
    email: party.kind === 'person' ? party.email?.trim().toLowerCase() || null : null,
    domain: party.kind === 'company' ? party.domain?.trim().toLowerCase() || null : null,
  };
  if (party.organization && (party.organization.name || party.organization.domain)) {
    out.organization = {
      name: party.organization.name?.trim() || null,
      domain: party.organization.domain?.trim().toLowerCase() || null,
    };
  }
  return out;
}

/** The sidecar rows for one introduction: one per (role, key), the fund's own addresses left out. */
export function introductionRows(
  organizationId: string,
  intro: AffinityIntroductionPayload,
  ownAddresses: ReadonlySet<string>,
  createdAt: string,
): AuditEvent[] {
  const introducer = clean(intro.introducer);
  const introduced = intro.introduced.map(clean);
  const meta = {
    v: 1,
    intro: intro.externalId,
    section: intro.section,
    date: intro.date ?? null,
    evidence: intro.evidence ?? null,
    introducer,
    introduced,
  } satisfies Omit<StoredIntroduction, 'role'>;
  const seen = new Set<string>();
  const rows: AuditEvent[] = [];
  const add = (party: IntroParty, role: Role) => {
    for (const key of partyKeys(party)) {
      if (key.startsWith('email:') && ownAddresses.has(key.slice(6))) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: rowId(organizationId, intro.externalId, role, key),
        organization_id: organizationId,
        user_id: null,
        action: INTRODUCTION_ACTION,
        entity_type: 'crm_introduction',
        entity_id: key,
        // Written directly, not through recordAudit: names and addresses are
        // the introduction itself and must come back as they were exported.
        metadata: { ...meta, role },
        ip_hash: null,
        created_at: createdAt,
      });
    }
  };
  add(introducer, 'introducer');
  for (const party of introduced) add(party, 'introduced');
  return rows;
}

/** Which of `keys` belong to a company or person in Copilot. Empty when the CRM is not set up. */
async function keysWithRecords(
  store: DataStore,
  organizationId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const emails: string[] = [];
  const domains: string[] = [];
  const people: string[] = [];
  const companies: string[] = [];
  for (const key of new Set(keys)) {
    const [kind, ...rest] = key.split(':');
    const value = rest.join(':');
    if (kind === 'email') emails.push(value);
    else if (kind === 'domain') domains.push(value);
    else if (kind === 'person') people.push(value);
    else if (kind === 'company') companies.push(value);
  }
  try {
    for (const group of chunk(emails, 100)) {
      for (const r of (await listAllPages(store, 'crm_records', organizationId, {
        arrayOverlaps: { emails: group },
      })) as CrmRecord[]) {
        for (const e of r.emails) if (group.includes(e)) out.set(`email:${e}`, r.id);
      }
    }
    for (const group of chunk(domains, 100)) {
      for (const r of (await listAllPages(store, 'crm_records', organizationId, {
        eq: { kind: 'company' },
        in: { domain: group },
      })) as CrmRecord[]) {
        if (r.domain) out.set(`domain:${r.domain}`, r.id);
      }
    }
    for (const [kind, names] of [
      ['person', people],
      ['company', companies],
    ] as const) {
      for (const group of chunk(names, 100)) {
        const rows = (await listAllPages(store, 'crm_records', organizationId, {
          eq: { kind },
          in: { name_key: group },
        })) as CrmRecord[];
        // A name two records share links to neither.
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.name_key, (counts.get(r.name_key) ?? 0) + 1);
        for (const r of rows) {
          if (counts.get(r.name_key) === 1) out.set(`${kind}:${r.name_key}`, r.id);
        }
      }
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Introductions could not be matched to records', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/**
 * Import one chunk of an introductions export. Every row is an idempotent
 * insert keyed by its derived id; an introduction is "added" when none of its
 * rows existed, "updated" when it gained some (a second list's export naming
 * the organization a person works at), and "already up to date" otherwise.
 */
export async function importAffinityIntroductions(
  store: DataStore,
  organizationId: string,
  request: AffinityIntroductionsRequest,
  actor?: { userId: string | null },
): Promise<Result<AffinityIntroductionsImportResult>> {
  try {
    const own = new Set(await ownAddressesFor(store, organizationId));
    const createdAt = new Date().toISOString();
    const perIntro = request.introductions.map((intro) =>
      introductionRows(organizationId, intro, own, createdAt),
    );
    const allIds = perIntro.flat().map((r) => r.id);
    const existing = new Set<string>();
    for (const group of chunk([...new Set(allIds)], 100)) {
      for (const row of await store.list('audit_events', organizationId, {
        eq: { action: INTRODUCTION_ACTION },
        in: { id: group },
      })) {
        existing.add(row.id);
      }
    }

    const counts: AffinityCounts = { ...NO_COUNTS };
    const problems: { row: number; message: string }[] = [];
    const fresh: AuditEvent[] = [];
    const written = new Set<string>();
    perIntro.forEach((rows, i) => {
      if (!rows.length) {
        counts.skipped++;
        problems.push({
          row: i,
          message:
            'Everyone in this introduction is the fund itself, so there is no profile to show it on.',
        });
        return;
      }
      const added = rows.filter((r) => !existing.has(r.id) && !written.has(r.id));
      for (const r of added) written.add(r.id);
      fresh.push(...added);
      if (added.length === rows.length) counts.inserted++;
      else if (added.length) counts.updated++;
      else counts.unchanged++;
    });
    for (const group of chunk(fresh, 500)) await store.insertMany('audit_events', group);

    const recordKeys = await keysWithRecords(
      store,
      organizationId,
      perIntro.flat().map((r) => r.entity_id as string),
    );
    const linked = perIntro.filter((rows) =>
      rows.some((r) => recordKeys.has(r.entity_id as string)),
    ).length;

    await recordAudit(store, {
      organizationId,
      userId: actor?.userId ?? null,
      action: 'crm.imported',
      entityType: 'crm_introduction',
      entityId: null,
      metadata: {
        kind: 'introductions',
        source: 'affinity',
        rows: request.introductions.length,
        linked,
        introductions_inserted: counts.inserted,
        introductions_updated: counts.updated,
        introductions_unchanged: counts.unchanged,
        introductions_skipped: counts.skipped,
      },
    });
    return ok({ introductions: counts, linked, problems });
  } catch (error) {
    log.error('Introductions import failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'The introductions could not be saved just now. Try again.', {
      retryable: true,
    });
  }
}

/* ------------------------------------------------------------------ reads */

/** One introduction as a profile shows it. */
export interface IntroductionLine {
  intro: string;
  date: string | null;
  evidence: 'email' | 'chat' | null;
  /** Introduced by: who made it. Introduced: who they brought in. */
  party: IntroParty;
  /** The profile of `party`, when Copilot has one. */
  partyRecordId: string | null;
  /** Anyone else in it ("with …"). */
  others: IntroParty[];
}

export interface RecordIntroductions {
  introducedBy: IntroductionLine[];
  introduced: IntroductionLine[];
}

function storedOf(row: AuditEvent): StoredIntroduction | null {
  const m = row.metadata as Partial<StoredIntroduction>;
  if (typeof m.intro !== 'string' || !m.introducer || !Array.isArray(m.introduced)) return null;
  if (m.role !== 'introducer' && m.role !== 'introduced') return null;
  return m as StoredIntroduction;
}

/** Newest first, undated last, then by name. One line per party and date, a dated one over an undated twin. */
function tidyLines(lines: IntroductionLine[]): IntroductionLine[] {
  const sorted = [...lines].sort((a, b) =>
    a.date === b.date
      ? partyLabel(a.party).localeCompare(partyLabel(b.party))
      : a.date === null
        ? 1
        : b.date === null
          ? -1
          : a.date < b.date
            ? 1
            : -1,
  );
  const out: IntroductionLine[] = [];
  const seen = new Set<string>();
  const dated = new Set<string>();
  for (const line of sorted) {
    const who = partyKey(line.party) ?? line.intro;
    const key = `${who}|${line.date ?? ''}`;
    if (seen.has(key)) continue;
    // The same introduction recorded as a hand-set source, without a date.
    if (line.date === null && dated.has(who)) continue;
    seen.add(key);
    if (line.date) dated.add(who);
    out.push(line);
  }
  return out;
}

/** A company's or person's introductions: who introduced them, and whom they introduced. */
export async function introductionsForRecord(
  store: DataStore,
  organizationId: string,
  record: Pick<CrmRecord, 'id' | 'kind' | 'name' | 'emails' | 'domain'>,
  options: { limit?: number } = {},
): Promise<Result<RecordIntroductions>> {
  try {
    const keys = recordIntroKeys(record);
    const rows = (await store.list(
      'audit_events',
      organizationId,
      { eq: { action: INTRODUCTION_ACTION }, in: { entity_id: keys } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: options.limit ?? 500 },
    )) as AuditEvent[];

    // One introduction can match a record by several keys (a person's two
    // addresses, or a company's domain and a person exported under it).
    const byIntro = new Map<string, { stored: StoredIntroduction; roles: Set<Role> }>();
    for (const row of rows) {
      const stored = storedOf(row);
      if (!stored) continue;
      const hit = byIntro.get(stored.intro) ?? { stored, roles: new Set<Role>() };
      hit.roles.add(stored.role);
      byIntro.set(stored.intro, hit);
    }

    // "With" leaves out the record itself, but keeps a colleague: on a
    // company's profile, the person there who was introduced is the point.
    const mine = new Set(keys);
    const isMe = (p: IntroParty) => mine.has(partyKey(p) ?? '');
    const introducedBy: IntroductionLine[] = [];
    const introduced: IntroductionLine[] = [];
    for (const { stored, roles } of byIntro.values()) {
      const base = { intro: stored.intro, date: stored.date, evidence: stored.evidence };
      if (roles.has('introducer')) {
        const [party, ...others] = stored.introduced;
        if (!party) continue;
        introduced.push({ ...base, party, partyRecordId: null, others });
      } else {
        const others = stored.introduced.filter((p) => !isMe(p));
        introducedBy.push({ ...base, party: stored.introducer, partyRecordId: null, others });
      }
    }

    const lines = [...introducedBy, ...introduced];
    const links = await keysWithRecords(
      store,
      organizationId,
      lines.map((l) => partyKey(l.party)).filter((k): k is string => Boolean(k)),
    );
    for (const line of lines) {
      const key = partyKey(line.party);
      const id = key ? (links.get(key) ?? null) : null;
      line.partyRecordId = id && id !== record.id ? id : null;
    }
    return ok({ introducedBy: tidyLines(introducedBy), introduced: tidyLines(introduced) });
  } catch (error) {
    log.error('Introductions read failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'Introductions could not be read just now.', { retryable: true });
  }
}
