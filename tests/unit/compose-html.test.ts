import { describe, expect, it } from 'vitest';
import { isBlankHtml, sanitizeComposeHtml, textToComposeHtml } from '@/lib/email/compose-html';

describe('the compose body, made safe to send', () => {
  it("keeps Gmail's basic formatting", () => {
    const html =
      '<div><b>Bold</b> <i>it</i> <u>u</u></div><ul><li>one</li></ul><ol><li>two</li></ol><br>';
    expect(sanitizeComposeHtml(html)).toBe(html);
  });

  it('keeps an http(s) or mailto link and nothing else on it', () => {
    expect(
      sanitizeComposeHtml('<a href="https://example.test/a?b=1&c=2" onclick="x()">link</a>'),
    ).toBe('<a href="https://example.test/a?b=1&amp;c=2">link</a>');
    expect(sanitizeComposeHtml('<a href="mailto:sam@example.test">mail</a>')).toBe(
      '<a href="mailto:sam@example.test">mail</a>',
    );
    expect(sanitizeComposeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeComposeHtml('<a href=" java\nscript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('drops scripts, styles, comments, images, and every attribute', () => {
    expect(
      sanitizeComposeHtml(
        '<div style="color:red" class="x">hi<script>alert(1)</script><style>p{}</style><!-- c --><img src=x onerror=y></div>',
      ),
    ).toBe('<div>hi</div>');
  });

  it('escapes text and closes what it opened', () => {
    expect(sanitizeComposeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(sanitizeComposeHtml('&nbsp;&amp;')).toBe('&nbsp;&amp;');
    expect(sanitizeComposeHtml('<b><i>open')).toBe('<b><i>open</i></b>');
    expect(sanitizeComposeHtml('</b>stray')).toBe('stray');
    expect(sanitizeComposeHtml('<b><i>x</b>y')).toBe('<b><i>x</i></b>y');
  });

  it('knows a blank body, and writes typed text as lines', () => {
    expect(isBlankHtml('<div><br></div>&nbsp;')).toBe(true);
    expect(isBlankHtml('<div>hi</div>')).toBe(false);
    expect(textToComposeHtml('Hi <Sam>\n\nNick')).toBe(
      '<div>Hi &lt;Sam&gt;</div><div><br></div><div>Nick</div>',
    );
  });
});
