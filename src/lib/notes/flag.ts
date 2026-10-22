import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import type { AuditEvent } from '@/lib/types/domain';
import type { NotesAccessResponse } from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Whether Copilot Notes is on for this person (D-076). Off by default.
 *
 * Two switches, both needed. NOTES_ENABLED on the server: 'off' (unset) hides
 * the feature everywhere and every /api/notes route answers 404; 'on' shows
 * it to everyone; 'beta' shows it to whoever turns on the "Copilot Notes
 * (beta)" switch in Settings. That per-person switch is kept the way the
 * Calendar's settings are, as audit_events rows (action `notes.beta_set`,
 * newest wins), so it needs no table of its own and reads as off on any error.
 */

export const NOTES_BETA_ACTION = 'notes.beta_set';

export type NotesAccess = Omit<NotesAccessResponse, 'ok'>;

export async function readNotesBeta(
  store: DataStore,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  try {
    const rows = (await store.list(
      'audit_events',
      organizationId,
      { eq: { user_id: userId, action: NOTES_BETA_ACTION } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
    )) as AuditEvent[];
    return rows[0]?.metadata?.enabled === true;
  } catch (error) {
    log.warn('Copilot Notes switch could not be read', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function notesAccess(store: DataStore, auth: AuthContext): Promise<NotesAccess> {
  const mode = env().notesEnabled;
  if (mode === 'off') return { mode, beta: false, enabled: false };
  const beta = await readNotesBeta(store, auth.organizationId, auth.userId);
  return { mode, beta, enabled: mode === 'on' || beta };
}

/** Turn this person's beta switch on or off. Refused while the server switch is off. */
export async function setNotesBeta(
  store: DataStore,
  auth: AuthContext,
  enabled: boolean,
  now: Date = new Date(),
): Promise<Result<NotesAccess>> {
  if (env().notesEnabled === 'off') {
    return err('not_found', 'Copilot Notes is not available on this Copilot yet.');
  }
  const row: AuditEvent = {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: auth.userId,
    action: NOTES_BETA_ACTION,
    entity_type: 'user',
    entity_id: auth.userId,
    metadata: { enabled },
    ip_hash: null,
    created_at: now.toISOString(),
  };
  try {
    await store.insert('audit_events', row);
  } catch (error) {
    log.error('Copilot Notes switch could not be saved', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return err('internal', 'That setting could not be saved. Try again.', { retryable: true });
  }
  return ok(await notesAccess(store, auth));
}
