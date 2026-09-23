import { describe, expect, it } from 'vitest';
import {
  inline,
  repairBrokenLinks,
  safeHref,
  segText,
  stripFooters,
  toBlocks,
} from '@/lib/updates/mrkdwn';

/**
 * Slack mrkdwn -> segments. The whitelist is the security boundary for the
 * Updates tab: a link reaches the page only with an https, http or mailto
 * href, and everything else is text. All text here is invented.
 */

describe('inline text', () => {
  it('decodes entities, including the double-escaped ampersand routines post', () => {
    expect(segText(inline('Q&amp;A &lt;draft&gt; &amp;amp; more'))).toBe('Q&A <draft> & more');
  });

  it('parses bold, italic, code and strike', () => {
    expect(inline('*bold* _italic_ `co_d*e*` ~gone~')).toEqual([
      { text: 'bold', bold: true },
      { text: ' ' },
      { text: 'italic', italic: true },
      { text: ' ' },
      { text: 'co_d*e*', code: true },
      { text: ' ' },
      { text: 'gone', strike: true },
    ]);
  });

  it('nests emphasis', () => {
    expect(inline('*_both_* and *bold _inner_ end*')).toEqual([
      { text: 'both', bold: true, italic: true },
      { text: ' and ' },
      { text: 'bold ', bold: true },
      { text: 'inner', bold: true, italic: true },
      { text: ' end', bold: true },
    ]);
  });

  it('never reads snake_case names or arithmetic as emphasis', () => {
    expect(inline('snake_case_name and 2*3*4')).toEqual([{ text: 'snake_case_name and 2*3*4' }]);
  });

  it('reads emphasis right after a tilde meaning "about"', () => {
    expect(inline('about ~_$2M_ raised')).toEqual([
      { text: 'about ~' },
      { text: '$2M', italic: true },
      { text: ' raised' },
    ]);
  });

  it('does not apply emphasis or emoji inside code', () => {
    expect(inline('`*x* :warning:`')).toEqual([{ text: '*x* :warning:', code: true }]);
  });

  it('maps known emoji, keeps unknown shortcodes and drops skin tones', () => {
    expect(segText(inline(':warning: :foo_bar: :wave::skin-tone-2: :lock:'))).toBe(
      '⚠️ :foo_bar: 👋 🔒',
    );
  });

  it('renders mentions and channel references as plain text', () => {
    expect(segText(inline('<@U123> <@U123|pat> <#C1|general> <#C2> <!here>'))).toBe(
      '@member @pat #general #channel @here',
    );
    expect(inline('<@U123|pat>')[0]?.href).toBeUndefined();
  });

  it('shows a date token by its fallback text', () => {
    expect(segText(inline('Due <!date^1790000000^{date_short}|Sep 30>'))).toBe('Due Sep 30');
  });
});

describe('links', () => {
  it('keeps an https link with a normalised href and its label', () => {
    expect(inline('<https://a.example/x|Deck>')).toEqual([
      { text: 'Deck', href: 'https://a.example/x' },
    ]);
  });

  it('labels a mailto link with its address', () => {
    expect(inline('<mailto:x@y.example>')).toEqual([
      { text: 'x@y.example', href: 'mailto:x@y.example' },
    ]);
    expect(inline('<mailto:x@y.example|x@y.example>')).toEqual([
      { text: 'x@y.example', href: 'mailto:x@y.example' },
    ]);
  });

  it('allows plain http and shows host and path when there is no label', () => {
    expect(inline('<http://a.example>')).toEqual([
      { text: 'a.example', href: 'http://a.example/' },
    ]);
    expect(segText(inline('<https://a.example/some/path/>'))).toBe('a.example/some/path');
  });

  it('decodes an escaped ampersand in a URL before checking it', () => {
    expect(inline('<https://a.example/?a=1&amp;b=2|Open>')[0]?.href).toBe(
      'https://a.example/?a=1&b=2',
    );
  });

  const REJECTED = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript&amp;#58;alert(1)',
    'java\tscript:alert(1)',
    'java%09script:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,hello',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'slack://open',
    '//evil.example',
    'relative/path',
    'https://user:pw@evil.example',
    'mailto:nobody',
  ];

  it.each(REJECTED)('renders %j as its label, never as a link', (target) => {
    const segs = inline(`<${target}|label>`);
    expect(segs).toEqual([{ text: 'label' }]);
  });

  it.each(REJECTED)('safeHref refuses %j', (target) => {
    expect(safeHref(target.replace('&amp;', '&'))).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
  });

  it('repairs a link broken across the Ledger line', () => {
    const fixed = repairBrokenLinks(
      'Link: <https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000009\nLedger|mail.google.com/mail?authuser=demo@example.com#…>: 0f00000000000009',
    );
    const [linkLine, ledgerLine] = fixed.split('\n');
    const link = inline(linkLine ?? '').find((s) => s.href);
    expect(link?.href).toBe(
      'https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000009',
    );
    expect(link?.href).not.toMatch(/\s/);
    expect(ledgerLine).toBe('Ledger: 0f00000000000009');
  });

  it('never autolinks a bare domain', () => {
    expect(inline('see docs.example/view/1')).toEqual([{ text: 'see docs.example/view/1' }]);
  });

  it('keeps a link inside bold text', () => {
    expect(inline('*<https://a.example|Deck>*')).toEqual([
      { text: 'Deck', href: 'https://a.example/', bold: true },
    ]);
  });
});

