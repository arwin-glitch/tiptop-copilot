import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError, hasRole } from '@/lib/auth/session';
import {
  compareVersions,
  FIRST_DESKTOP_ALERTS_VERSION,
  parseDesktopVersion,
} from '@/lib/desktop/shared';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  desktopDeviceOwner,
  isDesktopDeviceId,
  registerDesktopDevice,
  removeDesktopDevice,
} from '@/lib/services/desktop-alerts';
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

const DEVICE = z.string().refine(isDesktopDeviceId, 'Not a device id');

const TURN_ON = z.object({
  device: DEVICE,
  platform: z.enum(['mac', 'windows']),
  version: z.string().refine((value) => {
    const version = parseDesktopVersion(value);
    return version !== null && compareVersions(version, FIRST_DESKTOP_ALERTS_VERSION) >= 0;
  }, 'Desktop alerts need a newer app'),
});

/**
 * Whether Kraken still has this computer turned on. Settings in the app
 * asks when the shell says on but the page's list does not have it, before
 * turning the shell off: the list may be from before Enable (the Preferences
 * tab left and opened again before the page refreshed).
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`push-desktop-check:${auth.value.userId}`, 60, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const device = request.nextUrl.searchParams.get('device');
  if (!isDesktopDeviceId(device)) return bad('Missing device.');
  const owner = await desktopDeviceOwner(getStore(), auth.value.organizationId, device);
  return NextResponse.json({ ok: true, on: owner.found }, { headers: NO_STORE });
}

/**
 * Settings > Preferences in the desktop app (0.4.0 and newer): turn desktop
 * alerts on for this computer. Answers the computer's token once; the page
 * hands it straight to the shell (lib/services/desktop-alerts.ts).
 * Same-origin only, on top of the session, so no other site can mint one.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`push-desktop:${auth.value.userId}`, 10, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = TURN_ON.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Not a desktop app that can show alerts.');
  const result = await registerDesktopDevice(getStore(), auth.value, parsed.data);
  if (!result.ok) return fail(result.error);
  return NextResponse.json({ ok: true, token: result.value.token }, { headers: NO_STORE });
}

/**
 * Turn desktop alerts off for a computer: this one (Turn off, signing out)
 * or another in the list. Only whoever turned it on, or an admin.
 */
export async function DELETE(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  if (!isSameOrigin(request)) return fail(err('forbidden', 'Not allowed from here.').error);
  const limited = rateLimit(`push-desktop-off:${auth.value.userId}`, 30, 3_600_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = z.object({ device: DEVICE }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Missing device.');
  const store = getStore();
  const { organizationId, userId } = auth.value;
  const owner = await desktopDeviceOwner(store, organizationId, parsed.data.device);
  if (owner.found && owner.userId !== userId && !hasRole(auth.value, 'admin')) {
    return fail(
      err(
        'forbidden',
        'Only whoever turned on alerts for that computer, or an admin, can turn them off.',
      ).error,
    );
  }
  const removed = await removeDesktopDevice(
    store,
    organizationId,
    parsed.data.device,
    { userId },
    'settings',
  );
  return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
}
