import { describe, expect, it } from 'vitest';
import { fillMerge } from '@/lib/campaigns/missing-fields';
import {
  RSVP_LINK_PLACEHOLDER,
  collectLinks,
  isRsvpLinkUrl,
  mergeFieldsUsed,
  parseTemplate,
  renderHtml,
  renderText,
  rsvpLinkUsed,
} from '@/lib/campaigns/template';

/**
 * {{rsvp_link}}: the one link-valued merge field (D-075). Its address comes
 * only from the server (merge.rsvp_link, written when a guest is added from an
 * event) and must be exactly an /e/<slug>/i/<token> link. These checks hold
 * the grammar to that: it renders as a link only with a valid address, is
 * never part of the static click allowlist, cannot be typed in from the
 * review, and cannot sit inside another link.
 */

const LINK = 'https://copilot.example/e/harborview-annual-meeting/i/tok_AbCdEf0123456789';
const track = (href: string) => `https://copilot.example/t/c/TOKEN?u=${encodeURIComponent(href)}`;

describe('isRsvpLinkUrl', () => {
  it('accepts exactly an origin plus /e/<slug>/i/<token>', () => {
    expect(isRsvpLinkUrl(LINK)).toBe(true);
    expect(isRsvpLinkUrl('http://localhost:3000/e/a1/i/abcdefgh')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [
      'https://copilot.example/e/harborview/i/short',
      'https://copilot.example/e/harborview/i/tok_AbCdEf0123456789?x=1',
      'https://copilot.example/e/harborview/i/tok_AbCdEf0123456789#k',
      'https://copilot.example/e/Harborview/i/tok_AbCdEf0123456789',
      'https://copilot.example/events/harborview/i/tok_AbCdEf0123456789',
      'https://user@copilot.example/e/harborview/i/tok_AbCdEf0123456789',
      'javascript:alert(1)//e/x/i/abcdefgh',
      'https://copilot.example/e/x/i/abc/def/ghij',
      '',
      null,
      undefined,
    ]) {
      expect(isRsvpLinkUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('{{rsvp_link}} in a template', () => {
  it('parses with or without link text, and is not a text merge field', () => {
    const parsed = parseTemplate('RSVP: {{rsvp_link|RSVP here}} or {{ rsvp_link }}');
    expect(parsed.issues).toEqual([]);
    expect(parsed.blocks[0]).toEqual({
      t: 'p',
      c: [
        { t: 'text', v: 'RSVP: ' },
        { t: 'rsvp', label: 'RSVP here' },
        { t: 'text', v: ' or ' },
        { t: 'rsvp', label: null },
      ],
    });
    expect(rsvpLinkUsed('Hi {{rsvp_link|x}}')).toBe(true);
    expect(rsvpLinkUsed('Hi {{first_name}}')).toBe(false);
    expect(mergeFieldsUsed('{{rsvp_link}} {{first_name}}')).toEqual(['first_name']);
  });

  it('renders the recipient’s own link: tracked with link text, as written without', () => {
    const { blocks } = parseTemplate('{{rsvp_link|RSVP here}}\n\n{{rsvp_link}}');
    const html = renderHtml(blocks, { merge: { rsvp_link: LINK }, trackHref: track });
    expect(html).toContain(
      `<a href="${track(LINK).replace(/&/g, '&amp;')}" target="_blank">RSVP here</a>`,
    );
    // Link text that is the address goes straight there, never rewritten.
    expect(html).toContain(`<a href="${LINK}" target="_blank">${LINK}</a>`);
    expect(renderText(blocks, { merge: { rsvp_link: LINK } })).toBe(
      `RSVP here (${LINK})\n\n${LINK}`,
    );
  });

  it('shows plain words, never a link, when the recipient has no valid link', () => {
    const { blocks } = parseTemplate('{{rsvp_link|RSVP here}} and {{rsvp_link}}');
    for (const merge of [{}, { rsvp_link: 'https://evil.example/e/x/i/abcdefgh?' }]) {
      const html = renderHtml(blocks, { merge, trackHref: track });
      expect(html).toBe(`<div>RSVP here and ${RSVP_LINK_PLACEHOLDER}</div>`);
      expect(html).not.toContain('<a');
    }
  });

  it('escapes the link text', () => {
    const { blocks } = parseTemplate('{{rsvp_link|<b>RSVP</b>}}');
    expect(renderHtml(blocks, { merge: { rsvp_link: LINK } })).toContain('&lt;b&gt;RSVP&lt;/b&gt;');
  });

  it('is never in the static click allowlist', () => {
    const { blocks } = parseTemplate('[Agenda](https://tiptop.example/agenda) {{rsvp_link|RSVP}}');
    expect(collectLinks(blocks)).toEqual(['https://tiptop.example/agenda']);
  });

  it('cannot go inside a link address or another link’s text', () => {
    expect(parseTemplate('[RSVP]({{rsvp_link}})').issues).toContain(
      'A merge field cannot go inside a link address.',
    );
    const nested = parseTemplate('[Go {{rsvp_link}}](https://tiptop.example/)');
    expect(nested.issues).toContain('{{rsvp_link}} cannot go inside the text of another link.');
    expect(JSON.stringify(nested.blocks)).not.toContain('"rsvp"');
  });

  it('cannot be filled in from the review', () => {
    const typed = { rsvp_link: 'https://evil.example/' } as unknown as Record<string, string>;
    const { merge, filled } = fillMerge({}, {}, typed);
    expect(filled).toEqual([]);
    expect(merge).toEqual({});
    // A stored link survives a fill of the other fields untouched.
    expect(
      fillMerge({ rsvp_link: LINK }, { rsvp_link: LINK }, { company: 'Northwind' }).merge,
    ).toEqual({
      rsvp_link: LINK,
      company: 'Northwind',
    });
  });
});
