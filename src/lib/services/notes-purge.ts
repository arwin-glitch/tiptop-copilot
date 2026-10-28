import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { recordAudit } from '@/lib/security/audit';
import { NOTES_LIMITS, type Meeting } from '@/lib/types/notes';
import { purgeExpiredVoices } from './voice-profiles';

/**
 * The Kraken Notes clean-up (D-076), run by the daily job:
 *   - a meeting in the trash longer than NOTES_LIMITS.trashDays (7) is
 *     deleted with everything under it: transcript lines, voices,
 *     participants, notes, share links and its consent log;
 *   - a voice identifier a year past its last use is deleted (Texas Bus. &
 *     Com. Code 503.001), its consent left on file.
 * Before the Kraken Notes migration there is nothing to clean, and that is
 * not an error.
 */

export interface PurgeResult {
  meetings: number;
  voices: number;
}

const DAY_MS = 86_400_000;

export async function purgeNotes(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<PurgeResult> {
  try {
    const cutoff = new Date(now.getTime() - NOTES_LIMITS.trashDays * DAY_MS).toISOString();
    const trashed = (await store.list('meetings', organizationId, {
      notNull: ['deleted_at'],
      lt: { deleted_at: cutoff },
    })) as Meeting[];
    for (const meeting of trashed) {
      const where = { eq: { meeting_id: meeting.id } };
      // Lines before voices: each line points at its voice.
      await store.removeWhere('transcript_segments', organizationId, where);
      await store.removeWhere('meeting_speakers', organizationId, where);
      await store.removeWhere('meeting_participants', organizationId, where);
      await store.removeWhere('note_share_links', organizationId, where);
      await store.removeWhere('meeting_consent_log', organizationId, where);
      await store.removeWhere('meeting_notes', organizationId, {
        eq: { provider: 'copilot', external_id: meeting.id },
      });
      await store.remove('meetings', organizationId, meeting.id);
    }
    const voices = await purgeExpiredVoices(store, organizationId, now);
    if (trashed.length || voices) {
      await recordAudit(store, {
        organizationId,
        userId: null,
        action: 'notes.purged',
        entityType: 'organization',
        entityId: organizationId,
        metadata: { meetings: trashed.length, voices },
      });
    }
    return { meetings: trashed.length, voices };
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error))
      return { meetings: 0, voices: 0 };
    throw error;
  }
}
