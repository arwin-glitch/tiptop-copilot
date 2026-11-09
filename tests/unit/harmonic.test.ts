import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Harmonic in Ctrl+K: people and companies nobody has met yet. Harmonic is a
 * fake here; every name and id is fictional.
 */

let key: string | undefined = 'test-key';
vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, env: () => ({ ...actual.env(), harmonicApiKey: key }) };
});

const { harmonicProfile, harmonicTypeahead, parseHarmonicUrn, resetHarmonicCache } =
  await import('@/lib/integrations/harmonic');

const calls: { url: string; apikey: string | null }[] = [];

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  key = 'test-key';
  calls.length = 0;
  resetHarmonicCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, apikey: new Headers(init.headers).get('apikey') });
      const type = new URL(url).searchParams.get('search_type');
      if (url.includes('/search/typeahead')) {
        return respond({
          count: 1,
          results:
            type === 'PERSON'
              ? [{ entity_urn: 'urn:harmonic:person:41', text: 'Rena Voss', alt_text: 'CEO' }]
              : [{ entity_urn: 'urn:harmonic:company:7', text: 'Brightlane', alt_text: '' }],
        });
      }
      if (url.endsWith('/persons/41')) {
        return respond({
          full_name: 'Rena Voss',
          headline: 'Building Brightlane',
          location: { city: 'Austin', state: 'Texas', country: 'United States' },
          socials: { LINKEDIN: { url: 'https://www.linkedin.com/in/rena-voss-example' } },
          experience: [
            { title: 'CEO', company_name: 'Brightlane', is_current_position: true },
            { title: 'PM', company_name: 'Oldco', end_date: '2020-01-01' },
          ],
        });
      }
      return respond({}, 404);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('Harmonic search', () => {
  it('reads URNs and refuses anything else', () => {
    expect(parseHarmonicUrn('urn:harmonic:person:41')).toEqual({ kind: 'person', id: '41' });
    expect(parseHarmonicUrn('urn:harmonic:person:../x')).toBeNull();
    expect(parseHarmonicUrn('https://example.com')).toBeNull();
  });

  it('finds people and companies, sending the key only in the apikey header', async () => {
    const hits = await harmonicTypeahead('ren');
    expect(hits).toEqual([
      { kind: 'person', id: '41', name: 'Rena Voss', sub: 'CEO' },
      { kind: 'company', id: '7', name: 'Brightlane', sub: null },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.apikey === 'test-key')).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://api.harmonic.ai/search/typeahead?'))).toBe(
      true,
    );
    expect(calls.some((c) => c.url.includes('test-key'))).toBe(false);
  });

  it('asks Harmonic once for the same query within ten minutes', async () => {
    await harmonicTypeahead('ren', { now: 0 });
    await harmonicTypeahead('REN', { now: 60_000 });
    expect(calls).toHaveLength(2);
  });

  it('does nothing without a key', async () => {
    key = undefined;
    expect(await harmonicTypeahead('ren')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('turns a refusal into an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond({ error: 'no' }, 401)),
    );
    expect(await harmonicTypeahead('ren')).toEqual([]);
  });

  it('reads a person profile, current roles only', async () => {
    const p = await harmonicProfile('person', '41');
    expect(p).toMatchObject({
      name: 'Rena Voss',
      headline: 'Building Brightlane',
      location: 'Austin, Texas, United States',
      linkedin: 'https://www.linkedin.com/in/rena-voss-example',
      lines: ['CEO at Brightlane'],
    });
    expect(await harmonicProfile('person', '../etc')).toBeNull();
  });
});
