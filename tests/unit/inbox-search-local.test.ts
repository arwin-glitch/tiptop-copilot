import { describe, expect, it } from 'vitest';
import { matchLoadedRows, mergeThreads } from '@/components/inbox/inbox-search';
import type { LiveThreadRow } from '@/lib/services/inbox-live';

const row = (
  id: string,
  who: string,
  subject: string,
  snippet = '',
  kind?: LiveThreadRow['kind'],
) => ({ id, who, subject, snippet, kind }) as LiveThreadRow;

const ROWS = [
  row('a1', 'Avery Lane', 'Northwind GTM plan', 'draft attached'),
  row('a2', 'GTMnow by Example', 'Weekly digest', 'compute deals'),
  row('a3', 'Sam Ortiz', 'Lunch?', 'see you there'),
  row('a4', 'Draft', 'gtm notes', '', 'draft'),
];

describe('matchLoadedRows', () => {
  it('matches sender, subject or preview, every word, any case', () => {
    expect(matchLoadedRows(ROWS, 'gtm').map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(matchLoadedRows(ROWS, 'GTM plan').map((r) => r.id)).toEqual(['a1']);
    expect(matchLoadedRows(ROWS, 'compute').map((r) => r.id)).toEqual(['a2']);
  });

  it('leaves Gmail syntax to Gmail and skips drafts', () => {
    expect(matchLoadedRows(ROWS, 'from:avery')).toEqual([]);
    expect(matchLoadedRows(ROWS, 'notes')).toEqual([]);
  });
});

describe('mergeThreads', () => {
  it('keeps loaded matches first, adds Gmail results once each, at most six', () => {
    const merged = mergeThreads(
      [ROWS[0]!, ROWS[1]!],
      [
        ROWS[1]!,
        row('b1', 'X', 'y'),
        row('b2', 'X', 'y'),
        row('b3', 'X', 'y'),
        row('b4', 'X', 'y'),
        row('b5', 'X', 'y'),
      ],
    );
    expect(merged.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'b3', 'b4']);
  });
});
