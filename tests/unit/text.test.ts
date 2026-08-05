import { describe, expect, it } from 'vitest';
import {
  corporateEmailDomain,
  emailDomain,
  htmlToPlainText,
  initials,
  isFreeEmailDomain,
  normalizeCompanyName,
  normalizeDomain,
  snippet,
  tokenOverlap,
  truncate,
} from '@/lib/util/text';

/**
 * These helpers decide whether two records are the same company and what text
 * a model is shown. A regression here is quiet and expensive, so the edge
 * cases are pinned rather than sampled.
 */

describe('normalizeCompanyName', () => {
  it('strips legal suffixes so the same company matches itself', () => {
    expect(normalizeCompanyName('Vetrix, Inc.')).toBe('vetrix');
    expect(normalizeCompanyName('Vetrix LLC')).toBe('vetrix');
    expect(normalizeCompanyName('Vetrix Technologies Ltd')).toBe('vetrix');
    expect(normalizeCompanyName('Vetrix Labs')).toBe('vetrix');
  });

  it('strips the trendy suffixes too', () => {
    expect(normalizeCompanyName('Girder AI')).toBe('girder');
    expect(normalizeCompanyName('Girder.io')).toBe('girder');
  });

  it('folds punctuation, case and accents', () => {
    expect(normalizeCompanyName('  LoomStack!!  ')).toBe('loomstack');
    expect(normalizeCompanyName('Café Ops')).toBe('cafe ops');
    expect(normalizeCompanyName("O'Brien & Sons")).toBe('o brien sons');
  });

  it('keeps distinct companies distinct', () => {
    expect(normalizeCompanyName('Girder AI')).not.toBe(normalizeCompanyName('Plumbline'));
  });

  it('does not strip a suffix that is part of a word', () => {
    expect(normalizeCompanyName('Incline')).toBe('incline');
    expect(normalizeCompanyName('Cobalt')).toBe('cobalt');
  });
});

describe('normalizeDomain', () => {
  it('reduces a URL to its bare host', () => {
    expect(normalizeDomain('https://www.vetrix.demo/pricing?utm=x#top')).toBe('vetrix.demo');
    expect(normalizeDomain('HTTP://Vetrix.Demo:8443/')).toBe('vetrix.demo');
    expect(normalizeDomain('vetrix.demo.')).toBe('vetrix.demo');
  });

  it('keeps a subdomain, which is a different host', () => {
    expect(normalizeDomain('app.vetrix.demo')).toBe('app.vetrix.demo');
  });

  it('returns null for anything that is not a host', () => {
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });
});

describe('email domains', () => {
  it('extracts the domain from an address', () => {
    expect(emailDomain('priya@vetrix.demo')).toBe('vetrix.demo');
    expect(emailDomain('odd+tag@mail.vetrix.demo')).toBe('mail.vetrix.demo');
    expect(emailDomain('not-an-address')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });

  it('refuses to treat a free provider as a company domain', () => {
    expect(isFreeEmailDomain('gmail.com')).toBe(true);
    expect(isFreeEmailDomain('GMAIL.COM')).toBe(true);
    expect(isFreeEmailDomain('vetrix.demo')).toBe(false);

    expect(corporateEmailDomain('priya@gmail.com')).toBeNull();
    expect(corporateEmailDomain('priya@proton.me')).toBeNull();
    expect(corporateEmailDomain('priya@vetrix.demo')).toBe('vetrix.demo');
  });
});

describe('htmlToPlainText', () => {
  it('drops scripts and styles entirely', () => {
    const html = '<style>p{color:red}</style><script>steal()</script><p>Hello</p>';
    const text = htmlToPlainText(html);
    expect(text).not.toContain('steal()');
    expect(text).not.toContain('color:red');
    expect(text).toBe('Hello');
  });

  it('turns block elements into line breaks rather than running words together', () => {
    expect(htmlToPlainText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(htmlToPlainText('First<br>Second')).toBe('First\nSecond');
  });

  it('marks list items', () => {
    expect(htmlToPlainText('<ul><li>A</li><li>B</li></ul>')).toContain('• A');
  });

  it('decodes the entities that actually appear in email', () => {
    expect(htmlToPlainText('a&nbsp;&amp;&nbsp;b')).toBe('a & b');
    expect(htmlToPlainText('&lt;tag&gt; &quot;q&quot; &#39;s&#39;')).toBe(`<tag> "q" 's'`);
    expect(htmlToPlainText('&#8212;')).toBe('—');
  });

  it('leaves no angle brackets from markup behind', () => {
    expect(htmlToPlainText('<div class="x"><span>Hi</span></div>')).toBe('Hi');
  });

  it('collapses excessive blank lines', () => {
    expect(htmlToPlainText('<p>A</p><p></p><p></p><p></p><p>B</p>')).toBe('A\n\nB');
  });
});

describe('truncate and snippet', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('never exceeds the requested length, suffix included', () => {
    const out = truncate('a'.repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('accepts a custom suffix', () => {
    expect(truncate('abcdefghij', 6, '...')).toBe('abc...');
  });

  it('collapses whitespace for a list-view snippet', () => {
    expect(snippet('line one\n\n  line   two')).toBe('line one line two');
  });
});

describe('initials', () => {
  it('uses the first and last name', () => {
    expect(initials('Nick Moore')).toBe('NM');
    expect(initials('Priya Raman Gupta')).toBe('PG');
  });

  it('falls back sensibly for one word or none', () => {
    expect(initials('Vetrix')).toBe('VE');
    expect(initials('   ')).toBe('?');
  });
});

describe('tokenOverlap', () => {
  it('is 1 for identical token sets and 0 for disjoint ones', () => {
    expect(tokenOverlap('construction estimating', 'construction estimating')).toBe(1);
    expect(tokenOverlap('veterinary practice', 'freight brokerage')).toBe(0);
  });

  it('normalises against the smaller set, so a subset scores high', () => {
    expect(tokenOverlap('plumbline', 'plumbline construction estimating')).toBe(1);
  });

  it('ignores tokens of three characters or fewer', () => {
    // "ai" and "of" carry no signal and must not create a match.
    expect(tokenOverlap('ai of', 'ai of')).toBe(0);
  });

  it('returns 0 rather than dividing by zero on empty input', () => {
    expect(tokenOverlap('', 'anything')).toBe(0);
    expect(tokenOverlap('anything', '')).toBe(0);
  });
});
