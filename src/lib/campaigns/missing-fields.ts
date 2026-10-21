import type { CampaignMerge } from '@/lib/types/domain';
import { MERGE_FIELDS, mergeValue, type MergeField } from './template';

/**
 * Who is missing a merge field, and filling it in from the review.
 *
 * Pure and shared: the server lists the people (reviewCampaign) and applies a
 * fill (fillRecipientMerge); the review screen groups the people under each
 * "N people have no …" line. A filled value lands in that recipient's own
 * `merge` for the campaign, which the preview, the counts and the send all
 * read already, so nothing about how an email is put together changes. Anyone
 * left empty still gets the fallback.
 */

/** The longest value a merge field takes from a person typing it in. */
export const MAX_MERGE_VALUE = 200;

export type MergeValues = Partial<Record<MergeField, string>>;

/** A person's CRM contact as it reads now: a name that is really an address reads as none. */
export interface ContactValues {
  name: string | null;
  company: string | null;
}

export interface MissingPerson {
  /** The campaign recipient's id. */
  id: string;
  email: string;
  /** Their name, when they have a usable one. */
  name: string | null;
  /** Of first name, full name and company, every one they have no value for: the inputs to show. */
  lacks: MergeField[];
  /** Their CRM contact, when they came from one that still exists; null otherwise. */
  contact: ContactValues | null;
}

/** The fields a CRM contact holds. A first name has no place there: it stays with the campaign. */
export const CONTACT_FIELDS = ['name', 'company'] as const satisfies readonly MergeField[];
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** What a person typed, made safe to keep: one line, no control characters, trimmed and capped. */
export function cleanMergeValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MERGE_VALUE)
    .trim();
}

/** Why typed values cannot be saved, or null when they can. */
export function mergeValuesProblem(values: MergeValues): string | null {
  const cleaned = MERGE_FIELDS.map((field) => [field, cleanMergeValue(values[field])] as const);
  if (!cleaned.some(([, value]) => value)) return 'Type at least one value to save.';
  // An address as a name reads as no name at all (mergeValue), so it would
  // fill nothing and the person would stay on the list.
  if (cleaned.some(([field, value]) => field !== 'company' && value.includes('@'))) {
    return 'A name cannot be an email address.';
  }
  return null;
}

/**
 * Pending recipients who lack at least one of the fields the email uses, in
 * recipient order. `merge` is the recipient's merge as the email reads it
 * (their row's name filled in), so the lists match the counts and the send.
 */
export function peopleMissingFields(
  used: readonly MergeField[],
  recipients: readonly { id: string; email: string; merge: CampaignMerge }[],
): MissingPerson[] {
  if (!used.length) return [];
  const out: MissingPerson[] = [];
  for (const r of recipients) {
    const lacks = MERGE_FIELDS.filter((field) => !mergeValue(field, r.merge));
    if (!lacks.some((field) => used.includes(field))) continue;
    out.push({
      id: r.id,
      email: r.email,
      name: mergeValue('name', r.merge) || null,
      lacks,
      contact: null,
    });
  }
  return out;
}

/** The people under each field's line, in the fields' order; a field nobody lacks has no group. */
export function missingByField(
  fields: readonly MergeField[],
  people: readonly MissingPerson[],
): { field: MergeField; people: MissingPerson[] }[] {
  return fields
    .map((field) => ({ field, people: people.filter((p) => p.lacks.includes(field)) }))
    .filter((group) => group.people.length > 0);
}

/**
 * A recipient's merge with the typed values filled in: only fields they have
 * no value for, so a value already there (one typed in another tab, say) is
 * never replaced. `stored` is the merge column as saved, `effective` the merge
 * as the email reads it. Returns the new merge column and what it filled.
 */
export function fillMerge(
  stored: CampaignMerge,
  effective: CampaignMerge,
  values: MergeValues,
): { merge: CampaignMerge; filled: MergeField[] } {
  const merge: CampaignMerge = { ...stored };
  const filled: MergeField[] = [];
  for (const field of MERGE_FIELDS) {
    const value = cleanMergeValue(values[field]);
    if (!value || mergeValue(field, effective)) continue;
    merge[field] = value;
    filled.push(field);
  }
  return { merge, filled };
}

/**
 * The contact values a save would replace: those it has now that differ from
 * what was typed. The review names them beside "Also save to their contact",
 * so nothing on a contact is replaced without the person seeing it.
 */
export function contactReplacements(
  contact: ContactValues | null,
  values: MergeValues,
): { field: ContactField; from: string }[] {
  if (!contact) return [];
  const out: { field: ContactField; from: string }[] = [];
  for (const field of CONTACT_FIELDS) {
    const typed = cleanMergeValue(values[field]);
    const current = contact[field];
    if (typed && current && current !== typed) out.push({ field, from: current });
  }
  return out;
}
