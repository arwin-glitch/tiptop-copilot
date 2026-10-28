import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_HREF,
  feedbackCounts,
  feedbackPageFrom,
  isFeedbackPath,
  pageTitleFrom,
  type FeedbackItem,
} from '@/lib/feedback/shared';
import {
  FEEDBACK_ALERT_PREVIEW_MAX,
  FEEDBACK_SCHEMA,
  feedbackAlertKey,
  feedbackAlertWords,
  feedbackForComputer,
} from '@/lib/services/feedback';

/**
 * In-app feedback, the pure parts (D-060): which page a note names, how its
 * title reads, and which notes may ping a computer and in what words. All
 * names, ids and notes are invented.
 */

const NOW = new Date('2026-10-21T15:00:00.000Z');
const HOUR = 3_600_000;
const SENDER = '00000000-0000-4000-8000-0000000000a1';
const READER = '00000000-0000-4000-8000-0000000000a2';

function note(n: number, over: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    id: `00000000-0000-4000-8000-00000000f00${n}`,
    text: `Note ${n}: make the due date stand out.`,
    path: '/today',
    title: 'Today',
    by: 'Avery',
    userId: SENDER,
    at: new Date(NOW.getTime() - (10 - n) * 60_000).toISOString(),
    status: 'open',
    changedAt: null,
    changedBy: null,
    ...over,
  };
}

describe('the page a note names', () => {
  it('keeps plain in-app paths with their query', () => {
    expect(isFeedbackPath('/today')).toBe(true);
    expect(isFeedbackPath('/portfolio?tab=numbers')).toBe(true);
    expect(isFeedbackPath('/deals/00000000-0000-4000-8000-000000000064')).toBe(true);
  });

  it('refuses anything that could leave the site or is not a path', () => {
    expect(isFeedbackPath('//elsewhere.example/x')).toBe(false);
    expect(isFeedbackPath('/\\elsewhere.example')).toBe(false);
    expect(isFeedbackPath('https://copilot.example/today')).toBe(false);
    expect(isFeedbackPath('today')).toBe(false);
    expect(isFeedbackPath('/to day')).toBe(false);
    expect(isFeedbackPath('/today#section')).toBe(false);
    expect(isFeedbackPath('/today\u0007')).toBe(false);
    expect(isFeedbackPath(`/${'a'.repeat(600)}`)).toBe(false);
    expect(isFeedbackPath(null)).toBe(false);
    expect(isFeedbackPath(42)).toBe(false);
  });

  it("reads the browser's location as path and query, never the fragment or origin", () => {
    expect(
      feedbackPageFrom('https://copilot.example/deals?tab=pipeline#top', 'Deals · TipTop Kraken'),
    ).toEqual({ path: '/deals?tab=pipeline', title: 'Deals' });
    expect(feedbackPageFrom('not a url', 'Today · TipTop Kraken')).toEqual({
      path: null,
      title: 'Today',
    });
  });

  it("names the page by its tab's title, without the app's suffix or a reply count", () => {
    expect(pageTitleFrom('Today · TipTop Kraken')).toBe('Today');
    expect(pageTitleFrom('(2) Follow-ups · TipTop Kraken')).toBe('Follow-ups');
    expect(pageTitleFrom('TipTop Kraken')).toBeNull();
    expect(pageTitleFrom('   ')).toBeNull();
    expect(pageTitleFrom('x'.repeat(300))).toHaveLength(200);
  });
});

describe('a note as sent', () => {
  it('is trimmed, and a page that is not plainly in-app becomes no page', () => {
    const parsed = FEEDBACK_SCHEMA.parse({
      text: '  Show the stage on each card.  ',
      path: '//elsewhere.example',
      title: '  Deals   board ',
    });
    expect(parsed).toEqual({
      text: 'Show the stage on each card.',
      path: null,
      title: 'Deals board',
    });
  });

  it('needs words, and no more than the box takes', () => {
    expect(FEEDBACK_SCHEMA.safeParse({ text: '   ' }).success).toBe(false);
    expect(FEEDBACK_SCHEMA.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
    expect(FEEDBACK_SCHEMA.safeParse({ text: 'x'.repeat(2000) }).success).toBe(true);
  });
});

describe('counting', () => {
  it('counts open and done', () => {
    expect(feedbackCounts([note(1), note(2, { status: 'done' }), note(3)])).toEqual({
      open: 2,
      done: 1,
    });
    expect(feedbackCounts([])).toEqual({ open: 0, done: 0 });
  });
});

describe('which notes ping a computer', () => {
  const caller = { userId: READER, enabledAt: new Date(NOW.getTime() - 48 * HOUR).toISOString() };

  it('takes open notes from someone else, oldest first', () => {
    const notes = [note(3), note(1), note(2)];
    expect(feedbackForComputer(notes, caller, new Set(), NOW).map((n) => n.id)).toEqual([
      note(1).id,
      note(2).id,
      note(3).id,
    ]);
  });

  it("never the computer owner's own notes, done notes, or notes it showed already", () => {
    const notes = [note(1, { userId: READER }), note(2, { status: 'done' }), note(3), note(4)];
    const sent = new Set([feedbackAlertKey(note(4).id)]);
    expect(feedbackForComputer(notes, caller, sent, NOW).map((n) => n.id)).toEqual([note(3).id]);
  });

  it('nothing from before the computer was turned on, or over a day old', () => {
    const fresh = { ...caller, enabledAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    expect(feedbackForComputer([note(1), note(9)], fresh, new Set(), NOW).map((n) => n.id)).toEqual(
      [note(9).id],
    );
    const old = note(5, { at: new Date(NOW.getTime() - 25 * HOUR).toISOString() });
    expect(feedbackForComputer([old], caller, new Set(), NOW)).toEqual([]);
  });

  it('at most ten in one notification, the newest kept', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      note(i, {
        id: `00000000-0000-4000-8000-0000000f${String(i).padStart(4, '0')}`,
        at: new Date(NOW.getTime() - (20 - i) * 60_000).toISOString(),
      }),
    );
    const picked = feedbackForComputer(many, caller, new Set(), NOW);
    expect(picked).toHaveLength(10);
    expect(picked[picked.length - 1]?.id).toBe(many[11]?.id);
  });
});

describe('the words of a feedback alert', () => {
  it('one note: who sent it and its first words, opening the list', () => {
    expect(feedbackAlertWords([note(1)])).toEqual({
      keys: [`feedback:${note(1).id}`],
      title: 'New feedback',
      body: 'Avery: Note 1: make the due date stand out.',
      url: FEEDBACK_HREF,
    });
  });

  it('several notes: one notification, the newest previewed, clipped', () => {
    const long = note(2, { text: 'word '.repeat(60), by: null });
    const words = feedbackAlertWords([note(1), long]);
    expect(words?.title).toBe('2 new feedback notes');
    expect(words?.keys).toEqual([`feedback:${note(1).id}`, `feedback:${note(2).id}`]);
    expect(words?.body.length).toBeLessThanOrEqual(FEEDBACK_ALERT_PREVIEW_MAX);
    expect(words?.body.startsWith('word word')).toBe(true);
  });

  it('nothing for no notes', () => {
    expect(feedbackAlertWords([])).toBeNull();
  });
});
