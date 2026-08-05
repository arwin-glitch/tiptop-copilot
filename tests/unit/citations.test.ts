import { describe, expect, it } from 'vitest';
import {
  CitationRegistry,
  citationHref,
  citationLabel,
  citationProvenance,
} from '@/lib/ai/citations';
import type { Citation } from '@/lib/types/domain';

/**
 * Invariant 8: no fabricated citations. A model-supplied source id that was
 * never in the prompt is dropped and reported — it never reaches the UI, where
 * it would make a wrong answer look sourced.
 */

function citation(over: Partial<Citation> & { id: string }): Citation {
  return {
    kind: 'email',
    ref_id: 'msg-1',
    label: 'Intro: Vetrix',
    page: null,
    section: null,
    url: null,
    occurred_at: '2026-08-01T12:00:00.000Z',
    retrieved_at: null,
    publisher: 'priya@vetrix.demo',
    excerpt: 'Vetrix does vertical AI for veterinary practices.',
    ...over,
  };
}

describe('resolve', () => {
  it('drops an unknown source id and reports it', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:msg-1' }));

    const { citations, invalid } = registry.resolve([
      { source_id: 'email:msg-1', page: null, quote: null },
      { source_id: 'email:does-not-exist', page: null, quote: null },
      { source_id: 'document:invented', page: 3, quote: 'a plausible-sounding quote' },
    ]);

    expect(citations.map((c) => c.id)).toEqual(['email:msg-1']);
    expect(invalid).toEqual(['email:does-not-exist', 'document:invented']);
  });

  it('returns nothing when every id is fabricated', () => {
    const registry = new CitationRegistry();
    const { citations, invalid } = registry.resolve([
      { source_id: 'email:ghost', page: null, quote: 'looks real' },
    ]);
    expect(citations).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  it('ignores null, undefined and empty refs without counting them as invalid', () => {
    const registry = new CitationRegistry();
    const { citations, invalid } = registry.resolve([
      null,
      undefined,
      { source_id: '', page: null, quote: null },
    ]);
    expect(citations).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  it('does not let the model attach a page to a source that has no pages', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:msg-1', kind: 'email' }));

    const { citations } = registry.resolve([{ source_id: 'email:msg-1', page: 4, quote: null }]);
    // An email cannot suddenly acquire page 4.
    expect(citations[0]?.page).toBeNull();
  });

  it('accepts a model-supplied page for a paged source that has none of its own', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'attachment:a1', kind: 'attachment', page: null }));

    const { citations } = registry.resolve([{ source_id: 'attachment:a1', page: 4, quote: null }]);
    expect(citations[0]?.page).toBe(4);
  });

  it("prefers the source's own page over the model's claim", () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'attachment:a1:p2', kind: 'attachment', page: 2 }));

    const { citations } = registry.resolve([
      { source_id: 'attachment:a1:p2', page: 9, quote: null },
    ]);
    expect(citations[0]?.page).toBe(2);
  });

  it('deduplicates repeated refs but keeps distinct pages of the same document', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'attachment:a1', kind: 'attachment', page: null }));

    const { citations } = registry.resolve([
      { source_id: 'attachment:a1', page: 1, quote: null },
      { source_id: 'attachment:a1', page: 1, quote: 'again' },
      { source_id: 'attachment:a1', page: 5, quote: null },
    ]);
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.page)).toEqual([1, 5]);
  });

  it("uses the model's quote as the excerpt when it supplies one", () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:msg-1', excerpt: 'stored excerpt' }));

    const { citations } = registry.resolve([
      { source_id: 'email:msg-1', page: null, quote: '$340K ARR across 22 clinics' },
    ]);
    expect(citations[0]?.excerpt).toBe('$340K ARR across 22 clinics');
  });

  it('falls back to the stored excerpt when no quote is given', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:msg-1', excerpt: 'stored excerpt' }));

    const { citations } = registry.resolve([{ source_id: 'email:msg-1', page: null, quote: null }]);
    expect(citations[0]?.excerpt).toBe('stored excerpt');
  });

  it('validIds is resolve() with the invalid ids already discarded', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:msg-1' }));
    expect(
      registry.validIds([
        { source_id: 'email:msg-1', page: null, quote: null },
        { source_id: 'email:ghost', page: null, quote: null },
      ]),
    ).toEqual(['email:msg-1']);
  });
});

