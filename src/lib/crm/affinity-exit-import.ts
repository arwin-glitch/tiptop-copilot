import { affinityDomain } from '@/lib/crm/affinity-csv';
import {
  affinityPersonName,
  type AffinityApiCompany,
  type AffinityApiPerson,
} from '@/lib/crm/affinity-api';
import type { CrmRecordRow } from '@/lib/services/crm';

/**
 * The two opt-in copies on the Affinity exit checklist, as pure mapping: what
 * the daily sync deliberately leaves in Affinity, brought over only when the
 * owner presses the button (lib/services/affinity-exit-import.ts runs them).
 *
 *   - Contacts on no list: every company (`GET /v2/companies`) and person
 *     (`GET /v2/persons`) in Affinity's directory that Kraken does not have
 *     yet, with minimal fields — name, domain, email addresses — keyed by the
 *     Affinity id, so a second copy changes nothing. Teammates are never
 *     made into contacts.
 *   - Open reminders (`GET /v2/reminders`): one Kraken task each, due when
 *     the reminder is.
 *
 * Shapes are from Affinity's API reference for the version the client pins
 * (2024-01-01): Company { id, name, domain, domains, isGlobal }, Person { id,
 * firstName, lastName, primaryEmailAddress, emailAddresses, type }, and
 * Reminder { id, type, status, content, dueDate, recurrence, company, person,
 * opportunity, … }, each paged by `pagination.nextUrl`. Typed loosely, like
 * lib/crm/affinity-api.ts: a field that is missing degrades to "not stored".
 */

/* ------------------------------------------------------------------ sizes */

/**
 * What one copied contact costs Postgres, generously: the row (two ids, kind,
 * source, Affinity id, name twice, domain, emails, timestamps — about 300
 * bytes) plus its six indexes, the trigram index on the name the largest.
 * A free Supabase database holds 500 MB, so this is what the caps guard.
 */
export const UNLISTED_RECORD_BYTES = 1_200;
/** New contacts one press copies at most (about 6 MB); the next press carries on. */
export const UNLISTED_PER_RUN = 5_000;
/**
 * Companies and people the workspace may hold before the copy refuses to add
 * more (about 60 MB): far above what the lists bring in, and far below what
 * would crowd a free database.
 */
export const CRM_RECORDS_CEILING = 50_000;
/** Tasks one press of "Copy reminders" makes at most. */
export const REMINDERS_PER_RUN = 500;

/** Megabytes `records` contacts take, rounded up, for the page to say before the copy. */
export function estimateMegabytes(records: number): number {
  return Math.max(1, Math.ceil((records * UNLISTED_RECORD_BYTES) / 1_000_000));
}

/* --------------------------------------------------------------- contacts */

/** A directory company as a record row; null when it has no name to show. */
export function unlistedCompanyRow(company: AffinityApiCompany): CrmRecordRow | null {
  if (!company || typeof company.id !== 'number') return null;
  const name = (company.name ?? '').trim();
  if (!name) return null;
  const domain = company.domain ?? company.domains?.find((d) => typeof d === 'string') ?? null;
  return { externalId: String(company.id), name, domain: affinityDomain(domain) };
}

/** A directory person as a record row; null for a teammate or someone with no name or address. */
export function unlistedPersonRow(person: AffinityApiPerson): CrmRecordRow | null {
  if (!person || typeof person.id !== 'number') return null;
  if (person.type === 'internal') return null;
  const emails = (person.emailAddresses ?? []).filter((e): e is string => typeof e === 'string');
  const primary = person.primaryEmailAddress ?? emails[0] ?? null;
  const name = affinityPersonName(person) || null;
  if (!name && !primary) return null;
  return {
    externalId: String(person.id),
    name,
    primaryEmail: primary,
    emails: primary && !emails.includes(primary) ? [primary, ...emails] : emails,
  };
}

/* -------------------------------------------------------------- reminders */

export interface AffinityApiReminder {
  id: number;
  /** `one-time` or `recurring`. */
  type?: string | null;
  /** `active`, `overdue` or `completed` (a recurring reminder is never completed). */
  status?: string | null;
  content?: string | null;
  dueDate?: string | null;
  recurrence?: { resetTrigger?: string | null; periodDays?: number | null } | null;
  company?: { id: number } | null;
  person?: { id: number } | null;
  opportunity?: { id: number } | null;
}

/** Still to do: active or overdue, with an id. */
export function isOpenReminder(reminder: AffinityApiReminder): boolean {
  return (
    Boolean(reminder) &&
    typeof reminder.id === 'number' &&
    (reminder.status === 'active' || reminder.status === 'overdue')
  );
}

const TITLE_MAX = 300;

/** The task one open reminder becomes. `about` is the company or person it is on, by name. */
export function reminderTask(
  reminder: AffinityApiReminder,
  about: string | null,
): { title: string; detail: string; dueAt: string | null } {
  const content = (reminder.content ?? '').replace(/\s+/g, ' ').trim();
  const what = content || (about ? `Follow up with ${about}` : 'Follow up');
  const title = `Affinity reminder: ${what}`;
  const due =
    reminder.dueDate && !Number.isNaN(Date.parse(reminder.dueDate)) ? reminder.dueDate : null;
  const period = reminder.recurrence?.periodDays;
  const detail = [
    about && content ? `About ${about}.` : null,
    !about && reminder.opportunity ? 'On a deal in Affinity.' : null,
    typeof period === 'number' && period > 0
      ? `Repeats every ${period} ${period === 1 ? 'day' : 'days'} in Affinity.`
      : null,
    'Copied from Affinity before it is cancelled.',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
    detail,
    dueAt: due ? new Date(due).toISOString() : null,
  };
}
