import { describe, expect, it } from 'vitest';
import {
  cleanDomain,
  faviconUrl,
  filterTab,
  harmonicHitToResult,
  highlightSegments,
  isValidDomain,
  logoDomainOf,
  nextTab,
  normalizePreviewCard,
  previewKeyOf,
  queryWords,
  readHarmonicAnswer,
  tabCounts,
  type Result,
} from '@/components/shell/search/palette-model';

const row = (kind: Result['kind'], extra: Partial<Result> = {}): Result => ({
  kind,
  label: `Row ${kind}`,
  sub: null,
  href: '/x',
  ...extra,
});

describe('highlightSegments', () => {
  it('bolds every query word, case-insensitively, merging overlaps', () => {
    expect(highlightSegments('Acme Rockets', ['ac', 'rock'])).toEqual([
      { text: 'Ac', match: true },
      { text: 'me ', match: false },
      { text: 'Rock', match: true },
      { text: 'ets', match: false },
    ]);
    expect(highlightSegments('banana', ['ana', 'nan'])).toEqual([
      { text: 'b', match: false },
      { text: 'anana', match: true },
    ]);
  });

  it('keeps markup-looking text as plain text', () => {
    const segs = highlightSegments('<b>x</b>', ['x']);
    expect(segs.map((s) => s.text).join('')).toBe('<b>x</b>');
  });

  it('splits the query into unique lowercase words', () => {
    expect(queryWords('  Jane  DOE jane ')).toEqual(['jane', 'doe']);
  });
});

describe('tabs', () => {
  const rows = [
    row('crm_company'),
    row('deal'),
    row('person'),
    row('harmonic_person'),
    row('crm_list'),
    row('meeting'),
    row('crm_note'),
    row('lookup'),
    row('harmonic_lookup'),
  ];

  it('files each kind under its tabs', () => {
    expect(filterTab(rows, 'companies').map((r) => r.kind)).toEqual(['crm_company', 'deal']);
    expect(filterTab(rows, 'people').map((r) => r.kind)).toEqual(['person', 'harmonic_person']);
    expect(filterTab(rows, 'notes').map((r) => r.kind)).toEqual(['meeting', 'crm_note']);
    expect(filterTab(rows, 'top')).toHaveLength(rows.length);
  });

  it('never counts the look-up rows', () => {
    const counts = tabCounts(rows);
    expect(counts.top).toBe(7);
    expect(counts.deals).toBe(1);
    expect(counts.meetings).toBe(1);
    expect(counts.lists).toBe(1);
  });

  it('cycles both ways', () => {
    expect(nextTab('top', 1)).toBe('companies');
    expect(nextTab('top', -1)).toBe('meetings');
  });
});

describe('domains and logos', () => {
  it('validates strictly', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('a.b.example.co')).toBe(true);
    expect(isValidDomain('javascript:alert(1)')).toBe(false);
    expect(isValidDomain('exa mple.com')).toBe(false);
    expect(isValidDomain('example.com/x')).toBe(false);
    expect(isValidDomain('localhost')).toBe(false);
  });

  it('cleans URLs and emails to a host', () => {
    expect(cleanDomain('https://www.Example.com/about')).toBe('example.com');
    expect(cleanDomain('jane@example.org')).toBe('example.org');
    expect(cleanDomain('not a domain')).toBeNull();
  });

  it('builds the favicon URL only for a valid domain', () => {
    expect(faviconUrl('example.com')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    );
    expect(faviconUrl('"><script>')).toBeNull();
  });

  it('takes a company logo from its domain, never a person', () => {
    expect(logoDomainOf(row('crm_company', { domain: 'example.com' }))).toBe('example.com');
    expect(logoDomainOf(row('crm_company', { sub: 'example.io • Fintech' }))).toBe('example.io');
    expect(logoDomainOf(row('person', { domain: 'example.com' }))).toBeNull();
  });
});

