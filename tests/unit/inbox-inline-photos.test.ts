import { describe, expect, it } from 'vitest';
import { sanitizeComposeHtml } from '@/lib/email/compose-html';
import { hasPhotos, photoBytes, photosToCids, withoutPhotos } from '@/lib/email/inline-photos';
import { buildNewMime } from '@/lib/google/gmail-send';

const PNG = Buffer.from('fake-png-bytes').toString('base64');
const BODY = `<div>Look:</div><img src="data:image/png;base64,${PNG}" alt="chart &quot;Q3&quot;.png"><div>ok</div>`;

describe('inline photos', () => {
  it('turns inserted photos into cid: images and the parts to send', () => {
    const out = photosToCids(BODY, 'tok');
    expect(out.html).toBe('<div>Look:</div><img src="cid:img1.tok@kraken" alt=""><div>ok</div>');
    expect(out.inline).toEqual([
      { cid: 'img1.tok@kraken', name: 'chart _Q3_.png', type: 'image/png', data: PNG },
    ]);
    expect(hasPhotos(BODY)).toBe(true);
    expect(withoutPhotos(BODY)).toBe('<div>Look:</div><div>ok</div>');
    expect(photoBytes(BODY)).toBe(Math.floor((PNG.length * 3) / 4));
  });

  it('keeps a cid: image only when its photo goes along', () => {
    const html =
      '<img src="cid:img1.tok@kraken"><img src="cid:other@kraken"><img src="https://x.example/a.png">';
    expect(sanitizeComposeHtml(html, { cids: new Set(['img1.tok@kraken']) })).toBe(
      '<img src="cid:img1.tok@kraken" alt="" style="max-width:100%">',
    );
    expect(sanitizeComposeHtml(html)).toBe('');
  });

  it('sends them as multipart/related parts with a Content-ID', () => {
    const { html, inline } = photosToCids(BODY, 'tok');
    const mime = buildNewMime({
      from: 'partner@firm.example',
      to: 'friend@example.com',
      cc: '',
      subject: 'Chart',
      body: '',
      html,
      signatureHtml: null,
      inline: inline.map((i) => ({
        cid: i.cid,
        filename: i.name,
        mimeType: i.type,
        data: Buffer.from(i.data, 'base64'),
      })),
    });
    expect(mime).toMatch(/Content-Type: multipart\/related; boundary="r_/);
    expect(mime).toContain('Content-ID: <img1.tok@kraken>');
    expect(mime).toContain('Content-Disposition: inline; filename="chart _Q3_.png"');
    expect(mime).not.toContain('multipart/mixed');
    const htmlPart = mime.split('Content-Type: text/html; charset="UTF-8"')[1]!;
    const encoded = htmlPart.split('\r\n\r\n')[1]!.split('\r\n')[0]!;
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toContain('src="cid:img1.tok@kraken"');
  });
});
