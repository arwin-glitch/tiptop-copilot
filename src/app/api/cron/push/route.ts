import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { pruneBookingQuestionsForAll } from '@/lib/booking/chat-bridge';
import { getStore } from '@/lib/runtime';
import { afterResponse } from '@/lib/notes/background';
import { placeHeldBookingsForAll } from '@/lib/services/booking-manage';
import { recordJobHeartbeatForAll } from '@/lib/services/feed-health';
import { settleNotesForAll } from '@/lib/services/notes-bridge';
import { buildOutbox, recordDelivery, vapidPublicKey } from '@/lib/services/push-alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The phone-alert outbox, for the push-alerts GitHub Actions job only.
 *
 * GET returns the alerts due now and the subscriptions to send them to; the
 * job signs and sends them with the VAPID private key it holds as a GitHub
 * secret. POST is the job's report: which alert keys were delivered (so they
 * never alert twice) and which endpoints the push service says are gone.
 *
 * Bearer CRON_SECRET, compared in constant time; refuses everyone when unset.
 */
function unauthorized(request: NextRequest): NextResponse | null {
  const secret = env().cronSecret;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_configured', message: 'CRON_SECRET is not set.' } },
      { status: 503 },
    );
  }
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid cron token.' } },
      { status: 401 },
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  const scope = request.nextUrl.searchParams.get('scope') === 'meetings' ? 'meetings' : 'all';
  // Diagnostics > Feeds tells from this whether the sender is still calling;
  // written at most every ten minutes, and never throws.
  await recordJobHeartbeatForAll(getStore(), 'push-sender');
  // Every tick (each minute for meetings, each half hour for the rest):
  // held booking-link times go on the calendar by themselves once they can,
  // each checked again first, a Google fault on its own backoff (D-078).
  // Never throws. Visitors' old assistant questions are deleted half-hourly.
  await placeHeldBookingsForAll(getStore()).catch(() => null);
  if (scope === 'all') await pruneBookingQuestionsForAll(getStore()).catch(() => null);
  const outbox = await buildOutbox(getStore(), new Date(), scope);
  // Kraken Notes (D-076): this job calls every minute through the day, so
  // Arwin's notes (and the tasks from them) land within minutes even when no
  // meeting page is open. After the answer; a no-op while Notes is off.
  await afterResponse('settle Arwin’s notes', () => settleNotesForAll(getStore()));
  return NextResponse.json(
    { ok: true, publicKey: vapidPublicKey(), outbox },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

const REPORT = z.object({
  organizationId: z.string().min(1).max(64),
  sent: z.array(z.string().min(1).max(200)).max(200),
  gone: z.array(z.string().url().max(1000)).max(50),
});

export async function POST(request: NextRequest) {
  const denied = unauthorized(request);
  if (denied) return denied;
  const parsed = REPORT.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: 'invalid_input', message: 'Bad delivery report.' } },
      { status: 400 },
    );
  }
  const { organizationId, sent, gone } = parsed.data;
  const result = await recordDelivery(getStore(), organizationId, sent, gone);
  return NextResponse.json({ ok: true, ...result });
}
