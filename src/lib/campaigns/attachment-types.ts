import { BUCKET_BASE_MIME_TYPES, normalizeMimeType } from '@/lib/storage/allowed-types';

/**
 * Which files a campaign can carry as a shared attachment, and the content
 * type each is stored and sent with. Pure, so the composer refuses a file
 * before uploading it and the server decides with the same rule.
 *
 * Attachments are kept in the private bucket, which takes only the types in
 * lib/storage/allowed-types.ts. A file of any other type (a spreadsheet, a
 * zip, a type the browser does not know) would be refused by storage, so it
 * is refused here first, with a sentence a person can act on. The list is
 * the bucket's own base list on purpose: attachments do not widen the bucket.
 */

/** The content types a shared attachment can have. */
export const CAMPAIGN_ATTACHMENT_TYPES: readonly string[] = BUCKET_BASE_MIME_TYPES;

/** The same, as a person reads it. */
export const CAMPAIGN_ATTACHMENT_KINDS =
  'PDF, Word (.docx), PowerPoint (.pptx), plain text, Markdown, CSV, HTML, JSON, PNG, JPG, GIF or WebP';

/**
 * The type a file with no useful declared type is taken to be, by its
 * ending: browsers send none (or application/octet-stream) for a type the
 * computer does not know, as Windows often does for Markdown, and some
 * computers label a supported file with a type the bucket does not list
 * (with Excel installed, Windows labels every .csv
 * application/vnd.ms-excel).
 */
const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * The content type a shared attachment is stored and sent with, or null when
 * a campaign cannot carry it. A declared type the bucket takes is kept (as a
 * browser sends it: lowercased, no parameters), so a supported file is stored
 * and sent exactly as before. Any other declared type (none,
 * application/octet-stream, or a label like application/vnd.ms-excel on a
 * .csv) says nothing the bucket can use, so the file name's ending decides:
 * a .csv goes as CSV, while an .xlsx, a .zip or an unknown ending is refused.
 */
export function campaignAttachmentType(name: string, declaredType: string): string | null {
  const declared = normalizeMimeType(declaredType);
  if (CAMPAIGN_ATTACHMENT_TYPES.includes(declared)) return declared;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return TYPE_BY_EXTENSION[extension] ?? null;
}

/** Why a file cannot be attached, and what can be. */
export function unsupportedAttachmentMessage(name: string): string {
  return `${name} cannot be attached: campaigns carry ${CAMPAIGN_ATTACHMENT_KINDS} files. Save it as one of those (a PDF works for most things) and attach it again.`;
}
