import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { GRANOLA_NOTE_SCHEMA, ingestGranolaNote } from '@/lib/services/meetings';
import type { Organization } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Meeting notes from Granola, delivered by Zapier.
 *
 * The Zap watches a Granola folder and POSTs each new or updated note here,
 * with its fields mapped to the shape `GRANOLA_NOTE_SCHEMA` defines. Same
 * doorbell contract as the Gmail push endpoint:
 *
 * - Authentication is a shared secret in the URL, compared in constant time.
 *   `GRANOLA_WEBHOOK_SECRET` unset means the endpoint is off — 503, and
 *   nothing else in the product is affected.
 * - Once the secret checks out, the answer is 2xx wherever retrying cannot
 *   help. Zapier retries non-2xx with backoff, and a payload that failed
 *   validation will fail validation four more times — it would only wake the
 *   instance repeatedly. Real failures are logged, not signalled.
 * - Ingestion is idempotent on the note's external id, so Zapier's retries
 *   and Granola's post-meeting edits both land as updates, never duplicates.
 *
 * The note body is untrusted content. It is scanned and annotated on the way
 * in, stored verbatim, and only ever rendered as text — the same handling as
 * an email body, because it is the same threat: prose somebody else wrote.
 */
export async function POST(request: NextRequest) {
  const secret = env().granolaWebhookSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'GRANOLA_WEBHOOK_SECRET is not set. Meeting-note ingestion is disabled.',
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
    body = await request.json();
  } catch {
    // Zapier's "send a test" button posts an empty or malformed body.
    // Acknowledge it so the test passes; there is nothing to ingest.
    return NextResponse.json({ ok: true, skipped: 'body is not JSON' });
  }

  const parsed = GRANOLA_NOTE_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Granola webhook payload failed validation', {
      issues: parsed.error.issues.length,
    });
    // 2xx on purpose: a mis-mapped Zap field will not fix itself on retry, and
    // the issue list in the response is what the person editing the Zap sees.
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const store = getStore();

  try {
    // Single-tenant by deployment: the webhook belongs to the organization the
    // instance serves. If that ever becomes ambiguous, refuse loudly rather
    // than guessing which fund a meeting note belongs to.
    const organizations = (await store.list('organizations', '', {})) as Organization[];
    if (organizations.length !== 1) {
      log.warn('Granola webhook with ambiguous organization', {
        count: organizations.length,
      });
      return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
    }

    const result = await ingestGranolaNote(store, organizations[0]!.id, parsed.data);
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
  } catch (error) {
    log.error('Granola webhook error', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json({ ok: true, skipped: 'internal error' });
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
