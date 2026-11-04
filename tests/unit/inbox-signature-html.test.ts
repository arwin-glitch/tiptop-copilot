import { describe, expect, it } from 'vitest';
import { sanitizeSignatureHtml } from '@/lib/email/signature-html';

describe('signature HTML', () => {
  it('keeps text, links, https images and basic layout', () => {
    const html =
      '<div>Sam Rivera<br><b>Partner</b>, <a href="https://example.com" style="color:red">Example</a></div>' +
      '<img src="https://img.example.com/logo.png" width="96" height="31" alt="Logo" onerror="x()">';
    expect(sanitizeSignatureHtml(html)).toBe(
      '<div>Sam Rivera<br><b>Partner</b>, <a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a></div>' +
        '<img src="https://img.example.com/logo.png" width="96" height="31" alt="Logo">',
    );
  });

  it('drops scripts, styles, handlers and unsafe URLs', () => {
    const html =
      '<script>alert(1)</script><style>p{}</style><a href="javascript:alert(1)">x</a>' +
      '<img src="data:image/png;base64,AAAA"><img src="http://plain.example/a.png">' +
      '<svg><a href="https://x.example">y</a></svg><span onclick="z()">ok</span>';
    expect(sanitizeSignatureHtml(html)).toBe('<a>x</a><span>ok</span>');
  });

  it('allows tel and mailto links, and is stable when run twice', () => {
    const once = sanitizeSignatureHtml(
      '<a href="tel:+15550100">Call</a> <a href="mailto:a@example.com">Mail</a>',
    );
    expect(once).toContain('href="tel:+15550100"');
    expect(sanitizeSignatureHtml(once)).toBe(once);
  });
});
