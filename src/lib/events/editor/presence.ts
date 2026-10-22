import type { PresenceEntry } from '@/lib/events/contracts';

/**
 * Advisory soft locks (D-075). When someone else focused a section and was
 * active in the last 20 s, that section shows "Morgan is editing" and its
 * inputs go read-only with an "Edit anyway" button. Owners may override at
 * once; outside editors after 60 s with no typing from the other person.
 * Locks are advisory only: the per-key rev check on the server is the real
 * guard, so a stale or crashed tab can never block anyone. Pure.
 */

export const OUTSIDER_OVERRIDE_AFTER_MS = 60_000;

export interface SoftLock {
  /** The person holding the section. */
  by: PresenceEntry;
  canOverride: boolean;
  /** Seconds until an outside editor may override, when they cannot yet. */
  overrideInSeconds: number | null;
}

/**
 * Remembers, per person and section, when they were last seen typing (or
 * first seen focusing it), across polls. One per Studio.
 */
export class PresenceTracker {
  private lastEditing = new Map<string, number>();

  observe(presence: readonly PresenceEntry[], now: number = Date.now()): void {
    const seen = new Set<string>();
    for (const p of presence) {
      if (!p.focusedSectionId) continue;
      const key = `${p.actorKey}|${p.focusedSectionId}`;
      seen.add(key);
      if (p.typing || !this.lastEditing.has(key)) this.lastEditing.set(key, now);
    }
    for (const key of [...this.lastEditing.keys()])
      if (!seen.has(key)) this.lastEditing.delete(key);
  }

  lastEditingAt(actorKey: string, sectionId: string): number | null {
    return this.lastEditing.get(`${actorKey}|${sectionId}`) ?? null;
  }
}

/** Who else is in a section right now (active, focused on it), most recent first. */
export function othersIn(
  sectionId: string,
  presence: readonly PresenceEntry[],
  selfKey: string,
): PresenceEntry[] {
  return presence.filter(
    (p) => p.actorKey !== selfKey && p.active && p.focusedSectionId === sectionId,
  );
}

export function softLockFor(
  sectionId: string | null,
  presence: readonly PresenceEntry[],
  self: { actorKey: string; owner: boolean },
  tracker: PresenceTracker,
  overridden: ReadonlySet<string>,
  now: number = Date.now(),
): SoftLock | null {
  if (!sectionId || overridden.has(sectionId)) return null;
  const [by] = othersIn(sectionId, presence, self.actorKey);
  if (!by) return null;
  if (self.owner) return { by, canOverride: true, overrideInSeconds: null };
  const last = tracker.lastEditingAt(by.actorKey, sectionId) ?? now;
  const waited = now - last;
  return waited >= OUTSIDER_OVERRIDE_AFTER_MS
    ? { by, canOverride: true, overrideInSeconds: null }
    : {
        by,
        canOverride: false,
        overrideInSeconds: Math.ceil((OUTSIDER_OVERRIDE_AFTER_MS - waited) / 1000),
      };
}

/** "Morgan", or "Morgan (outside)". */
export function presenceName(p: Pick<PresenceEntry, 'name' | 'outside'>): string {
  return p.outside ? `${p.name} (outside)` : p.name;
}

/** Up to two initials for an avatar. */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/[–—-].*$/, '')
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