describe('registry bookkeeping', () => {
  it('reports what it holds so a prompt can list available ids', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:a' }));
    registry.add(citation({ id: 'deal:b', kind: 'deal' }));

    expect(registry.ids()).toEqual(['email:a', 'deal:b']);
    expect(registry.has('email:a')).toBe(true);
    expect(registry.has('email:zzz')).toBe(false);
    expect(registry.get('deal:b')?.kind).toBe('deal');
    expect(registry.all()).toHaveLength(2);
  });

  it('re-adding the same id replaces rather than duplicates', () => {
    const registry = new CitationRegistry();
    registry.add(citation({ id: 'email:a', label: 'first' }));
    registry.add(citation({ id: 'email:a', label: 'second' }));
    expect(registry.all()).toHaveLength(1);
    expect(registry.get('email:a')?.label).toBe('second');
  });
});

describe('citationHref', () => {
  it('routes every citation kind to a real in-app location', () => {
    expect(citationHref(citation({ id: 'e', kind: 'email', ref_id: 'm1' }))).toBe(
      '/inbox?message=m1',
    );
    expect(citationHref(citation({ id: 'e', kind: 'email_thread', ref_id: 't1' }))).toBe(
      '/inbox?thread=t1',
    );
    expect(citationHref(citation({ id: 'a', kind: 'attachment', ref_id: 'a1' }))).toBe(
      '/inbox?attachment=a1',
    );
    expect(citationHref(citation({ id: 'd', kind: 'deal', ref_id: 'd1' }))).toBe('/deals/d1');
    expect(citationHref(citation({ id: 'p', kind: 'prior_decision', ref_id: 'd1' }))).toBe(
      '/deals/d1?tab=decisions',
    );
    expect(citationHref(citation({ id: 'c', kind: 'calendar_event', ref_id: 'e1' }))).toBe(
      '/today?event=e1',
    );
    expect(citationHref(citation({ id: 'u', kind: 'portfolio_update', ref_id: 'u1' }))).toBe(
      '/portfolio?update=u1',
    );
    expect(citationHref(citation({ id: 'n', kind: 'note', ref_id: 'd1' }))).toBe(
      '/deals/d1?tab=notes',
    );
  });

  it('includes the page for a document citation', () => {
    expect(citationHref(citation({ id: 'x', kind: 'document', ref_id: 'doc1', page: 7 }))).toBe(
      '/knowledge?document=doc1&page=7',
    );
  });

  it('escapes an id containing url-significant characters', () => {
    expect(citationHref(citation({ id: 'x', kind: 'deal', ref_id: 'a b&c' }))).toBe(
      '/deals/a%20b%26c',
    );
  });

  it('sends a web citation to its own url', () => {
    expect(citationHref(citation({ id: 'w', kind: 'web', url: 'https://example.test/a' }))).toBe(
      'https://example.test/a',
    );
  });
});

describe('labels and provenance', () => {
  it('appends page and section to the label when present', () => {
    expect(citationLabel(citation({ id: 'x', label: 'Deck', page: 4, section: 'Traction' }))).toBe(
      'Deck · p.4 · Traction',
    );
    expect(citationLabel(citation({ id: 'x', label: 'Deck' }))).toBe('Deck');
  });

  it('describes where an item came from without inventing a date', () => {
    expect(citationProvenance(citation({ id: 'x', kind: 'email' }))).toContain('2026-08-01');
    expect(citationProvenance(citation({ id: 'x', kind: 'email', occurred_at: null }))).toBe(
      'Email',
    );
    expect(
      citationProvenance(citation({ id: 'x', kind: 'web', occurred_at: null, publisher: null })),
    ).toContain('publication date unknown');
  });
});
