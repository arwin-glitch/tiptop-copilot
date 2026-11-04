import { describe, expect, it } from 'vitest';
import {
  buildGmailQuery,
  EMPTY_SEARCH,
  folderQuery,
  pageLabel,
  parseCategory,
  parseDensity,
  parseFolder,
  parseGmailQuery,
  senderLine,
  smartDate,
} from '@/lib/email/inbox-folders';

describe('folders', () => {
  it('reads every system folder and a user label, and nothing else', () => {
    expect(parseFolder('trash')).toBe('trash');
    expect(parseFolder('label:Label_12')).toBe('label:Label_12');
    expect(parseFolder('label:SPAM')).toBeNull();
    expect(parseFolder('label:Label_<script>')).toBeNull();
    expect(parseFolder('nonsense')).toBeNull();
    expect(parseFolder(null)).toBeNull();
    expect(parseCategory('social')).toBe('social');
    expect(parseCategory('bogus')).toBe('primary');
  });

  it("asks Gmail for each folder the way Gmail's own folders read", () => {
    expect(folderQuery('inbox', 'primary')).toEqual({ labelIds: ['INBOX'], q: 'category:primary' });
    expect(folderQuery('inbox', 'promotions')).toEqual({
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    });
    expect(folderQuery('spam')).toEqual({ labelIds: ['SPAM'], includeSpamTrash: true });
    expect(folderQuery('trash')).toEqual({ labelIds: ['TRASH'], includeSpamTrash: true });
    expect(folderQuery('all')).toEqual({ labelIds: [] });
    expect(folderQuery('label:Label_7')).toEqual({ labelIds: ['Label_7'] });
    // Kraken's own lists and Drafts are not a Gmail thread query.
    expect(folderQuery('snoozed')).toBeNull();
    expect(folderQuery('scheduled')).toBeNull();
    expect(folderQuery('drafts')).toBeNull();
  });
});

describe('advanced search', () => {
  it('writes Gmail query syntax, grouping several words in parentheses', () => {
    expect(
      buildGmailQuery({
        ...EMPTY_SEARCH,
        from: 'jane@example.test',
        to: 'sam lee',
        subject: 'q3 update',
        hasWords: 'budget',
        doesntHave: 'draft memo',
        hasAttachment: true,
      }),
    ).toBe(
      'from:jane@example.test to:(sam lee) subject:(q3 update) has:attachment budget -draft -memo',
    );
  });

  it('turns "date within" into after/before around a date, or newer_than without one', () => {
    expect(buildGmailQuery({ ...EMPTY_SEARCH, within: '1w', date: '2026-11-10' })).toBe(
      'after:2026/11/03 before:2026/11/18',
    );
    expect(buildGmailQuery({ ...EMPTY_SEARCH, within: '3d' })).toBe('newer_than:3d');
  });

  it('drops characters that would break the query, and returns nothing for an empty form', () => {
    expect(buildGmailQuery(EMPTY_SEARCH)).toBe('');
    expect(buildGmailQuery({ ...EMPTY_SEARCH, from: ' "a)" ' })).toBe('from:a');
  });

  it('reads a typed query back into the form', () => {
    const form = parseGmailQuery('from:jane subject:(q3 update) has:attachment budget -memo');
    expect(form).toMatchObject({
      from: 'jane',
      subject: 'q3 update',
      hasAttachment: true,
      hasWords: 'budget',
      doesntHave: 'memo',
    });
  });
});

describe('rows', () => {
  const zone = 'America/Chicago';
  const now = new Date('2026-11-04T18:00:00Z'); // noon in Chicago

  it('dates a row like Gmail: time today, day this year, full date before', () => {
    expect(smartDate('2026-11-04T15:04:00Z', zone, now)).toBe('9:04 AM');
    expect(smartDate('2026-11-03T15:00:00Z', zone, now)).toBe('Nov 3');
    expect(smartDate('2024-03-02T15:00:00Z', zone, now)).toBe('Mar 2, 2024');
    expect(smartDate(null, zone, now)).toBe('');
    expect(smartDate('not a date', zone, now)).toBe('');
  });

  it("reads today in the reader's zone, not UTC", () => {
    // 2am UTC on the 5th is still the 4th in Chicago.
    expect(smartDate('2026-11-05T02:00:00Z', zone, new Date('2026-11-05T03:00:00Z'))).toBe(
      '8:00 PM',
    );
  });

  it('writes the pager line', () => {
    expect(pageLabel(1, 50, 1234)).toBe('1–50 of 1,234');
    expect(pageLabel(51, 12, 62)).toBe('51–62 of 62');
    expect(pageLabel(1, 50, null)).toBe('1–50 of many');
    expect(pageLabel(1, 0, 0)).toBe('No conversations');
  });

  it('writes the sender line with "me" and the count', () => {
    expect(senderLine([{ name: 'Jordan Vale', me: false }])).toEqual({
      names: 'Jordan Vale',
      count: 0,
    });
    expect(
      senderLine([
        { name: 'Jordan Vale', me: false },
        { name: 'Nick', me: true },
        { name: 'Jordan Vale', me: false },
      ]),
    ).toEqual({ names: 'Jordan, me', count: 3 });
    expect(
      senderLine([
        { name: 'Ana Ito', me: false },
        { name: 'Bo Park', me: false },
        { name: 'Cy Lee', me: false },
        { name: 'Nick', me: true },
      ]).names,
    ).toBe('Ana .. Cy, me');
  });

  it('remembers only a known density', () => {
    expect(parseDensity('compact')).toBe('compact');
    expect(parseDensity('huge')).toBe('default');
    expect(parseDensity(null)).toBe('default');
  });
});
