import { describe, expect, it } from 'vitest';
import { linksIn, namesIn } from '@/lib/services/task-context';

/** What a task page pulls out of a task's own words. Fictional names and links. */

describe('task page: names in a task', () => {
  it('finds the people and companies a task names, title first', () => {
    expect(namesIn('Reply to Dana Holt on Brightwave seed intro', null)).toEqual([
      'Dana Holt',
      'Brightwave',
    ]);
    expect(
      namesIn(
        'Confirm or pay Ledgerline invoice INV00123 ($1,200.00)',
        'Owed since the Sep 8 1:1. Nick wanted to check it.',
      ),
    ).toEqual(['Ledgerline']);
  });
});

describe('task page: links in a task', () => {
  it('names DocSend, documents and other links, once each', () => {
    expect(
      linksIn(
        'Deck at https://docsend.com/view/abc123, notes https://docs.google.com/document/d/x/edit. ' +
          'Also https://perks.example.vc and https://docsend.com/view/abc123',
      ),
    ).toEqual([
      { kind: 'docsend', url: 'https://docsend.com/view/abc123', label: 'DocSend' },
      { kind: 'doc', url: 'https://docs.google.com/document/d/x/edit', label: 'Document' },
      { kind: 'link', url: 'https://perks.example.vc/', label: 'perks.example.vc' },
    ]);
  });
});
