import { NextResponse, type NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { listIosDevices, requestTestAlert } from '@/lib/services/ios-push';
import { hasSubscription } from '@/lib/services/push-alerts';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

/**
 * "Send a test alert": a real alert through the sender job to your phones
 * only, the way your alerts go now (lib/services/ios-push.ts). It arrives
 * within about a minute between 6am and 9pm Central. Three an hour.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`push-test:${auth.value.userId}`, 3, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const store = getStore();
  const { organizationId, userId } = auth.value;
  const [web, devices] = await Promise.all([
    hasSubscription(store, organizationId, userId),
    listIosDevices(store, organizationId),
  ]);
  if (!web && !devices.some((d) => d.userId === userId)) {
    return fail(err('conflict', 'Turn alerts on for a phone first.').error);
  }
  const queued = await requestTestAlert(store, auth.value);
  if (!queued.ok) return fail(queued.error);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
