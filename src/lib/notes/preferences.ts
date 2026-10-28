import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import type { AuditEvent } from '@/lib/types/domain';
import type { NotesPreferences, SetNotesPreferencesRequest } from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Each person's Kraken Notes settings (D-076), kept the way the beta switch
 * is (flag.ts): audit_events rows, action `notes.preferences_set`, newest
 * wins, so they need no table and read as the defaults on any error.
 *
 * defaultVisibility: who sees a meeting this person records, until they
 * change it on the meeting. 'private' unless they choose 'team' (Nick picks
 * 'team' so Arwin and the routines can read his meetings). A meeting filed in
 * a private folder (Coaching) stays private whatever this says.
 */

export const NOTES_PREFERENCES_ACTION = 'notes.preferences_set';

export const DEFAULT_NOTES_PREFERENCES: NotesPreferences = { defaultVisibility: 'private' };

function fromMetadata(metadata: Record<string, unknown> | null | undefined): NotesPreferences {
  const v = metadata?.defaultVisibility;
  return { defaultVisibility: v === 'team' ? 'team' : 'private' };
}

export async function readNotesPreferences(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<NotesPreferences> {
  try {
    const rows = (await store.list(
      'audit_events',
      organizationId,
      { eq: { user_id: userId, action: NOTES_PREFERENCES_ACTION } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    )) as AuditEvent[];
    return rows[0] ? fromMetadata(rows[0].metadata) : { ...DEFAULT_NOTES_PREFERENCES };
  } catch (error) {
    log.warn('Kraken Notes settings could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_NOTES_PREFERENCES };
  }
}

export async function setNotesPreferences(
  store: DataStore,
  auth: AuthContext,
  patch: SetNotesPreferencesRequest,
  now: Date = new Date(),
): Promise<Result<NotesPreferences>> {
  const current = await readNotesPreferences(store, auth.organizationId, auth.userId);
  const next: NotesPreferences = { ...current, ...patch };
  const row: AuditEvent = {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: auth.userId,
    action: NOTES_PREFERENCES_ACTION,
    entity_type: 'user',
    entity_id: auth.userId,
    metadata: { ...next },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  try {
    await store.insert('audit_events', row);
  } catch (error) {
    log.error('Kraken Notes settings could not be saved', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'That setting could not be saved. Try again.', { retryable: true });
  }
  return ok(next);
}
