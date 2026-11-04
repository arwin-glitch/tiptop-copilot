/**
 * The weekly bars on a profile's Activity tab: how many emails, meetings and
 * meeting notes fell in each of the last `weeks` weeks, oldest first. Pure.
 */
export const ACTIVITY_WEEKS = 12;
const WEEK_MS = 7 * 86_400_000;

export function weeklyCounts(
  items: readonly { at: string }[],
  now: Date,
  weeks: number = ACTIVITY_WEEKS,
): number[] {
  const counts = Array.from({ length: weeks }, () => 0);
  for (const item of items) {
    const age = now.getTime() - Date.parse(item.at);
    if (!(age >= 0)) continue;
    const week = Math.floor(age / WEEK_MS);
    if (week < weeks) counts[weeks - 1 - week]! += 1;
  }
  return counts;
}
