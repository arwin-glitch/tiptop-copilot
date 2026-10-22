import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import {
  mergePlainText,
  parseRichText,
  renderRichText,
  richTextToPlain,
} from '@/lib/events/richtext';

const html = (source: string, options?: Parameters<typeof renderRichText>[1]) =>
  renderToStaticMarkup(createElement(Fragment, null, renderRichText(source, options)));

describe('event rich text', () => {
  it('renders the campaign grammar as React elements', () => {
    const out = html('Hello **bold** and *soft* words.\nNext line.\n\n- one\n- two\n\n1. first');
    expect(out).toContain(
      '<p>Hello <strong>bold</strong> and <em>soft</em> words.<br/>Next line.</p>',
    );
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol><li>first</li></ol>');
  });

  it('adds ## and ### headings under the section heading, and quotes', () => {
    const out = html('## The plan\nText\n\n### Details\n> A line\n> continued');
    expect(out).toContain('<h3 class="ev-rt-h">The plan</h3>');
    expect(out).toContain('<h4 class="ev-rt-h">Details</h4>');
    expect(out).toContain('<blockquote><p>A line continued</p></blockquote>');
    expect(html('## Big', { headingLevel: 2 })).toContain('<h2');
  });

  it('links only to http(s) and mailto, opening safely', () => {
    const out = html('[Site](https://example.com/a) and [mail](mailto:host@example.com)');
    expect(out).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">Site</a>',
    );
    expect(out).toContain('href="mailto:host@example.com"');
    const bad = html('[x](javascript:alert(1)) [y](data:text/html,hi)');
    expect(bad).not.toContain('<a');
    expect(bad).toContain('[x](javascript:alert(1))');
  });

  it('never renders markup from the source', () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> **<b>x</b>**');
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(out).toContain('&lt;script&gt;');
  });

  it('fills merge fields with the viewer, else the fallback, and keeps values literal', () => {
    expect(html('Hi {{first_name|friend}}!')).toContain('Hi friend!');
    expect(html('Hi {{first_name|friend}}!', { merge: { first_name: 'Sarah' } })).toContain(
      'Hi Sarah!',
    );
    const evil = html('Hi {{name}}', { merge: { name: '**Bob** [x](https://evil.example)' } });
    expect(evil).not.toContain('<strong>');
    expect(evil).not.toContain('<a');
    expect(evil).toContain('**Bob**');
  });

  it('renders inert links in Studio', () => {
    const out = html('[Site](https://example.com)', { inertLinks: true });
    expect(out).toContain('data-inert-link=""');
    expect(out).not.toContain('target=');
  });

  it('flattens to plain text for summaries and cards', () => {
    expect(richTextToPlain('## Title\n**Bold** {{first_name|you}}\n\n- a\n- b')).toBe(
      'Title\nBold you\na · b',
    );
    expect(parseRichText('')).toEqual([]);
    expect(renderRichText('   ')).toBeNull();
  });

  it('personalises plain-text fields like headlines', () => {
    expect(mergePlainText("{{first_name|Friend}}, you're invited", { first_name: 'Sarah' })).toBe(
      "Sarah, you're invited",
    );
    expect(mergePlainText("{{first_name|Friend}}, you're invited", {})).toBe(
      "Friend, you're invited",
    );
    expect(mergePlainText('{{unknown}} stays', {})).toBe('{{unknown}} stays');
  });
});
