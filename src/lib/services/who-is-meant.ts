import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { isCalendarNotice, pickPerson } from '@/lib/voice/who';
import { getPrimaryIntegration } from './inbox';
import { buildPersonProfile } from './person-profile';
import { getRelationshipIndex, relationshipScope } from './relationships';
import { mailPeopleMatching } from './search';

export interface WhoIsMeant {
  match: {
    email: string;
    name: string | null;
    /** Their latest real conversation (never a calendar notice), for a reply. */
    thread: { id: string; subject: string } | null;
  } | null;
  ambiguous: boolean;
  candidates: { email: string; name: string | null }[];
}

/**
 * Who a name means ("reply to Patrick", "coffee with Sarah"), for Voice
 * Arwin and the Ask chat alike: the one clear match among people Nick has
 * emailed or met, and their latest email thread. When two fit about equally
 * it says so, so Arwin asks rather than guesses. Read-only.
 */
export async function whoIsMeant(
  store: DataStore,
  auth: AuthContext,
  name: string,
): Promise<WhoIsMeant> {
  const none: WhoIsMeant = { match: null, ambiguous: false, candidates: [] };
  const said = name.trim().slice(0, 80);
  if (said.length < 2) return none;
  const org = auth.organizationId;
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const loaded = await getRelationshipIndex(store, org, {
    ...relationshipScope(auth.profile.email, integration),
    now: new Date(),
  });
  if (!loaded.ok) return none;
  const hits = mailPeopleMatching(loaded.value, said, 3);
  const candidates = hits.map((h) => ({ email: h.email, name: h.name }));
  if (hits.length === 0) return { ...none, candidates };
  const top = pickPerson(said, hits);
  if (!top) return { match: null, ambiguous: true, candidates };
  const profile = await buildPersonProfile(store, auth, top.email).catch(() => null);
  const thread = profile?.ok
    ? profile.value.threads.find((t) => t.gmailId && !isCalendarNotice(t.subject))
    : undefined;
  return {
    match: {
      email: top.email,
      name: top.name,
      thread: thread?.gmailId ? { id: thread.gmailId, subject: thread.subject } : null,
    },
    ambiguous: false,
    candidates,
  };
}
