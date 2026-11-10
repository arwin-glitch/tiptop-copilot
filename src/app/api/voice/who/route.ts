import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getRelationshipIndex, relationshipScope } from '@/lib/services/relationships';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { buildPersonProfile } from '@/lib/services/person-profile';
import { mailPeopleMatching } from '@/lib/services/search';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';
import { isCalendarNotice, pickPerson } from '@/lib/voice/who';

export const dynamic = 'force-dynamic';

/**
 * Who Voice Arwin means by a spoken name ("reply to Patrick", "coffee with
 * Sarah"): the one clear match among people Nick has emailed or met, and
 * their latest email thread. `ambiguous` with the candidates when two fit
 * about equally, so Voice Arwin asks rather than guesses. Read-only; names,
 * addresses and a subject, nothing else. Signed in only.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`voice-who:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }
  const name = (request.nextUrl.searchParams.get('name') ?? '').trim().slice(0, 80);
  if (name.length < 2) {
    return NextResponse.json({ ok: false, error: { code: 'invalid_input' } }, { status: 400 });
  }
  const store = getStore();
  const org = auth.value.organizationId;
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const loaded = await getRelationshipIndex(store, org, {
    ...relationshipScope(auth.value.profile.email, integration),
    now: new Date(),
  });
  if (!loaded.ok) {
    return NextResponse.json({ ok: true, match: null, candidates: [] });
  }
  const hits = mailPeopleMatching(loaded.value, name, 3);
  const candidates = hits.map((h) => ({ email: h.email, name: h.name }));
  if (hits.length === 0) return NextResponse.json({ ok: true, match: null, candidates });
  const top = pickPerson(name, hits);
  if (!top) return NextResponse.json({ ok: true, match: null, ambiguous: true, candidates });
  const profile = await buildPersonProfile(store, auth.value, top.email).catch(() => null);
  // A real conversation, not a calendar "Accepted:" or "Invitation:" notice.
  const thread = profile?.ok
    ? profile.value.threads.find((t) => t.gmailId && !isCalendarNotice(t.subject))
    : undefined;
  return NextResponse.json(
    {
      ok: true,
      match: {
        email: top.email,
        name: top.name,
        thread: thread ? { id: thread.gmailId, subject: thread.subject } : null,
      },
      candidates,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
