import 'server-only';
import { refreshAfterSpeakerChange } from '@/lib/services/notes-generate';
import type { NotesContext } from '@/lib/services/notes';

/**
 * After a voice is renamed, split or merged (D-076): action-item owners are
 * read again at once, and the notes take the new names in place: Quick notes
 * are written again, Arwin's notes are renamed word by word. No request goes
 * to the routine, so a run of taps costs nothing. Never fails the rename.
 */
export async function refreshNotesAfterRename(
  ctx: NotesContext,
  meetingId: string,
  moved?: ReadonlyMap<string, string>,
): Promise<void> {
  await refreshAfterSpeakerChange(ctx, meetingId, moved);
}
