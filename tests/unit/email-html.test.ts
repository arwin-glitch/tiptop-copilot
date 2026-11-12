import { describe, expect, it } from 'vitest';
import { cidsIn, hasRichHtml, sanitizeEmailHtml, withInlineImages } from '@/lib/email/email-html';

/** Emails shown as the sender laid them out, made safe first. Fictional senders. */

describe('email html: cleaning', () => {
  it('keeps layout, links and images', () => {
    const html =
      '<table><tr><td style="border-right:2px solid #036"><img src="cid:logo.123@mail" alt="Harbor Labs"></td>' +
      '<td><b>Dana Holt</b><br><a href="https://harbor.example">harbor.example</a></td></tr></table>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('strips everything that could run', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="steal()">Hi</p><script>alert(1)</script><iframe src="https://x.example"></iframe>' +
        '<a href="javascript:alert(1)">x</a><img src="data:text/html;base64,AAAA"><form><input></form>' +
        '<meta http-equiv="refresh" content="0;url=https://x.example"><div style="width:expression(alert(1))">y</div>',
    );
    expect(out).not.toMatch(
      /script|iframe|onclick|javascript:|data:text|<form|<input|<meta|expression\(/i,
    );
    expect(out).toContain('<p>Hi</p>');
  });

  it('keeps pasted images inline', () => {
    const png = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(sanitizeEmailHtml(png)).toBe(png);
  });
});

describe('email html: images inside the email', () => {
  it('finds and points cid images at Kraken', () => {
    const html = '<img src="cid:image001.png@01DB">  <img src=\'cid:sig%20logo\'>';
    expect([...cidsIn(html)]).toEqual(['image001.png@01DB', 'sig logo']);
    expect(
      withInlineImages(html, (cid) =>
        cid === 'image001.png@01DB' ? '/api/inbox/attachment?a=1' : null,
      ),
    ).toBe('<img src="/api/inbox/attachment?a=1">  <img src=\'cid:sig%20logo\'>');
  });

  it('shows plain text when the html is only wrapped text', () => {
    expect(hasRichHtml('Just some words')).toBe(false);
    expect(hasRichHtml('<div>Hi<br>there</div>')).toBe(true);
  });
});
