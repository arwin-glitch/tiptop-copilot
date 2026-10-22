import 'server-only';
import { refreshAfterSpeakerChange, regenerateIfStale } from '@/lib/services/notes-generate';
import type { NotesContext } from '@/lib/services/notes';
import { afterResponse } from './background';

/**
 * After a voice is renamed, split or merged (D-076): action-item owners are
 * read again at once, and the notes are rewritten with the new names, a
 * model's notes after the route has answered. Never fails the rename.
 */
export async function refreshNotesAfterRename(
  ctx: NotesContext,
  meetingId: string,
  moved?: ReadonlyMap<string, string>,
): Promise<void> {
  const refreshed = await refreshAfterSpeakerChange(ctx, meetingId, moved);
  if (refreshed.ok && refreshed.value.regenerate) {
    await afterResponse('rewrite the notes with the new names', () =>
      regenerateIfStale(ctx, meetingId),
    );
  }
}
