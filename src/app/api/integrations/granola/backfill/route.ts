import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { fetchGranolaNote, listGranolaNotes, toIngestPayload } from '@/lib/services/granola-api';
import {
  catchUpSince,
  existingNoteVersions,
  ingestGranolaNote,
  isNoteUnchanged,
} from '@/lib/services/meetings';
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
 * Two modes, and the difference matters:
 *
 * - **Catch-up** (the default, and what the every-half-hour poller runs) asks
 *   Granola for notes changed since shortly before the newest meeting we hold,
 *   then reads that answer to the end. It is bounded by the window, not by a
 *   guess about ordering.
 * - **Full** (`?full=1`) walks the entire history with no filter, for a first
 *   import or a rebuild.
 *
 * Neither mode assumes an order. The previous version did — it stopped once
 * two consecutive pages held nothing new, which is only sound if the newest
 * notes come first, and Granola documents no such promise. In production the
 * first page was history we already had, so every catch-up stopped on page two
 * and reported success while nothing was fetched. Position tells us nothing
 * here; `updated_after` tells us exactly what we asked.
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

  // A full import takes no window; a catch-up takes the one the caller named,
  // or works out its own from the newest meeting already stored. A cursor is a
  // continuation of a walk already in progress, so it carries its own window
  // and must not be given a second one.
  const full = isTruthy(url.searchParams.get('full'));
  const continuing = Boolean(cursor);
  const since =
    full || continuing
      ? null
      : (url.searchParams.get('since') ?? (await catchUpSince(getStore(), organizationId)));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;
  let hasMore = false;

  for (let page = 0; page < pages; page++) {
    const listed = await listGranolaNotes({
      cursor,
      updatedAfter: since,
      // Granola's maximum. Three times fewer round trips than the default of
      // ten, on an endpoint that returns identity and timestamps only.
      pageSize: 30,
    });
    if (!listed.ok) {
      log.error('Granola backfill could not list notes', { code: listed.error.code });
      return NextResponse.json(
        { ok: false, error: listed.error, progress: { created, updated, skipped, cursor } },
        { status: 502 },
      );
    }

    // What we already hold from this page, in one query rather than one each.
    const held = await existingNoteVersions(
      getStore(),
      organizationId,
      listed.value.notes.map((n) => n.id),
    );

    for (const listedNote of listed.value.notes) {
      // The note is unchanged since we stored it, so its content cannot have
      // changed either. Skipping the fetch here is what keeps a full import
      // inside the host's limits: it is one request per *new* note, not one
      // per note that exists.
      if (isNoteUnchanged(held.get(listedNote.id), listedNote.updatedAt)) {
        unchanged++;
        continue;
      }

      const note = await fetchGranolaNote(listedNote.id);
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

      try {
        const result = await ingestGranolaNote(getStore(), organizationId, payload);
        if (!result.ok) skipped++;
        else if (result.value.created) created++;
        else updated++;
      } catch (error) {
        // A throw here is almost always the one setup step that has no other
        // symptom: the migration has not been applied, so `meeting_notes` does
        // not exist. Say that plainly instead of failing as an anonymous 500 —
        // the whole import is blocked until it is fixed, so stop rather than
        // grinding through hundreds of notes that cannot be stored.
        const message = error instanceof Error ? error.message : String(error);
        const missingTable = /meeting_notes|relation .* does not exist|42P01/i.test(message);
        log.error('Granola backfill could not store a note', { missingTable });
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: missingTable ? 'not_configured' : 'internal',
              message: missingTable
                ? 'The meeting_notes table does not exist yet. Run the migration in supabase/migrations/20260818000000_meeting_notes.sql, then run this again.'
                : `Storing a note failed: ${message}`,
            },
            progress: { created, updated, skipped, cursor },
          },
          { status: missingTable ? 503 : 500 },
        );
      }
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
    // Already held and untouched at Granola, so never fetched.
    unchanged,
    hasMore,
    // The window this call asked for, echoed so a caller — or a log read six
    // months from now — can see what was actually requested rather than infer
    // it. Null means the whole history.
    since,
    // Feed this back as ?cursor= to continue where this call stopped.
    cursor,
  });
}

/** Query flags arrive as text; treat the usual affirmatives as true. */
function isTruthy(value: string | null): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
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
