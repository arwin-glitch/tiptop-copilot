import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import {
  affinitySyncOrganization,
  publicAffinitySyncStep,
  runAffinitySyncStep,
} from '@/lib/services/affinity-sync';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** How long one call works before saving its place and answering. */
const STEP_BUDGET_MS = 50_000;

/**
 * One step of the daily Affinity sync (lib/services/affinity-sync.ts).
 *
 * The daily GitHub workflow calls this in a loop until it answers
 * `done: true`: a full pull does not fit in one request, so each call does a
 * bounded chunk, saves where it got to, and the next call carries on. Calling
 * it again after `done` starts the next run.
 *
 * Authenticated like every /api/cron route: a CRON_SECRET bearer token,
 * compared in constant time, and no secret means no caller. Without
 * AFFINITY_API_KEY it answers `{ configured: false }` and does nothing.
 *
 * The answer is counts only — never a name, an id or a note. The repository is
 * public and the workflow prints what this returns into its Actions log.
 */
export async function POST(request: NextRequest) {
  const secret = env().cronSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'CRON_SECRET is not set. Scheduled jobs are disabled.',
        },
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid cron token.' } },
      { status: 401 },
    );
  }

  const apiKey = env().affinityApiKey;
  if (!apiKey) {
    return NextResponse.json(
      { ok: true, configured: false, done: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const store = getStore();
  const organization = await affinitySyncOrganization(store);
  if (!organization.ok) {
    return NextResponse.json(
      { ok: false, configured: true, done: false, error: publicError(organization.error) },
      { status: statusForError(organization.error.code) },
    );
  }

  const step = await runAffinitySyncStep(store, organization.value, {
    apiKey,
    trigger: 'cron',
    budgetMs: STEP_BUDGET_MS,
  });
  if (!step.ok) {
    return NextResponse.json(
      { ok: false, configured: true, done: false, error: publicError(step.error) },
      { status: statusForError(step.error.code) },
    );
  }
  return NextResponse.json(
    { ok: true, configured: true, ...publicAffinitySyncStep(step.value) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/** The code and the fixed message; never `details`, which may name an operation. */
function publicError(error: { code: string; message: string }) {
  return { code: error.code, message: error.message };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
