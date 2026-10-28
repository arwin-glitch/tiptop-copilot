import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/lib/auth/desktop-handoff';
import { authOrError } from '@/lib/auth/session';
import { notesAccess, setNotesBeta } from '@/lib/notes/flag';
import { done, fail, readBody } from '@/lib/notes/route-helpers';
import { SET_NOTES_BETA } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';

export const dynamic = 'force-dynamic';

/** Whether Kraken Notes is on for this person, and why (NotesAccessResponse). */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  return done({ ...(await notesAccess(getStore(), auth.value)) });
}

/** Turn this person's "Kraken Notes (beta)" switch on or off (SetNotesBetaRequest). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return fail({ code: 'forbidden', message: 'That request did not come from Kraken.' });
  }
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const limited = rateLimit(`notes-beta:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);
  const body = await readBody(request, SET_NOTES_BETA);
  if (!body.ok) return body.response;
  const saved = await setNotesBeta(getStore(), auth.value, body.value.enabled);
  return saved.ok ? done({ ...saved.value }) : fail(saved.error);
}
