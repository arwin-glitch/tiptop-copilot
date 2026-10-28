import type { CrmNote } from '@/lib/types/domain';

/**
 * Who may change which CRM note, as one rule the service enforces and the
 * pages explain.
 *
 * Pure and dependency-free, so the side panel, the profile and the service
 * all say the same thing: a note written in Kraken can be edited or deleted
 * by any member; a note that came from Affinity cannot while the daily
 * Affinity sync still runs, because the sync rewrites it from Affinity on the
 * next change there and an edit made here would quietly vanish.
 */

/** Why a note cannot be changed, in words for the reader; null when it can. */
export function crmNoteLockReason(
  note: Pick<CrmNote, 'source'>,
  affinitySyncOn: boolean,
): string | null {
  if (note.source === 'copilot') return null;
  if (!affinitySyncOn) return null;
  return 'From Affinity: read-only while the daily Affinity sync runs, which would overwrite a change made here. Add a note of your own instead.';
}

/** Whether a note can be edited or deleted now. */
export function crmNoteEditable(note: Pick<CrmNote, 'source'>, affinitySyncOn: boolean): boolean {
  return crmNoteLockReason(note, affinitySyncOn) === null;
}
