import { speakerDisplayName } from '@/lib/speakers/ladder';
import type { ActionItem, Meeting, MeetingSpeaker } from '@/lib/types/notes';

/**
 * A meeting's voices as the notes name them (D-076): the name the People tab
 * shows, the address when known, and whether it is the principal's (Nick's)
 * own voice, whose promises are flagged. Pure and client-safe.
 */

export interface AssemblySpeaker {
  name: string;
  email: string | null;
  /** The principal's (Nick's) own voice. */
  isPrincipal: boolean;
}

/** Each voice as the notes name it, the principal's own flagged; a merged voice reads as the one it joined. */
export function assemblySpeakers(
  speakers: readonly MeetingSpeaker[],
  meeting: Pick<Meeting, 'recorded_by'>,
  team: { principalId: string | null; principalEmail: string | null },
): Map<string, AssemblySpeaker> {
  const byKey = new Map(speakers.map((s) => [s.cluster_key, s]));
  const isPrincipal = (s: MeetingSpeaker): boolean => {
    if (team.principalId && s.user_id === team.principalId) return true;
    if (team.principalEmail && s.person_email?.toLowerCase() === team.principalEmail) return true;
    // No principal known: the recorder's own mic stands in.
    return (
      !team.principalId &&
      s.cluster_key === 'mic' &&
      s.source === 'channel' &&
      s.user_id === meeting.recorded_by
    );
  };
  const out = new Map<string, AssemblySpeaker>();
  for (const s of speakers) {
    const target = s.merged_into ? (byKey.get(s.merged_into) ?? s) : s;
    out.set(s.cluster_key, {
      name: speakerDisplayName(target),
      email: target.person_email,
      isPrincipal: isPrincipal(target),
    });
  }
  return out;
}

/**
 * Action items after a voice was renamed, split or merged: the same items,
 * with each owner read again from the voices as they are now. No model call.
 */
export function reownActionItems(
  items: readonly ActionItem[],
  speakers: ReadonlyMap<string, AssemblySpeaker>,
  moved: ReadonlyMap<string, string> = new Map(),
): ActionItem[] {
  return items.map((item) => {
    const key = item.ownerClusterKey
      ? (moved.get(item.ownerClusterKey) ?? item.ownerClusterKey)
      : null;
    const owner = key ? speakers.get(key) : undefined;
    if (!key || !owner) return item;
    return {
      ...item,
      ownerClusterKey: key,
      ownerName: owner.name,
      ownerEmail: owner.email,
      isPrincipalPromise: owner.isPrincipal,
    };
  });
}

/**
 * The names that changed: each item's owner as the notes wrote it against the
 * name its voice carries now, and every "Guest N" a voice has since been named
 * from. What the routine wrote can then be renamed in place, with no new
 * request (lib/notes/bridge-protocol.ts renameInBlocks).
 */
export function renamedVoices(
  before: readonly ActionItem[],
  after: readonly ActionItem[],
  speakers: readonly MeetingSpeaker[],
): Map<string, string> {
  const renames = new Map<string, string>();
  const byKey = new Map(speakers.map((s) => [s.cluster_key, s]));
  for (const s of speakers) {
    const target = s.merged_into ? (byKey.get(s.merged_into) ?? s) : s;
    const now = speakerDisplayName(target);
    const placeholder = `Guest ${s.guest_number}`;
    if (s.guest_number !== null && now !== placeholder) renames.set(placeholder, now);
  }
  after.forEach((item, i) => {
    const old = before[i];
    if (old?.ownerName && item.ownerName && old.ownerName !== item.ownerName) {
      renames.set(old.ownerName, item.ownerName);
    }
  });
  return renames;
}
