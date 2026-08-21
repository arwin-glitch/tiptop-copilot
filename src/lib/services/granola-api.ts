import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { err, ok, type Result } from '@/lib/util/result';
import type { GranolaNotePayload } from '@/lib/services/meetings';

/**
 * Granola's own webhook and public API.
 *
 * The shape of this integration is set by one line in Granola's docs:
 * "Webhook notifications contain no note content, only a reference to the note
 * that changed." So a delivery is a doorbell carrying a note id, and the
 * content arrives on a second call we make ourselves — which is why this needs
 * an API key as well as a signing secret, and why it succeeds where the Slack
 * route could not. A private note is unreadable to a Slack unfurl but perfectly
 * readable to an authorised API request.
 *
 * Both halves are verified: the delivery is authenticated by signature before
 * it is believed, and the fetch is authorised by key at the moment it happens
 * ("access checks apply at fetch time"), so a note Nick has since restricted
 * simply comes back refused rather than leaking.
 */

/* ------------------------------------------------------------- the delivery */

export const GRANOLA_EVENT_SCHEMA = z.object({
  event_id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(100),
  note_id: z.string().regex(/^not_[a-zA-Z0-9]{14}$/, 'note_id is not a Granola note id'),
  occurred_at: z.string().optional(),
  data: z
    .object({ changed_fields: z.array(z.string()).optional() })
    .partial()
    .optional(),
});

export type GranolaEvent = z.infer<typeof GRANOLA_EVENT_SCHEMA>;

/** Events that mean "there is content worth fetching". */
const INGESTABLE_EVENTS = new Set(['note.generated', 'note.edited', 'note.access_granted']);

export function isIngestableEvent(eventType: string): boolean {
  return INGESTABLE_EVENTS.has(eventType);
}

/**
 * Verify a Granola delivery.
 *
 * Standard-webhooks scheme: HMAC-SHA256 over `{id}.{timestamp}.{body}`, keyed
 * by the signing secret with its `whsec_` prefix stripped and the remainder
 * base64-decoded. The header may carry several space-separated versioned
 * signatures during a secret rotation, so every `v1,` entry is tried.
 *
 * The body must be the raw text exactly as received — re-serialising parsed
 * JSON reorders keys and changes whitespace, and the hash would never match.
 */
export function verifyGranolaSignature(input: {
  secret: string;
  webhookId: string;
  webhookTimestamp: string;
  rawBody: string;
  signatureHeader: string;
  now?: Date;
}): boolean {
  const { secret, webhookId, webhookTimestamp, rawBody, signatureHeader } = input;
  if (!webhookId || !webhookTimestamp || !signatureHeader) return false;

  // Reject stale deliveries: a captured request must not stay replayable.
  const sent = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(sent)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sent) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key)
    .update(`${webhookId}.${webhookTimestamp}.${rawBody}`)
    .digest('base64');

  return signatureHeader
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .some((part) => constantTimeEquals(part.slice(3), expected));
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ---------------------------------------------------------------- the fetch */

/**
 * The subset of the note we use. Everything is optional but the id: the API
 * may add fields, and a missing one has to degrade rather than throw — a note
 * with no calendar event is a perfectly ordinary ad-hoc meeting.
 */
export const GRANOLA_NOTE_SCHEMA_REMOTE = z.object({
  id: z.string(),
  title: z.string().nullish(),
  summary_text: z.string().nullish(),
  summary_markdown: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  web_url: z.string().nullish(),
  owner: z.object({ name: z.string().nullish(), email: z.string().nullish() }).nullish(),
  attendees: z
    .array(z.object({ name: z.string().nullish(), email: z.string().nullish() }))
    .nullish(),
  calendar_event: z
    .object({
      event_title: z.string().nullish(),
      scheduled_start_time: z.string().nullish(),
      organiser: z.string().nullish(),
      invitees: z
        .array(z.object({ name: z.string().nullish(), email: z.string().nullish() }))
        .nullish(),
    })
    .nullish(),
});

export type GranolaRemoteNote = z.infer<typeof GRANOLA_NOTE_SCHEMA_REMOTE>;

