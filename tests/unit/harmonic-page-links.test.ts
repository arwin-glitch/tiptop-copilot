import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Harmonic's free MCP look-ups are capped at 100 a day per person, so Ctrl+K
 * may only offer a row that opens Kraken's own look-up page (one call, on
 * click), never call Harmonic per keystroke. The page draws provider links,
 * so it must only ever render http(s) URLs, in a new tab without an opener.
 */
const root = join(__dirname, '..', '..');
const palette = readFileSync(join(root, 'src/components/shell/command-palette.tsx'), 'utf8');
const page = readFileSync(join(root, 'src/app/(app)/network/harmonic/page.tsx'), 'utf8');

describe('Ctrl+K Harmonic row', () => {
  it('opens the in-app look-up page, first among the look-up rows', () => {
    const body = palette.slice(palette.indexOf('function lookupRows'));
    const rows = body.slice(0, body.indexOf('\n}\n'));
    expect(rows).toContain("kind: 'harmonic_lookup'");
    expect(rows).toContain('href: `/network/harmonic?q=${words}`');
    expect(rows.indexOf('harmonic_lookup')).toBeLessThan(rows.indexOf('linkedin.com'));
    expect(rows).not.toContain('console.harmonic.ai');
  });

  it('has a label and is navigated in-app, not remembered', () => {
    expect(palette).toContain("harmonic_lookup: 'Harmonic'");
    expect(palette).toContain("if (result.kind !== 'harmonic_lookup') remember(result);");
  });

  it('does not call Harmonic from the palette', () => {
    expect(palette).not.toMatch(/harmonic-mcp|harmonicLookup/);
  });
});

describe('/network/harmonic page', () => {
  it('runs the look-up only from ?q=', () => {
    expect(page).toContain('harmonicLookup(getStore(), auth.organizationId, q)');
  });

  it('renders provider links only through the http(s) guard', () => {
    expect(page).toContain("url.protocol === 'https:' || url.protocol === 'http:'");
    expect(page).toContain('safeHttpUrl(hit.linkedin)');
    expect(page).toContain('safeHttpUrl(hit.website)');
    expect(page).not.toMatch(/href=\{hit\./);
  });

  it('opens every external link in a new tab without an opener', () => {
    const anchors = page.match(/<a\b[^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it('explains each failure plainly', () => {
    expect(page).toContain('/settings?tab=integrations');
    expect(page).toContain('100 free Harmonic look-ups are used up');
    expect(page).toContain('couldn&apos;t answer just now');
    expect(page).toContain('Harmonic found nobody matching');
  });
});
