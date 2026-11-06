import { describe, expect, it } from 'vitest';
import type { RelationshipIndex } from '@/lib/network/evidence';
import { mailPeopleMatching, squash } from '@/lib/services/search';

/**
 * Ctrl+K finds people from the mail and calendar, as Affinity does, and a
 * spaced query meets a joined name ("Bright Fund" finds "BrightFund").
 * Every name and address here is fictional.
 */

function entry(name: string | null, threads: number, meetings = 0) {
  return {
    threads: new Set(Array.from({ length: threads }, (_, i) => `t${i}`)),
    meetings: new Set(Array.from({ length: meetings }, (_, i) => i)),
    names: new Map(name ? [[name, 1]] : []),
  };
}

const index = {
  own: new Set(['partner@fund.example']),
  threads: new Map(),
  meetings: [],
  byAddress: new Map([
    ['partner@fund.example', entry('Pat Partner', 50)],
    ['dana@brightfund.example', entry('Dana Reyes', 3, 1)],
    ['lee@brightfund.example', entry('Lee Ortiz', 9)],
    ['noreply@brightfund.example', entry(null, 20)],
    ['wes.tonner@acme.example', entry('Wes Tonner', 1)],
  ]),
  byDomain: new Map(),
  scanned: { messages: 0, events: 0, oldestMessageAt: null },
  builtAt: 0,
} as unknown as RelationshipIndex;

describe('Ctrl+K people from the mail', () => {
  it('squashes spaces and dots so spaced and joined names meet', () => {
    expect(squash('Bright Fund')).toBe('brightfund');
    expect(squash('bright.fund')).toBe('brightfund');
  });

  it('finds people by a spaced company name, strongest first, never the fund or a robot', () => {
    const hits = mailPeopleMatching(index, 'Bright Fund');
    expect(hits.map((h) => h.email)).toEqual(['lee@brightfund.example', 'dana@brightfund.example']);
  });

  it('puts a name match ahead of a stronger address match', () => {
    const hits = mailPeopleMatching(index, 'Dana');
    expect(hits[0]).toMatchObject({ email: 'dana@brightfund.example', threads: 3, meetings: 1 });
  });

  it('finds someone emailed only once, by first name', () => {
    expect(mailPeopleMatching(index, 'wes').map((h) => h.name)).toEqual(['Wes Tonner']);
  });

  it('ignores a query shorter than two letters', () => {
    expect(mailPeopleMatching(index, ' a ')).toEqual([]);
  });
});