describe('blocks', () => {
  it('reads bullets, depths, numbering, labels and paragraphs', () => {
    const blocks = toBlocks(
      [
        '• top',
        '◦ nested',
        '    • indented',
        '- after a bullet',
        '→ arrow line',
        '1. first',
        '_2. Second name_',
        '*Label:*',
        'Para line one',
        'Para line two',
        '',
        '- lone dash',
        'Key takeaways:',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { type: 'bullet', depth: 0, segs: [{ text: 'top' }] },
      { type: 'bullet', depth: 1, segs: [{ text: 'nested' }] },
      { type: 'bullet', depth: 1, segs: [{ text: 'indented' }] },
      { type: 'bullet', depth: 1, segs: [{ text: 'after a bullet' }] },
      { type: 'bullet', depth: 1, segs: [{ text: '→ arrow line' }] },
      { type: 'numbered', n: 1, segs: [{ text: 'first' }] },
      { type: 'numbered', n: 2, segs: [{ text: 'Second name' }] },
      { type: 'label', segs: [{ text: 'Label' }] },
      { type: 'para', lines: [[{ text: 'Para line one' }], [{ text: 'Para line two' }]] },
      { type: 'bullet', depth: 0, segs: [{ text: 'lone dash' }] },
      { type: 'label', segs: [{ text: 'Key takeaways' }] },
    ]);
  });

  it('numbers an item whose number sits inside the name’s emphasis', () => {
    expect(toBlocks('_3. Lantern Row_ — Direct SAFE\nA short description.')).toEqual([
      {
        type: 'numbered',
        n: 3,
        segs: [{ text: 'Lantern Row', italic: true }, { text: ' — Direct SAFE' }],
      },
      { type: 'para', lines: [[{ text: 'A short description.' }]] },
    ]);
  });

  it('treats ruler lines as breaks, not text', () => {
    expect(toBlocks('one\n========================================\ntwo')).toEqual([
      { type: 'para', lines: [[{ text: 'one' }]] },
      { type: 'para', lines: [[{ text: 'two' }]] },
    ]);
  });
});

describe('footers', () => {
  it.each([
    '_Sent using_ Claude',
    '*Sent using* Claude',
    '_Sent using Claude_',
    'Sent using Claude',
  ])('strips %j', (footer) => {
    expect(stripFooters(`Body line\n${footer}\n`)).toEqual({ text: 'Body line', hadFooter: true });
  });

  it('strips two stacked footers', () => {
    expect(stripFooters('Body\n_Sent using_ Claude\n*Sent using* Claude')).toEqual({
      text: 'Body',
      hadFooter: true,
    });
  });

  it('reports when there was none', () => {
    expect(stripFooters('Just text\n\n')).toEqual({ text: 'Just text', hadFooter: false });
  });
});

describe('hostile input', () => {
  it('survives emphasis nested thousands deep, and keeps real nesting', () => {
    const deep = `${'*'.repeat(8000)}x${'*'.repeat(8000)}`;
    expect(() => inline(deep)).not.toThrow();
    expect(() => toBlocks(`• ${'*_~'.repeat(900)}x${'~_*'.repeat(900)}`)).not.toThrow();
    expect(inline('*_~both~_*')).toEqual([
      { text: 'both', bold: true, italic: true, strike: true },
    ]);
  });

  it('reads a huge line in linear time', () => {
    const started = Date.now();
    toBlocks(`a${' '.repeat(30_000)}b`);
    toBlocks('(*a '.repeat(8_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
