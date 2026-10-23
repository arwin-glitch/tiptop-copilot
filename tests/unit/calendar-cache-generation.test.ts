import { beforeEach, describe, expect, it } from 'vitest';
import type { GCalEvent } from '@/lib/calendar/google-types';
import {
  invalidateCalendarCache,
  readRangeEvents,
  resetCalendarRangeCache,
  type CalendarSource,
} from '@/lib/calendar/range-reader';
import { ok, type Result } from '@/lib/util/result';

/**
 * The calendar cache never keeps an answer older than a write (D-078
 * security review): a read that began before an invalidation does not store
 * what it got after it, and a `fresh` read (the booking link's check before
 * it books) asks Google again whatever is cached. Without this, a slow
 * public read could put the calendar from before the host's new meeting
 * back into the cache, and a booking would land on top of that meeting.
 */

const ORG = 'org-cache-test';
const CAL = 'host@calendar.example';
const MIN = '2026-11-03T06:00:00Z';
const MAX = '2026-11-04T06:00:00Z';

function event(id: string): GCalEvent {
  return {
    id,
    status: 'confirmed',
    summary: 'Invented meeting',
    start: { dateTime: '2026-11-03T15:00:00Z' },
    end: { dateTime: '2026-11-03T15:30:00Z' },
  };
}

/** A Google-kind provider (so the cache is on) whose range reads the test resolves by hand. */
function slowGoogle() {
  const calls: { resolve: (events: GCalEvent[]) => void }[] = [];
  const provider = {
    kind: 'google' as const,
    listRange: (): Promise<Result<GCalEvent[]>> =>
      new Promise((resolve) => {
        calls.push({ resolve: (events) => resolve(ok(events)) });
      }),
  };
  const source = {
    provider,
    integration: null,
    ownEmails: [CAL],
    demo: false,
  } as unknown as CalendarSource;
  return { calls, source };
}

beforeEach(() => resetCalendarRangeCache());

describe('the calendar cache and writes', () => {
  it('drops an answer that began before an invalidation', async () => {
    const { calls, source } = slowGoogle();
    const now = Date.now();
    const stale = readRangeEvents(source, ORG, CAL, MIN, MAX, now);
    expect(calls).toHaveLength(1);
    // The host adds a meeting: Copilot's check invalidates the cache...
    invalidateCalendarCache(ORG);
    // ...and only then does the slow read come back, with the old calendar.
    calls[0]!.resolve([]);
    expect((await stale).ok).toBe(true);
    // The next read asks Google again rather than serving the old answer.
    const next = readRangeEvents(source, ORG, CAL, MIN, MAX, now + 1);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([event('hostsnewmeeting')]);
    const read = await next;
    expect(read.ok && read.value.map((e) => e.id)).toEqual(['hostsnewmeeting']);
  });

  it('a fresh read asks Google whatever is cached, and still fills the cache', async () => {
    const { calls, source } = slowGoogle();
    const now = Date.now();
    const first = readRangeEvents(source, ORG, CAL, MIN, MAX, now);
    calls[0]!.resolve([]);
    await first;
    // Cached: a normal read does not ask again.
    const cached = await readRangeEvents(source, ORG, CAL, MIN, MAX, now + 1);
    expect(cached.ok && cached.value).toEqual([]);
    expect(calls).toHaveLength(1);
    // Fresh: asked again.
    const fresh = readRangeEvents(source, ORG, CAL, MIN, MAX, now + 2, { fresh: true });
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([event('justadded')]);
    expect((await fresh).ok).toBe(true);
    // And what it read is what the next normal read gets.
    const after = await readRangeEvents(source, ORG, CAL, MIN, MAX, now + 3);
    expect(after.ok && after.value.map((e) => e.id)).toEqual(['justadded']);
    expect(calls).toHaveLength(2);
  });
});
