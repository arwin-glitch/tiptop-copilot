import 'server-only';
import { env } from '@/lib/config/env';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { notesRelayChannel, relayReadable } from '@/lib/notes/relay';
import type { MeetingNote } from '@/lib/types/domain';
import type { NotesRequest, NotesRequestView } from '@/lib/types/notes';
import { directCallConfigured } from './ask-routine';

/**
 * How a request for Arwin's notes reads on the meeting page (D-076). Kept
 * apart from the bridge service so the core notes service can show it
 * without importing the bridge.
 */

/**
 * The routine's trigger, the relay and a private relay channel of its own
 * are all there, so a request can go out and come back.
 */
export function notesRoutineConnected(): boolean {
  return (
    directCallConfigured() && relayReadable() && notesRelayChannel() !== null && !env().demoMode
  );
}

export function toRequestView(request: NotesRequest): NotesRequestView {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    templateId: request.template_id,
    requestedAt: request.created_at,
    fired: Boolean(request.fired_at),
    connected: notesRoutineConnected(),
    completedAt: request.completed_at,
    error: request.error,
    omittedLines: request.omitted_lines,
  };
}

/** The request behind a note's text, when there is one. A migration not yet applied reads as none. */
export async function requestOfNote(
  store: DataStore,
  organizationId: string,
  note: Pick<MeetingNote, 'notes_request_id'> | null,
): Promise<NotesRequest | null> {
  if (!note?.notes_request_id) return null;
  try {
    return await store.get('notes_requests', organizationId, note.notes_request_id);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
}
