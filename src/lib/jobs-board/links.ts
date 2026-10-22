/**
 * Hosts whose links are usually private documents, not job pages: a
 * founder's emailed "job link" is often a Google Doc, Drive file, Notion page
 * or Dropbox share, which approving the role would otherwise make public as
 * its "Apply" link. Pure and client-safe.
 */
const PRIVATE_DOC_HOSTS = [
  'docs.google.com',
  'drive.google.com',
  'mail.google.com',
  'notion.so',
  'notion.site',
  'dropbox.com',
  'sharepoint.com',
  'onedrive.live.com',
  '1drv.ms',
];

/** Whether a link points at a document host that is often private (see PRIVATE_DOC_HOSTS). */
export function isPrivateDocLink(link: string | null | undefined): boolean {
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/\.$/, '');
    return PRIVATE_DOC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export const PRIVATE_LINK_MESSAGE =
  'This role links to a document that may be private (Google Docs, Drive, Notion, Dropbox or SharePoint). Check that anyone can open it, then approve again to confirm, or edit the role to use the company careers page.';