export async function fetchGranolaNote(noteId: string): Promise<Result<GranolaRemoteNote>> {
  const apiKey = env().granolaApiKey;
  if (!apiKey) {
    return err('not_configured', 'GRANOLA_API_KEY is not set, so note content cannot be fetched.', {
      stillUsable: 'Everything not derived from Granola is unaffected.',
    });
  }

  let response: Response;
  try {
    response = await fetch(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(noteId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return err('provider_unavailable', 'Granola could not be reached.');
  }

  if (response.status === 401 || response.status === 403) {
    return err(
      'provider_unauthorized',
      'Granola rejected the API key, or the note is out of scope.',
    );
  }
  if (response.status === 404) {
    return err('not_found', 'Granola has no such note, or it is not visible to this key.');
  }
  if (!response.ok) {
    return err('provider_unavailable', `Granola answered ${response.status}.`);
  }

  const parsed = GRANOLA_NOTE_SCHEMA_REMOTE.safeParse(await response.json());
  if (!parsed.success) {
    return err('invalid_model_output', 'Granola returned a note in an unrecognised shape.');
  }
  return ok(parsed.data);
}

/**
 * A fetched note, in the shape ingestion already speaks.
 *
 * The markdown summary is preferred over the plain one — it is the same text
 * with its structure intact, and the app renders it as text either way.
 * Attendees come from the note, falling back to the calendar invitees, and the
 * owner is included because Nick is on every one of his own meetings and the
 * relationship list filters him out by address anyway.
 */
export function toIngestPayload(note: GranolaRemoteNote): GranolaNotePayload | null {
  const content = (note.summary_markdown ?? note.summary_text ?? '').trim();
  if (!content) return null; // generated event arrived before the summary existed

  const occurredAt =
    note.calendar_event?.scheduled_start_time ?? note.created_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) return null;

  const people = [
    ...(note.attendees ?? []),
    ...(note.calendar_event?.invitees ?? []),
    ...(note.owner ? [note.owner] : []),
  ];

  const seen = new Set<string>();
  const emails: string[] = [];
  const names: string[] = [];
  for (const person of people) {
    const email = person.email?.trim().toLowerCase();
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
    names.push(person.name?.trim() ?? '');
  }

  return {
    external_id: note.id,
    title: (note.title ?? note.calendar_event?.event_title ?? 'Untitled meeting').slice(0, 500),
    occurred_at: new Date(occurredAt).toISOString(),
    attendee_emails: emails.join(', '),
    attendee_names: names.join(', '),
    content,
    ...(note.web_url ? { source_url: note.web_url } : {}),
  };
}

/* ------------------------------------------------------------- the backlog */

const GRANOLA_LIST_SCHEMA = z.object({
  notes: z
    .array(
      z.object({
        id: z.string(),
        created_at: z.string().nullish(),
        updated_at: z.string().nullish(),
      }),
    )
    .default([]),
  hasMore: z.boolean().default(false),
  cursor: z.string().nullish(),
});

/** A note as the list endpoint describes it — identity and timestamps, no content. */
export interface GranolaListedNote {
  id: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GranolaNotePage {
  notes: GranolaListedNote[];
  cursor: string | null;
  hasMore: boolean;
}

export interface ListGranolaNotesOptions {
  cursor?: string | null;
  /** Only notes changed at or after this instant. ISO 8601. */
  updatedAfter?: string | null;
  /** Only notes first written at or after this instant. ISO 8601. */
  createdAfter?: string | null;
  /** 1–30. Granola's own maximum is 30; its default is 10. */
  pageSize?: number;
}

/** Granola's documented ceiling for `page_size`. */
const MAX_PAGE_SIZE = 30;

/**
 * One page of the note backlog.
 *
 * **The order is not documented and must not be assumed.** An earlier version
 * of this file asserted "newest first" and built the catch-up on it: read a
 * page, stop once two consecutive pages hold nothing new. Granola does not
 * promise that order and did not deliver it, so the first page was old notes
 * we already had, the stop fired immediately, and the poller reported "caught
 * up" every half hour while three days of meetings sat unfetched. Every suite
 * was green throughout — the stopping rule's only test re-implemented the rule
 * instead of calling it, so it agreed with the bug.
 *
 * The fix is to stop inferring recency from position. `updated_after` is a
 * documented filter, so a catch-up asks for the window it actually wants and
 * reads the answer to the end, whatever order it arrives in. Ordering becomes
 * something we neither know nor need.
 *
 * The content still comes from `fetchGranolaNote`, so a backfilled note and a
 * live one travel the same path and land in the same shape. The timestamps
 * returned here are what let the caller skip that fetch for a note it already
 * holds unchanged.
 */
export async function listGranolaNotes(
  options: ListGranolaNotesOptions = {},
): Promise<Result<GranolaNotePage>> {
  const apiKey = env().granolaApiKey;
  if (!apiKey) return err('not_configured', 'GRANOLA_API_KEY is not set.');

  const url = new URL('https://public-api.granola.ai/v1/notes');
  if (options.cursor) url.searchParams.set('cursor', options.cursor);
  if (options.updatedAfter) url.searchParams.set('updated_after', options.updatedAfter);
  if (options.createdAfter) url.searchParams.set('created_after', options.createdAfter);
  if (options.pageSize) {
    url.searchParams.set(
      'page_size',
      String(Math.min(Math.max(Math.trunc(options.pageSize), 1), MAX_PAGE_SIZE)),
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return err('provider_unavailable', 'Granola could not be reached.');
  }

  if (response.status === 401 || response.status === 403) {
    return err('provider_unauthorized', 'Granola rejected the API key.');
  }
  if (!response.ok) return err('provider_unavailable', `Granola answered ${response.status}.`);

  const parsed = GRANOLA_LIST_SCHEMA.safeParse(await response.json());
  if (!parsed.success) {
    return err('invalid_model_output', 'Granola returned a note list in an unrecognised shape.');
  }

  return ok({
    notes: parsed.data.notes.map((n) => ({
      id: n.id,
      createdAt: n.created_at ?? null,
      updatedAt: n.updated_at ?? null,
    })),
    cursor: parsed.data.cursor ?? null,
    hasMore: parsed.data.hasMore,
  });
}
