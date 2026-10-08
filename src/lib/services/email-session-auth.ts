import 'server-only';
import { NextResponse } from 'next/server';
import { authOrError, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { statusForError, type AppError } from '@/lib/util/result';
import type { Integration } from '@/lib/types/domain';

/** Shared by the email session routes. */
export const fail = (error: AppError, status?: number) =>
  NextResponse.json({ ok: false, error }, { status: status ?? statusForError(error.code) });

export async function sessionAuth(): Promise<
  | { ok: true; auth: AuthContext; integration: Integration | null }
  | { ok: false; response: NextResponse }
> {
  const auth = await authOrError();
  if (!auth.ok) return { ok: false, response: fail(auth.error) };
  const integration = await getPrimaryIntegration(getStore(), auth.value.organizationId);
  return { ok: true, auth: auth.value, integration };
}

export const personName = (auth: AuthContext) =>
  auth.profile.full_name?.split(' ')[0] || auth.profile.email.split('@')[0] || 'Someone';
