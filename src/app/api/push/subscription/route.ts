import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  removeSubscription,
  saveSubscription,
  SUBSCRIPTION_SCHEMA,
} from '@/lib/services/push-alerts';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const bad = (message: string) =>
  NextResponse.json({ ok: false, error: { code: 'invalid_input', message } }, { status: 400 });

/** Turn phone alerts on for this device (Settings > Preferences). */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const parsed = SUBSCRIPTION_SCHEMA.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Not a valid push subscription.');
  await saveSubscription(getStore(), auth.value.organizationId, auth.value.userId, parsed.data);
  return NextResponse.json({ ok: true });
}

/** Turn phone alerts off for this device. */
export async function DELETE(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const parsed = z
    .object({ endpoint: z.string().url().max(1000) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('Missing endpoint.');
  await removeSubscription(getStore(), auth.value.organizationId, parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
