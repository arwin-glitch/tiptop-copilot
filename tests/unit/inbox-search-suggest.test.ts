import { describe, expect, it } from 'vitest';
import { demoMatches, type DemoSearchable } from '@/lib/email/demo-search';
import {
  APPLY_EXISTING_MAX,
  buildFilterBody,
  criteriaFromSearch,
  criteriaQuery,
  describeActions,
  describeCriteria,
  existingChange,
  isSafeFilterBody,
  NO_ACTIONS,
} from '@/lib/email/inbox-filters';
import { EMPTY_SEARCH } from '@/lib/email/inbox-folders';
import {
  addOperator,
  hasOperator,
  HISTORY_MAX,
  parseHistory,
  personQuery,
  pushHistory,
  QUICK_CHIPS,
  removeHistory,
} from '@/lib/email/search-suggest';

describe('search chips', () => {
  it("offers Gmail's chips with their operators", () => {
    expect(QUICK_CHIPS.map((c) => [c.label, c.operator])).toEqual([
      ['Has attachment', 'has:attachment'],
      ['Last 7 days', 'newer_than:7d'],
      ['From me', 'from:me'],
      ['Unread', 'is:unread'],
    ]);
  });

  it('adds an operator once, after what is typed', () => {
    expect(addOperator('', 'has:attachment')).toBe('has:attachment');
    expect(addOperator('  budget ', 'from:me')).toBe('budget from:me');
    expect(addOperator('budget from:me', 'from:me')).toBe('budget from:me');
    expect(hasOperator('budget IS:UNREAD', 'is:unread')).toBe(true);
    expect(hasOperator('budget', 'is:unread')).toBe(false);
  });

  it('a picked person searches mail from or to them', () => {
    expect(personQuery(' Rowan@Example.test ')).toBe(
      'from:rowan@example.test OR to:rowan@example.test',
    );
  });
});

describe('search history', () => {
  it('puts the newest first, once, at most eight', () => {
    let h: string[] = [];
    for (let i = 0; i < 10; i++) h = pushHistory(h, `q${i}`);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]).toBe('q9');
    h = pushHistory(h, 'Q5');
    expect(h[0]).toBe('Q5');
    expect(h.filter((x) => x.toLowerCase() === 'q5')).toHaveLength(1);
    expect(pushHistory(h, '   ')).toEqual(h);
    expect(removeHistory(h, 'Q5')).not.toContain('Q5');
  });

  it('reads anything stored defensively', () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory('not json')).toEqual([]);
    expect(parseHistory('{"a":1}')).toEqual([]);
    expect(parseHistory(JSON.stringify(['a', 7, 'A', ' b ', '']))).toEqual(['a', 'b']);
  });
});

const row = (over: Partial<DemoSearchable> = {}): DemoSearchable => ({
  who: 'Rowan Vale',
  subject: 'Q3 board deck',
  snippet: 'Attached is the deck',
  at: '2026-11-02T10:00:00.000Z',
  unread: true,
  starred: false,
  important: false,
  hasAttachment: true,
  people: 'rowan@lumen.example partner@demo.example rowan vale',
  senders: 'rowan@lumen.example',
  recipients: 'partner@demo.example',
  fromMe: false,
  ...over,
});
const NOW = new Date('2026-11-04T12:00:00.000Z');
const opts = { now: NOW, mailbox: 'partner@demo.example' };

describe('demo search operators', () => {
  it('matches words, chips and people the way Gmail would', () => {
    expect(demoMatches(row(), 'deck', opts)).toBe(true);
    expect(demoMatches(row(), 'has:attachment newer_than:7d is:unread', opts)).toBe(true);
    expect(demoMatches(row(), 'from:me', opts)).toBe(false);
    expect(demoMatches(row({ fromMe: true }), 'from:me', opts)).toBe(true);
    expect(demoMatches(row(), 'newer_than:1d', opts)).toBe(false);
    expect(demoMatches(row(), '-deck', opts)).toBe(false);
    expect(demoMatches(row(), 'subject:(board deck)', opts)).toBe(true);
    expect(demoMatches(row(), 'from:nobody@else.example OR to:partner@demo.example', opts)).toBe(
      true,
    );
    expect(demoMatches(row(), 'from:rowan@lumen.example OR to:rowan@lumen.example', opts)).toBe(
      true,
    );
    expect(demoMatches(row(), 'to:me', opts)).toBe(true);
    expect(demoMatches(row(), 'zzzz-no-such-mail', opts)).toBe(false);
  });
});

