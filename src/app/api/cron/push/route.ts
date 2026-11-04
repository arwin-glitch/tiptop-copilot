import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { pruneBookingQuestionsForAll } from '@/lib/booking/chat-bridge';
import { pruneJobsQuestionsForAll } from '@/lib/jobs-board/chat-bridge';
import { prunePerksQuestionsForAll } from '@/lib/perks-ask/bridge';
import { getStore } from '@/lib/runtime';
import { afterResponse } from '@/lib/notes/background';
import { placeHeldBookingsForAll } from '@/lib/services/booking-manage';
import { recordJobHeartbeatForAll } from '@/lib/services/feed-health';
import { settleNotesForAll } from '@/lib/services/notes-bridge';
import { dispatchDueScheduledForAll } from '@/lib/services/inbox-scheduled';
import { buildOutbox, recordDelivery, vapidPublicKey } from '@/lib/services/push-alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The phone-alert outbox, for the push-alerts GitHub Actions job only.
 *
 * GET returns the alerts due now and the phones to send them to; the job
 * signs and sends them with the VAPID and APNs keys it holds as GitHub
 * secrets. `?apns=1` is the job saying its APNs key is there and working:
 * only then are iPhone app tokens listed, and web push held back for anyone
 * whose app has their alerts (lib/services/ios-push.ts). `&fallback=1` adds
 * that its APNs sends are failing right now: the tokens are still listed, and
 * nothing is held back until Apple answers again. POST is the job's
 * report: which alert keys were delivered (so they never alert twice), and
 * which endpoints and iPhones the push services say are gone.
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
  // Every tick: scheduled Inbox emails that are due go out, each claimed once
  // (lib/services/inbox-scheduled.ts). A person's Schedule pick made each one;
  // this loop is what keeps their time. Never throws.
  await dispatchDueScheduledForAll(getStore(), { demo: env().demoMode }).catch(() => null);
  if (scope === 'all') await pruneBookingQuestionsForAll(getStore()).catch(() => null);
  if (scope === 'all') await pruneJobsQuestionsForAll(getStore()).catch(() => null);
  if (scope === 'all') await prunePerksQuestionsForAll(getStore()).catch(() => null);
  const apnsReady = request.nextUrl.searchParams.get('apns') === '1';
  const holdBack = request.nextUrl.searchParams.get('fallback') !== '1';
  const outbox = await buildOutbox(getStore(), new Date(), scope, { apnsReady, holdBack });
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
  // From a sender with an APNs key; an older one leaves it out.
  goneApns: z
    .array(
      z.object({
        key: z.string().regex(/^[0-9a-f]{40}$/),
        // When Apple confirmed the token stopped working (a 410's timestamp).
        at: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50)
    .optional(),
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
  const { organizationId, sent, gone, goneApns } = parsed.data;
  const result = await recordDelivery(getStore(), organizationId, sent, gone, goneApns ?? []);
  return NextResponse.json({ ok: true, ...result });
}
