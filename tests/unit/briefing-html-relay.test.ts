import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  assembleBriefingHtml,
  parseBriefingHtmlPart,
  prepareBriefingHtml,
} from '@/lib/briefing/html-relay';

const PAGE =
  '<!doctype html><html><head><title>Morning Brief</title></head><body><main>Brief</main></body></html>';

function relay(html: string, opts: { run: string; kind?: string; date?: string; size?: number }) {
  const b64 = gzipSync(html).toString('base64');
  const size = opts.size ?? b64.length;
  const pieces = b64.match(new RegExp(`.{1,${size}}`, 'g'))!;
  return pieces.map((gz_b64, i) => ({
    text: `BRIEFING_HTML_V1\n\`${JSON.stringify({
      kind: opts.kind ?? 'morning',
      date_key: opts.date ?? '2026-09-30',
      run: opts.run,
      part: i + 1,
      parts: pieces.length,
      gz_b64,
    })}\``,
  }));
}

describe('briefing page relay', () => {
  it('reassembles pieces posted in any order', () => {
    const messages = relay(PAGE, { run: 'r1', size: 40 }).reverse();
    expect(assembleBriefingHtml(messages, 'morning', '2026-09-30')).toBe(PAGE);
  });

  it('takes the newest complete run and never mixes two runs', () => {
    const older = relay(PAGE.replace('Brief<', 'Old<'), { run: 'r1', size: 40 });
    const newer = relay(PAGE.replace('Brief<', 'New<'), { run: 'r2', size: 40 });
    // Slack returns newest first; the newer run is missing a piece.
    const html = assembleBriefingHtml(
      [...newer.slice(1).reverse(), ...older.reverse()],
      'morning',
      '2026-09-30',
    );
    expect(html).toContain('Old<');
    expect(html).not.toContain('New<');
  });

  it('ignores other kinds, other days, and garbage', () => {
    const messages = [
      ...relay(PAGE, { run: 'r', kind: 'dossier' }),
      ...relay(PAGE, { run: 'r', date: '2026-09-29' }),
      {
        text: 'BRIEFING_HTML_V1\n`{"kind":"morning","date_key":"2026-09-30","run":"x","part":1,"parts":1,"gz_b64":"not base64!"}`',
      },
    ];
    expect(assembleBriefingHtml(messages, 'morning', '2026-09-30')).toBeNull();
    expect(parseBriefingHtmlPart('hello')).toBeNull();
  });

  it('strips scripts, refreshes and base tags and adds the print bar with the nonce', () => {
    const out = prepareBriefingHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><script>alert(1)</script></head><body class="x"><p>Hi</p><script src="https://cdn.example/x.js"></script></body></html>',
      'NONCE123',
    );
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('cdn.example');
    expect(out).not.toContain('http-equiv');
    expect(out).not.toContain('<base');
    expect(out).toContain('<body class="x">\n<div id="copilot-bar"');
    expect(out).toContain('<script nonce="NONCE123">');
    expect(out.match(/<script/g)).toHaveLength(1);
  });
});
