import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { fetchGranolaNote, listGranolaNotes, toIngestPayload } from '@/lib/services/granola-api';
import { ingestGranolaNote } from '@/lib/services/meetings';
import type { Organization } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Import the Granola backlog.
 *
 * The webhook only fires on change, so it can never reach a meeting that
 * happened before the endpoint existed — and years of history is the larger
 * part of what makes the relationship list worth reading. This walks the note
 * list and ingests each one through exactly the same path a live delivery
 * takes, so a backfilled note is indistinguishable from a fresh one.
 *
 * Resumable rather than long-running, because the host this deploys to is a
 * free instance with a request ceiling and thousands of notes will not fit in
 * one call. Each request handles a few pages and hands back the cursor it
 * stopped at; the caller loops until `hasMore` is false. Ingestion is
 * idempotent on the note id, so an interrupted run is resumed simply by
 * calling again — at worst a page is re-read, never duplicated.
 *
 * Authenticated by the same shared token as the token-based webhook path. It
 * spends API quota and writes records, so it is deliberately not something an
 * unauthenticated caller can start.
 */
export async function POST(request: NextRequest) {
  const secret = env().granolaWebhookSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'not_configured', message: 'GRANOLA_WEBHOOK_SECRET is not set.' },
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const provided = url.searchParams.get('token') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid token.' } },
      { status: 401 },
    );
  }

  if (!env().granolaApiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'GRANOLA_API_KEY is not set, so no note content can be fetched.',
        },
      },
      { status: 503 },
    );
  }

  const organizations = (await getStore().list('organizations', '', {})) as Organization[];
  if (organizations.length !== 1) {
    return NextResponse.json(
      { ok: false, error: { code: 'conflict', message: 'No unambiguous organization.' } },
      { status: 409 },
    );
  }
  const organizationId = organizations[0]!.id;

  // A few pages per call keeps each request well inside the host's ceiling.
  const pages = clamp(Number.parseInt(url.searchParams.get('pages') ?? '3', 10), 1, 10);
  let cursor = url.searchParams.get('cursor');

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let hasMore = false;

  for (let page = 0; page < pages; page++) {
    const listed = await listGranolaNotes(cursor);
    if (!listed.ok) {
      log.error('Granola backfill could not list notes', { code: listed.error.code });
      return NextResponse.json(
        { ok: false, error: listed.error, progress: { created, updated, skipped, cursor } },
        { status: 502 },
      );
    }

    for (const noteId of listed.value.noteIds) {
      const note = await fetchGranolaNote(noteId);
      if (!note.ok) {
        // One unreadable note must not end the run: a note out of the key's
        // scope is an expected outcome, not a failure of the import.
        skipped++;
        continue;
      }

      const payload = toIngestPayload(note.value);
      if (!payload) {
        skipped++;
        continue;
      }

      const result = await ingestGranolaNote(getStore(), organizationId, payload);
      if (!result.ok) skipped++;
      else if (result.value.created) created++;
      else updated++;
    }

    cursor = listed.value.cursor;
    hasMore = listed.value.hasMore;
    if (!hasMore) break;
  }

  return NextResponse.json({
    ok: true,
    created,
    updated,
    skipped,
    hasMore,
    // Feed this back as ?cursor= to continue where this call stopped.
    cursor,
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
