import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import { scanForInjection } from '@/lib/security/injection';
import { err, ok, type Result } from '@/lib/util/result';
import type { Deal, MeetingNote, PortfolioCompany } from '@/lib/types/domain';

/**
 * Meeting notes from Granola.
 *
 * Granola's Zapier trigger fires when a note lands in a watched folder and
 * POSTs whatever field mapping the Zap defines. The shape below is *ours*:
 * the Zap is configured to map Granola's fields onto these names, which keeps
 * this endpoint independent of Zapier's own payload conventions — a Zapier
 * rename cannot silently break ingestion, only an explicit Zap edit can.
 *
 * Everything is stored verbatim and linked to nothing at write time. The
 * associations a reader sees — this note belongs to that deal, that company,
 * those people — are derived from attendee addresses when the page renders,
 * against records that exist. A wrong guess therefore cannot be persisted,
 * and deleting a deal never strands a pointer.
 */

export const GRANOLA_NOTE_SCHEMA = z.object({
  /** Granola's note id. Zapier retries deliveries; ingestion upserts on this. */
  external_id: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(500),
  /** ISO timestamp of the meeting, from the calendar event Granola attaches. */
  occurred_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'occurred_at must be an ISO date-time',
  }),
  /**
   * Zapier flattens arrays into comma-joined strings depending on how the Zap
   * is built, so both shapes are accepted and normalised.
   */
  attendee_emails: z.union([z.array(z.string()), z.string()]).default([]),
  attendee_names: z.union([z.array(z.string()), z.string()]).default([]),
  content: z.string().min(1).max(200_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type GranolaNotePayload = z.infer<typeof GRANOLA_NOTE_SCHEMA>;

function asList(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Pairs names with emails by position; unmatched names are dropped, not guessed. */
export function normaliseAttendees(
  emails: string[] | string,
  names: string[] | string,
): { name: string | null; email: string }[] {
  const emailList = asList(emails);
  const nameList = asList(names);

  const seen = new Set<string>();
  const attendees: { name: string | null; email: string }[] = [];

  for (let i = 0; i < emailList.length; i++) {
    const email = emailList[i]!.toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    const name = nameList[i]?.trim();
    attendees.push({ name: name && !name.includes('@') ? name : null, email });
  }

  return attendees;
}

export async function ingestGranolaNote(
  store: DataStore,
  organizationId: string,
  payload: GranolaNotePayload,
  now: Date = new Date(),
): Promise<Result<{ id: string; created: boolean; flagged: boolean }>> {
  const attendees = normaliseAttendees(payload.attendee_emails, payload.attendee_names);

  // Notes are prose someone else controls the content of, which makes them the
  // same class of input as email bodies: scan, annotate, never hide.
  const scan = scanForInjection(`${payload.title}\n${payload.content}`);

  const existing = (await store.findOne('meeting_notes', organizationId, {
    eq: { provider: 'granola', external_id: payload.external_id },
  })) as MeetingNote | null;

  if (existing) {
    // Granola notes keep being edited after the meeting, so a redelivery with
    // newer content updates in place rather than being dropped as a duplicate.
    const updated = await store.update('meeting_notes', organizationId, existing.id, {
      title: payload.title,
      occurred_at: new Date(payload.occurred_at).toISOString(),
      attendees,
      content: payload.content,
      source_url: payload.source_url ?? null,
      injection_flagged: scan.flagged,
      updated_at: now.toISOString(),
    } as Partial<MeetingNote>);
    if (!updated) return err('internal', 'The existing note could not be updated.');
    return ok({ id: existing.id, created: false, flagged: scan.flagged });
  }

  const note: MeetingNote = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    provider: 'granola',
    external_id: payload.external_id,
    title: payload.title,
    occurred_at: new Date(payload.occurred_at).toISOString(),
    attendees,
    content: payload.content,
    source_url: payload.source_url ?? null,
    injection_flagged: scan.flagged,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  await store.insert('meeting_notes', note);
  return ok({ id: note.id, created: true, flagged: scan.flagged });
}

/* ------------------------------------------------------- read-time linking */

const NOTE_LIMIT = 200;

async function recentNotes(store: DataStore, organizationId: string): Promise<MeetingNote[]> {
  return (await store.list(
    'meeting_notes',
    organizationId,
    {},
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: NOTE_LIMIT },
  )) as MeetingNote[];
}

function attendeeDomains(note: MeetingNote): Set<string> {
  const domains = new Set<string>();
  for (const attendee of note.attendees) {
    const at = attendee.email.lastIndexOf('@');
    if (at > 0) domains.add(attendee.email.slice(at + 1).toLowerCase());
  }
  return domains;
}

/**
 * Notes for one deal: any note with an attendee at the deal's domain, or at
 * the address of a person already recorded on the deal. The same rule the
 * Inbox uses to link email — domain matching against a record that exists is
 * a lookup, not an inference.
 */
export async function notesForDeal(
  store: DataStore,
  organizationId: string,
  deal: Pick<Deal, 'id' | 'domain'>,
  peopleEmails: string[],
): Promise<MeetingNote[]> {
  const notes = await recentNotes(store, organizationId);
  const domain = deal.domain?.toLowerCase() ?? null;
  const people = new Set(peopleEmails.map((e) => e.toLowerCase()));

  return notes.filter((note) => {
    if (domain && attendeeDomains(note).has(domain)) return true;
    return note.attendees.some((a) => people.has(a.email.toLowerCase()));
  });
}

/** Notes for one portfolio company, by its domain and recorded contacts. */
export async function notesForCompany(
  store: DataStore,
  organizationId: string,
  company: Pick<PortfolioCompany, 'id' | 'domain'>,
  contactEmails: string[],
): Promise<MeetingNote[]> {
  const notes = await recentNotes(store, organizationId);
  const domain = company.domain?.toLowerCase() ?? null;
  const contacts = new Set(contactEmails.map((e) => e.toLowerCase()));

  return notes.filter((note) => {
    if (domain && attendeeDomains(note).has(domain)) return true;
    return note.attendees.some((a) => contacts.has(a.email.toLowerCase()));
  });
}

/** Note counts per attendee address, for the relationship list. */
export async function noteCountsByEmail(
  store: DataStore,
  organizationId: string,
): Promise<Map<string, number>> {
  const notes = await recentNotes(store, organizationId);
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const attendee of note.attendees) {
      const email = attendee.email.toLowerCase();
      counts.set(email, (counts.get(email) ?? 0) + 1);
    }
  }
  return counts;
}
