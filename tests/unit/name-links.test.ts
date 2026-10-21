import { describe, expect, it } from 'vitest';
import {
  hasNameLinks,
  lineWithLinksToHtml,
  linkName,
  textWithLinks,
  toLinkedInUrl,
} from '@/lib/email/name-links';
import { bodyToHtml, buildNewMime, encodeAddressHeader } from '@/lib/google/gmail-send';

/** LinkedIn links on names in the intro draft; fictional people only. */

const PROFILE = 'https://www.linkedin.com/in/ola-brightwater-example';

describe('toLinkedInUrl', () => {
  it('accepts LinkedIn profiles, written with or without a scheme', () => {
    expect(toLinkedInUrl(PROFILE)).toBe(PROFILE);
    expect(toLinkedInUrl('linkedin.com/in/ola-brightwater-example')).toBe(
      'https://linkedin.com/in/ola-brightwater-example',
    );
    expect(toLinkedInUrl('http://uk.linkedin.com/in/ola')).toBe('https://uk.linkedin.com/in/ola');
  });

  it('refuses anything that is not a LinkedIn page over http(s)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'https://linkedin.com.evil.example/in/ola',
      'https://evil.example/?u=linkedin.com',
      'https://user:pass@www.linkedin.com/in/ola',
      'https://www.linkedin.com/',
      'ftp://www.linkedin.com/in/ola',
      'https://www.linkedin.com/in/ola smith',
      '',
      null,
    ]) {
      expect(toLinkedInUrl(bad), String(bad)).toBeNull();
    }
  });

  it('escapes brackets so the link form cannot be ended early', () => {
    expect(toLinkedInUrl('https://www.linkedin.com/in/ola-(pellucid)')).toBe(
      'https://www.linkedin.com/in/ola-%28pellucid%29',
    );
  });

  it('keeps every accepted URL readable back as a link', () => {
    const quoted = toLinkedInUrl("https://www.linkedin.com/in/ola-o'brightwater");
    expect(quoted).toBe('https://www.linkedin.com/in/ola-o%27brightwater');
    expect(hasNameLinks(linkName('Ola Brightwater', quoted))).toBe(true);
    expect(toLinkedInUrl(`https://www.linkedin.com/in/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('name links', () => {
  it('writes a linked name, or the plain name without a usable URL', () => {
    expect(linkName('Ola Brightwater', PROFILE)).toBe(`[Ola Brightwater](${PROFILE})`);
    expect(linkName('Ola Brightwater', 'https://evil.example/ola')).toBe('Ola Brightwater');
    expect(linkName('Ola [Bright]water', null)).toBe('Ola  Bright water');
  });

  it('turns only LinkedIn names into links, escaping everything', () => {
    const line = `Meet [Ola <b>](${PROFILE}) & [Evil](https://evil.example/x) <script>`;
    expect(lineWithLinksToHtml(line)).toBe(
      `Meet <a href="${PROFILE}">Ola &lt;b&gt;</a> &amp; [Evil](https://evil.example/x) &lt;script&gt;`,
    );
  });

  it('never lets a URL break out of the attribute', () => {
    const html = lineWithLinksToHtml('[x](https://www.linkedin.com/in/a"onmouseover="1)');
    expect(html).not.toContain('"onmouseover');
    expect(html).not.toContain('<a ');
  });

  it('spells the links out in the plain-text copy', () => {
    expect(textWithLinks(`Hi,\nMeet [Ola Brightwater](${PROFILE}).`)).toBe(
      `Hi,\nMeet Ola Brightwater (${PROFILE}).`,
    );
    expect(hasNameLinks(`[Ola](${PROFILE})`)).toBe(true);
    expect(hasNameLinks('[Ola](https://evil.example/ola)')).toBe(false);
  });
});

describe('sending with links', () => {
  const decode = (mime: string, type: 'plain' | 'html') => {
    const part = mime.split(`Content-Type: text/${type}; charset="UTF-8"`)[1]!;
    const data = part.split('\r\n\r\n')[1]!.split('\r\n')[0]!;
    return Buffer.from(data, 'base64').toString('utf8');
  };

  it('links names only when the compose window asked for it', () => {
    const body = `Hi Wren,\n\nWren - meet [Ola Brightwater](${PROFILE}).\n\nCheers,\nSam`;
    expect(bodyToHtml(body)).toContain('[Ola Brightwater](');
    expect(bodyToHtml(body, { links: true })).toContain(
      `<div>Wren - meet <a href="${PROFILE}">Ola Brightwater</a>.</div>`,
    );

    const mime = buildNewMime({
      from: 'owner@fund.example',
      to: 'Wren Abara <wren@halyard.example>',
      cc: '',
      subject: 'Intro: Wren (Halyard Ventures) <> Ola (Pellucid)',
      body,
      signatureHtml: '<div>Signature</div>',
      links: true,
    });
    expect(mime).toContain('Subject: Intro: Wren (Halyard Ventures) <> Ola (Pellucid)');
    expect(decode(mime, 'html')).toContain(`<a href="${PROFILE}">Ola Brightwater</a>`);
    expect(decode(mime, 'plain')).toContain(`Wren - meet Ola Brightwater (${PROFILE}).`);

    const plain = buildNewMime({
      from: 'owner@fund.example',
      to: 'wren@halyard.example',
      cc: '',
      subject: 'Hi',
      body,
      signatureHtml: null,
    });
    expect(decode(plain, 'html')).not.toContain('<a ');
  });

  it('encodes names written in other alphabets in the subject and To', () => {
    const b64 = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
    const mime = buildNewMime({
      from: 'owner@fund.example',
      to: 'Zoë Brightwater <zoe@pellucid.demo>, Wren Abara <wren@halyard.example>, ola@pellucid.demo',
      cc: 'José Ruiz <jose@halyard.example>',
      subject: 'Intro: Wren (Halyard Ventures) <> Zoë (Pellucid)',
      body: 'Hi all,\n\nCheers,\nSam',
      signatureHtml: null,
    });
    expect(mime).toContain(
      `To: ${b64('Zoë Brightwater')} <zoe@pellucid.demo>, Wren Abara <wren@halyard.example>, ola@pellucid.demo\r\n`,
    );
    expect(mime).toContain(`Cc: ${b64('José Ruiz')} <jose@halyard.example>\r\n`);
    expect(mime).toContain(
      `Subject: ${b64('Intro: Wren (Halyard Ventures) <> Zoë (Pellucid)')}\r\n`,
    );
    // Plain ASCII headers go exactly as typed.
    expect(encodeAddressHeader('Wren Abara <wren@halyard.example>')).toBe(
      'Wren Abara <wren@halyard.example>',
    );
    expect(encodeAddressHeader('Zoë <zoe@x.example>\r\nBcc: evil@x.example')).not.toMatch(/\r|\n/);
  });
});
