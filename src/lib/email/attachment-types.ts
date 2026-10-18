/**
 * Attachment types a browser may show in a tab. /api/inbox/attachment serves
 * these inline and everything else as a download, so no mail-borne HTML runs
 * on this site. The inbox links only these to a new tab: anything else is a
 * plain download, which never leaves the page (a new tab or window opened for
 * a download stays blank in the desktop app).
 */
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function opensInline(mimeType: string | null | undefined): boolean {
  return INLINE_TYPES.has((mimeType ?? '').toLowerCase());
}
