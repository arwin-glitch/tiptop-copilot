/**
 * Photos inserted in the compose box (Gmail's "Insert photo › Inline"). In
 * the box a photo is an `<img>` with a data: URL, so it shows at once; at
 * Send each becomes a `cid:` reference and goes along as an inline part of
 * the email (multipart/related), counted in the same 7 MB as attachments.
 * Drafts saved to Gmail keep the words only (the photos are added at Send),
 * as attachments already are. Pure and client-safe: no DOM.
 */

export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const DATA_IMG =
  /<img\b[^>]*?\bsrc\s*=\s*"data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)"[^>]*>/gi;

export interface InlinePhoto {
  cid: string;
  name: string;
  type: string;
  /** Base64, no data: prefix. */
  data: string;
}

function altOf(tag: string): string {
  const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '';
  return alt
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[^\w. -]+/g, '_')
    .slice(0, 100);
}

/** The body with each inserted photo as `cid:`, and the photos to send with it. */
export function photosToCids(
  html: string,
  token: string = Math.random().toString(36).slice(2, 8),
): { html: string; inline: InlinePhoto[] } {
  const inline: InlinePhoto[] = [];
  const out = html.replace(DATA_IMG, (tag, type: string, data: string) => {
    const n = inline.length + 1;
    const cid = `img${n}.${token.replace(/[^a-z0-9]/gi, '')}@kraken`;
    const ext = type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1];
    inline.push({ cid, name: altOf(tag) || `image${n}.${ext}`, type, data });
    return `<img src="cid:${cid}" alt="">`;
  });
  return { html: out, inline };
}

/** The body without its inserted photos (what a saved draft keeps). */
export function withoutPhotos(html: string): string {
  return html.replace(DATA_IMG, '');
}

/** Whether the body holds an inserted photo. */
export function hasPhotos(html: string): boolean {
  return new RegExp(DATA_IMG.source, 'i').test(html);
}

/** The bytes the inserted photos come to. */
export function photoBytes(html: string): number {
  let total = 0;
  for (const m of html.matchAll(DATA_IMG)) total += Math.floor(((m[2] ?? '').length * 3) / 4);
  return total;
}
