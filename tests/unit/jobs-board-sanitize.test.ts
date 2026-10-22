import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  descriptionSummary,
  htmlToStructuredText,
  parseStructuredText,
  plainToStructuredText,
} from '@/lib/jobs-board/sanitize';

/** Job descriptions as the board stores them: plain structured text, never HTML. */

describe('htmlToStructuredText', () => {
  it('keeps headings, paragraphs, line breaks and lists', () => {
    const html =
      '<h2>About us</h2><p>We build <a href="https://x.example">tools</a>.<br>Fast.</p><ul><li>One</li><li><b>Two</b></li></ul><p>End</p>';
    expect(htmlToStructuredText(html)).toBe(
      '## About us\n\nWe build tools.\nFast.\n\n- One\n- Two\n\nEnd',
    );
  });

  it('drops scripts, styles, iframes, forms, images and comments whole', () => {
    const html =
      '<p>Hi</p><script>steal()</script><style>p{}</style><iframe src="x"></iframe><form><input></form><img src="https://t.example/p.gif" onerror="x()"><!-- secret --><svg><text>svg</text></svg>';
    const out = htmlToStructuredText(html);
    expect(out).toBe('Hi');
  });

  it('never lets markup through, even broken or encoded twice', () => {
    expect(htmlToStructuredText('<p>a <scr<script>ipt>alert(1)</script> b</p>')).not.toMatch(
      /<script/i,
    );
    expect(htmlToStructuredText('&lt;p&gt;Encoded &amp;amp; fine&lt;/p&gt;')).toBe(
      'Encoded & fine',
    );
    // A stray "<" in text stays text.
    expect(htmlToStructuredText('<p>5 < 6 and 7 > 3</p>')).toBe('5 ‹ 6 and 7 > 3');
  });

  it('reads a bold-only paragraph as a heading', () => {
    expect(htmlToStructuredText('<p><strong>Requirements:</strong></p><ul><li>SQL</li></ul>')).toBe(
      '## Requirements\n\n- SQL',
    );
  });

  it('removes zero-width and direction-control characters', () => {
    expect(htmlToStructuredText('<p>a\u200bb\u202ec</p>')).toBe('abc');
  });

  it('caps long descriptions at a block boundary', () => {
    const html = Array.from(
      { length: 400 },
      (_, i) => `<p>Paragraph number ${i} with some words.</p>`,
    ).join('');
    const out = htmlToStructuredText(html, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty and non-string input', () => {
    expect(htmlToStructuredText('')).toBe('');
    expect(htmlToStructuredText(null)).toBe('');
    expect(htmlToStructuredText(undefined)).toBe('');
  });
});

describe('plainToStructuredText and parseStructuredText', () => {
  it('turns typed bullets into list items and keeps headings', () => {
    const text = plainToStructuredText(
      'Intro line\n\n## What you do\n• Build\n* Ship\n- Learn\n\nThanks',
    );
    expect(text).toBe('Intro line\n\n## What you do\n\n- Build\n- Ship\n- Learn\n\nThanks');
    expect(parseStructuredText(text)).toEqual([
      { kind: 'paragraph', text: 'Intro line' },
      { kind: 'heading', text: 'What you do' },
      { kind: 'list', items: ['Build', 'Ship', 'Learn'] },
      { kind: 'paragraph', text: 'Thanks' },
    ]);
  });

  it('decodes entities once and ignores the marker characters in typed text', () => {
    expect(decodeEntities('&amp;lt; &#x41; &#9; &bogus;')).toBe('&lt; A  &bogus;');
    expect(plainToStructuredText('\u0002Not a heading')).toBe('Not a heading');
  });

  it('summarises the first paragraph', () => {
    expect(descriptionSummary('## Title\n\nFirst words here.\n\nSecond.')).toBe(
      'First words here.',
    );
    expect(descriptionSummary(`${'word '.repeat(80)}`, 50).length).toBeLessThanOrEqual(50);
    expect(descriptionSummary(null)).toBe('');
  });
});
