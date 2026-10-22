import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { orderedSections } from './schema';

/**
 * Section order as fractional-index keys (base62 strings that sort
 * lexicographically). A move rewrites ONE key, so two people reordering
 * different sections never collide, and a concurrent move of the same section
 * is last-writer-wins on that one key (see merge.ts).
 *
 * Pure and isomorphic: Studio computes a key optimistically, the server
 * re-checks it and recomputes on a collision.
 */

/** A key strictly between two keys; null means the start / the end. */
export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** n keys in order between two keys (starter docs, duplicating a page). */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  return generateNKeysBetween(before, after, n);
}

/**
 * The key for a section placed right after `afterId` (null: at the top) in
 * the current order. An unknown afterId puts it at the end.
 */
export function keyAfter(
  sections: readonly { id: string; position: string }[],
  afterId: string | null,
): string {
  const ordered = orderedSections(sections);
  if (afterId === null) return keyBetween(null, ordered[0]?.position ?? null);
  const index = ordered.findIndex((s) => s.id === afterId);
  if (index < 0) return keyBetween(ordered.at(-1)?.position ?? null, null);
  return keyBetween(ordered[index]!.position, ordered[index + 1]?.position ?? null);
}

/** Whether a key is free (no other section holds it). */
export function positionFree(
  sections: readonly { id: string; position: string }[],
  position: string,
  exceptId?: string,
): boolean {
  return !sections.some((s) => s.position === position && s.id !== exceptId);
}
