import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError, hasRole } from '@/lib/auth/session';
import { parseDesktopVersion } from '@/lib/desktop/shared';
import { isIosAppRequest } from '@/lib/ios/server';
import { isApnsToken, isIosDeviceKey, iosPushShell } from '@/lib/ios/shared';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  iosDeviceState,
  registerIosDevice,
  removeIosDevice,
  type IosOffReason,
} from '@/lib/services/ios-push';
import { err, statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(error: AppError): NextResponse {
  return NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: NO_STORE },
  );
}

const bad = (message: string) => fail(err('invalid_input', message).error);

const KEY = z.string().refine(isIosDeviceKey, 'Not an iPhone id');

const TURN_ON = z.object({
  token: z.string().refine(isApnsToken, 'Not a push token'),
  version: z.string().refine((value) => iosPushShell(parseDesktopVersion(value)), 'Too old'),
  build: z
    .string()
    .regex(/^[0-9][0-9.]{0,31}$/)
    .nullish(),
  builtDay: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  replaces: KEY.nullish(),
});

const TURN_OFF = z.object({
  key: KEY,
  reason: z.enum(['settings', 'permission', 'sign_out']).optional(),
});

/**
 * Whether Copilot has this iPhone's app alerts on, and how old its build is.
 * By the iPhone's id (the first 40 hex characters of its token's SHA-256),
 * never the token: query strings end up in logs.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`push-ios-check:${auth.value.userId}`, 60, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const key = request.nextUrl.searchParams.get('key');
  if (!isIosDeviceKey(key)) return bad('Missing iPhone id.');
  const state = await iosDeviceState(getStore(), auth.value.organizationId, key);
  return NextResponse.json(
    {
      ok: true,
      on: state.found,
      mine: state.found && state.userId === auth.value.userId,
      buildAgeDays: state.found ? state.buildAgeDays : null,
    },
    { headers: NO_STORE },
  );
}

/**
 * The iPhone app turns alerts on for this iPhone, or checks in again (on
 * launch and resume, at most twice a day, which keeps its web push held
 * back: lib/services/ios-push.ts). From the app only, same origin, on top of
 * the session.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  if (!isIosAppRequest(request)) return bad('Only the TipTop Copilot iPhone app can do this.');
  const limited = rateLimit(`push-ios:${auth.value.userId}`, 10, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = TURN_ON.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Not an iPhone app that can get alerts.');
  const { token, version, build, builtDay, replaces } = parsed.data;
  const result = await registerIosDevice(getStore(), auth.value, {
    token,
    version: parseDesktopVersion(version) as string,
    build: build ?? null,
    builtDay: builtDay ?? null,
    replaces: replaces ?? null,
  });
  if (!result.ok) return fail(result.error);
  return NextResponse.json({ ok: true, key: result.value.key }, { headers: NO_STORE });
}

/**
 * Turn app alerts off for an iPhone: Turn off, signing out, or the app
 * finding notifications switched off in iOS Settings (so web push comes
 * back at once). Only whoever turned it on, or an admin.
 */
export async function DELETE(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`push-ios-off:${auth.value.userId}`, 30, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = TURN_OFF.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Missing iPhone id.');
  const store = getStore();
  const { organizationId, userId } = auth.value;
  const state = await iosDeviceState(store, organizationId, parsed.data.key);
  if (state.found && state.userId !== userId && !hasRole(auth.value, 'admin')) {
    return fail(
      err(
        'forbidden',
        'Only whoever turned on alerts for that iPhone, or an admin, can turn them off.',
      ).error,
    );
  }
  const reason: IosOffReason = parsed.data.reason ?? 'settings';
  const removed = await removeIosDevice(store, organizationId, parsed.data.key, { userId }, reason);
  return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
}
