import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import {
  fetchGranolaNote,
  GRANOLA_EVENT_SCHEMA,
  isIngestableEvent,
  toIngestPayload,
  verifyGranolaSignature,
} from '@/lib/services/granola-api';
import { GRANOLA_NOTE_SCHEMA, ingestGranolaNote } from '@/lib/services/meetings';
import type { Organization } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Meeting notes from Granola.
 *
 * Two senders arrive here and they authenticate differently, which is why this
 * route branches before it does anything else:
 *
 * - **Granola itself**, via its native webhook. Signed with the endpoint's
 *   signing secret and carrying only `{event_type, note_id}` — no content, by
 *   design. The content is fetched back over Granola's public API using the
 *   API key. This is the route that works for private notes: an unfurl cannot
 *   read them, an authorised API request can.
 * - **Our own senders** — the Mac cache watcher and the email transport —
 *   which post the full note in the shape `GRANOLA_NOTE_SCHEMA` defines and
 *   authenticate with a shared token in the URL.
 *
 * Both end in the same idempotent ingest keyed on the note id, so any mixture
 * of senders can run at once without duplicating a meeting.
 *
 * Answers 2xx wherever a retry cannot help — a mis-mapped payload will fail
 * identically four more times, and Granola retries non-2xx with backoff. Only
 * an unauthenticated caller gets a 4xx. Failures are logged, not signalled.
 */
export async function POST(request: NextRequest) {
  const e = env();

  // The raw text, not the parsed object: the signature covers the exact bytes
  // sent, and re-serialising JSON reorders keys and loses whitespace.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ ok: true, skipped: 'unreadable body' });
  }

  const webhookId = request.headers.get('webhook-id');
  const signature = request.headers.get('webhook-signature');

  if (webhookId && signature) {
    return handleGranolaDelivery(request, rawBody, webhookId, signature);
  }

  /* ------------------------------------------------ our own senders */

  const secret = e.granolaWebhookSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message:
            'This endpoint accepts signed Granola deliveries, or token-authenticated posts once GRANOLA_WEBHOOK_SECRET is set.',
        },
      },
      { status: 503 },
    );
  }

  const provided = new URL(request.url).searchParams.get('token') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid webhook token.' } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, skipped: 'body is not JSON' });
  }

  const parsed = GRANOLA_NOTE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Granola webhook payload failed validation', { issues: parsed.error.issues.length });
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const organizationId = await soleOrganizationId();
  if (!organizationId)
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });

  const result = await ingestGranolaNote(getStore(), organizationId, parsed.data);
  if (!result.ok) {
    log.error('Granola note ingestion failed', { code: result.error.code });
    return NextResponse.json({ ok: true, skipped: 'ingestion failed' });
  }

  return NextResponse.json({
    ok: true,
    noteId: result.value.id,
    created: result.value.created,
    flagged: result.value.flagged,
  });
}

/**
 * A signed delivery from Granola.
 *
 * Verify, then fetch, then ingest. The fetch is the part that distinguishes
 * this integration: Granola's own docs say a notification "contains no note
 * content, only a reference to the note that changed", so the delivery alone
 * is never enough and an endpoint that tried to ingest it directly would file
 * an empty record.
 */
async function handleGranolaDelivery(
  request: NextRequest,
  rawBody: string,
  webhookId: string,
  signature: string,
): Promise<NextResponse> {
  const signingSecret = env().granolaSigningSecret;
  if (!signingSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'GRANOLA_SIGNING_SECRET is not set, so Granola deliveries cannot be verified.',
        },
      },
      { status: 503 },
    );
  }

  const timestamp = request.headers.get('webhook-timestamp') ?? '';
  const verified = verifyGranolaSignature({
    secret: signingSecret,
    webhookId,
    webhookTimestamp: timestamp,
    rawBody,
    signatureHeader: signature,
  });

  if (!verified) {
    // Unsigned or stale: refuse loudly. This is the one case where a non-2xx
    // is right — a genuine delivery is never unsigned, so a retry is welcome.
    log.warn('Granola delivery failed signature verification', {
      hasTimestamp: Boolean(timestamp),
    });
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid webhook signature.' } },
      { status: 401 },
    );
  }

  let event;
  try {
    event = GRANOLA_EVENT_SCHEMA.safeParse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ ok: true, skipped: 'body is not JSON' });
  }
  if (!event.success) {
    return NextResponse.json({
      ok: true,
      skipped: 'unrecognised event shape',
      issues: event.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  if (!isIngestableEvent(event.data.event_type)) {
    return NextResponse.json({ ok: true, skipped: `event ${event.data.event_type} not ingested` });
  }

  const note = await fetchGranolaNote(event.data.note_id);
  if (!note.ok) {
    log.error('Could not fetch the Granola note a webhook named', { code: note.error.code });
    // 2xx even here: a missing key or a note out of scope will not resolve on
    // Granola's retry schedule, and /diagnostics reports the configuration.
    return NextResponse.json({ ok: true, skipped: `fetch failed: ${note.error.code}` });
  }

  const payload = toIngestPayload(note.value);
  if (!payload) {
    // `note.generated` can arrive fractionally before the summary is written.
    return NextResponse.json({ ok: true, skipped: 'note has no summary yet' });
  }

  const organizationId = await soleOrganizationId();
  if (!organizationId)
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });

  const result = await ingestGranolaNote(getStore(), organizationId, payload);
  if (!result.ok) {
    log.error('Granola note ingestion failed', { code: result.error.code });
    return NextResponse.json({ ok: true, skipped: 'ingestion failed' });
  }

  return NextResponse.json({
    ok: true,
    noteId: result.value.id,
    created: result.value.created,
    flagged: result.value.flagged,
  });
}

/**
 * The organization this deployment serves.
 *
 * Single-tenant by deployment. If that is ever ambiguous, refuse rather than
 * guess which fund a meeting note belongs to.
 */
async function soleOrganizationId(): Promise<string | null> {
  try {
    const organizations = (await getStore().list('organizations', '', {})) as Organization[];
    if (organizations.length !== 1) {
      log.warn('Granola delivery with ambiguous organization', { count: organizations.length });
      return null;
    }
    return organizations[0]?.id ?? null;
  } catch (error) {
    log.error('Granola webhook could not read organizations', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
