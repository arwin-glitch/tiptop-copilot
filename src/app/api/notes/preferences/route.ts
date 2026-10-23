import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { SET_NOTES_PREFERENCES } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { getPreferences, savePreferences } from '@/lib/services/notes-settings';

export const dynamic = 'force-dynamic';

/** This person's Copilot Notes settings (NotesPreferencesResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  return done({ preferences: await getPreferences({ store: getStore(), auth: gate.auth }) });
}

/**
 * Change them (SetNotesPreferencesRequest → NotesPreferencesResponse), e.g.
 * share every meeting this person records with the team by default.
 */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, SET_NOTES_PREFERENCES);
  if (!body.ok) return body.response;
  const store = getStore();
  const saved = await savePreferences({ store, auth: gate.auth }, body.value);
  if (!saved.ok) return fail(saved.error);
  await recordAudit(store, {
    organizationId: gate.auth.organizationId,
    userId: gate.auth.userId,
    action: 'settings.updated',
    entityType: 'user',
    entityId: gate.auth.userId,
    metadata: { area: 'notes', default_visibility: saved.value.defaultVisibility },
  });
  return done({ preferences: saved.value });
}