describe('Create filter', () => {
  const criteria = criteriaFromSearch({
    ...EMPTY_SEARCH,
    from: 'news@digest.example',
    hasWords: 'weekly',
    within: '1w',
    hasAttachment: true,
  });

  it('takes the search fields, never the date', () => {
    expect(criteria).toEqual({
      from: 'news@digest.example',
      to: '',
      subject: '',
      hasWords: 'weekly',
      doesntHave: '',
      hasAttachment: true,
    });
    expect(criteriaQuery(criteria)).toBe('from:news@digest.example has:attachment weekly');
  });

  it("builds Gmail's body from the actions, with no forward and no Trash", () => {
    const built = buildFilterBody(criteria, {
      ...NO_ACTIONS,
      skipInbox: true,
      markRead: true,
      star: true,
      label: 'Label_7',
      neverSpam: true,
      important: 'never',
      category: 'CATEGORY_UPDATES',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toEqual({
      criteria: { from: 'news@digest.example', query: 'weekly', hasAttachment: true },
      action: {
        addLabelIds: ['STARRED', 'Label_7', 'CATEGORY_UPDATES'],
        removeLabelIds: ['INBOX', 'UNREAD', 'SPAM', 'IMPORTANT'],
      },
    });
    expect(JSON.stringify(built.body)).not.toMatch(/forward|TRASH/);
    expect(isSafeFilterBody(built.body)).toBe(true);
  });

  it('refuses an empty filter and any body that forwards or deletes', () => {
    expect(buildFilterBody(criteria, NO_ACTIONS).ok).toBe(false);
    expect(
      buildFilterBody(criteriaFromSearch(EMPTY_SEARCH), { ...NO_ACTIONS, star: true }).ok,
    ).toBe(false);
    expect(
      isSafeFilterBody({
        criteria: {},
        action: { addLabelIds: ['STARRED'], forward: 'x@y.example' },
      }),
    ).toBe(false);
    expect(isSafeFilterBody({ criteria: {}, action: { addLabelIds: ['TRASH'] } })).toBe(false);
    expect(isSafeFilterBody({ criteria: {}, action: { removeLabelIds: ['SENT'] } })).toBe(false);
    expect(isSafeFilterBody({ criteria: {}, action: {} })).toBe(false);
  });

  it('applies to existing mail only what the Inbox label path may change', () => {
    expect(
      existingChange({
        ...NO_ACTIONS,
        skipInbox: true,
        neverSpam: true,
        category: 'CATEGORY_SOCIAL',
        label: 'Label_3',
        important: 'always',
      }),
    ).toEqual({ add: ['Label_3', 'IMPORTANT'], remove: ['INBOX'] });
    expect(APPLY_EXISTING_MAX).toBeLessThanOrEqual(100);
  });

  it("describes a filter in Gmail's words, honest about ones set in Gmail", () => {
    expect(describeCriteria({ from: 'a@b.example', hasAttachment: true })).toBe(
      'from:(a@b.example) has:attachment',
    );
    expect(
      describeActions(
        { addLabelIds: ['Label_7', 'TRASH'], removeLabelIds: ['INBOX'], forward: 'x@y.example' },
        new Map([['Label_7', 'Reading']]),
      ),
    ).toEqual([
      'Skip Inbox',
      'Apply label "Reading"',
      'Delete it (set in Gmail)',
      'Forwards mail (set in Gmail)',
    ]);
  });
});