describe('previewKeyOf', () => {
  it('uses the server key when given', () => {
    expect(previewKeyOf(row('deal', { preview: { kind: 'x', key: 'y' } }))).toEqual({
      kind: 'x',
      key: 'y',
    });
  });

  it('derives CRM, mail, portfolio and deal keys', () => {
    expect(previewKeyOf(row('crm_person', { recordId: 'rec1' }))).toEqual({
      kind: 'crm',
      key: 'rec1',
    });
    expect(
      previewKeyOf(row('person', { href: '/network?tab=people&source=mail&q=jane%40example.com' })),
    ).toEqual({ kind: 'mail', key: 'jane@example.com' });
    expect(previewKeyOf(row('portfolio', { href: '/portfolio/p-1' }))).toEqual({
      kind: 'portfolio',
      key: 'p-1',
    });
    expect(previewKeyOf(row('deal', { href: '/deals/d-9' }))).toEqual({ kind: 'deal', key: 'd-9' });
  });

  it('has none for other rows', () => {
    expect(previewKeyOf(row('task', { href: '/tasks' }))).toBeNull();
    expect(previewKeyOf(row('lookup', { href: 'https://www.google.com/search?q=x' }))).toBeNull();
  });
});

describe('normalizePreviewCard', () => {
  const card = {
    kind: 'company',
    title: 'Acme Rockets',
    subtitle: 'Space',
    logoDomain: 'acme.example',
    status: { label: 'Losing touch', tone: 'warn' },
    counts: [{ label: 'Notes', value: 3 }, { label: 'bad' }],
    lastContact: { at: '2026-01-02T00:00:00Z', text: 'Email from Jane' },
    links: [
      { label: 'Site', href: 'https://acme.example', external: true },
      { label: 'Evil', href: 'javascript:alert(1)', external: true },
    ],
    openHref: '/network/companies/1',
    source: 'kraken',
  };

  it('accepts bare, {preview} and {ok, preview}', () => {
    for (const body of [card, { preview: card }, { ok: true, preview: card }]) {
      const out = normalizePreviewCard(body);
      expect(out?.title).toBe('Acme Rockets');
      expect(out?.status).toEqual({ label: 'Losing touch', tone: 'warn' });
      expect(out?.counts).toEqual([{ label: 'Notes', value: 3 }]);
      expect(out?.links.map((l) => l.label)).toEqual(['Site']);
    }
  });

  it('rejects failures and shapes without a title', () => {
    expect(normalizePreviewCard({ ok: false, error: {} })).toBeNull();
    expect(normalizePreviewCard({ ok: true, preview: { id: 'x', name: 'Old shape' } })).toBeNull();
    expect(normalizePreviewCard(null)).toBeNull();
  });
});

describe('Harmonic answers', () => {
  it('maps hits to in-app rows with a Harmonic preview key', () => {
    const r = harmonicHitToResult({
      kind: 'investor',
      id: '42',
      name: 'Example Capital',
      website: 'https://example.vc',
    });
    expect(r).toMatchObject({
      kind: 'harmonic_company',
      href: '/network/harmonic?q=Example%20Capital',
      domain: 'example.vc',
      preview: { kind: 'harmonic_company', key: '42' },
      origin: 'harmonic',
    });
  });

  it('turns itself off when not connected or used up', () => {
    expect(readHarmonicAnswer(200, { ok: true, hits: [], remaining: 50 }).off).toBe(false);
    expect(readHarmonicAnswer(429, {}).off).toBe(true);
    expect(readHarmonicAnswer(200, { ok: false, connected: false }).off).toBe(true);
    expect(readHarmonicAnswer(200, { ok: false, code: 'RATE_LIMITED' }).off).toBe(true);
    const last = readHarmonicAnswer(200, {
      ok: true,
      remaining: 0,
      hits: [{ kind: 'person', id: '1', name: 'Jane Example' }],
    });
    expect(last.off).toBe(true);
    expect(last.hits).toHaveLength(1);
  });
});
