import type { ExtractedPage } from '@/lib/types/domain';

/**
 * Page-aware text is stored in a single `extracted_text` column using an
 * explicit page marker, rather than a separate pages table.
 *
 * Why: every consumer wants the whole document *and* the page a quote came
 * from. One column keeps extraction atomic (a document is either extracted or
 * not) and keeps full-text search on a single tsvector, while this module
 * gives structured access when a citation needs a page number.
 */

export const PAGE_MARKER_PREFIX = '\f[page ';

export function joinPages(pages: readonly ExtractedPage[]): string {
  return pages.map((p) => `${PAGE_MARKER_PREFIX}${p.page}]\n${p.text.trim()}`).join('\n');
}

export function splitPages(text: string | null | undefined): ExtractedPage[] {
  if (!text) return [];
  if (!text.includes(PAGE_MARKER_PREFIX)) {
    return [{ page: 1, text: text.trim() }];
  }
  const pages: ExtractedPage[] = [];
  const parts = text.split(/\f\[page (\d+)\]\n?/);
  // parts: ["", "1", "body", "2", "body", ...] — leading element is pre-marker text.
  const leading = parts[0]?.trim();
  if (leading) pages.push({ page: 1, text: leading });
  for (let i = 1; i < parts.length; i += 2) {
    const pageNo = Number(parts[i]);
    const body = (parts[i + 1] ?? '').trim();
    if (Number.isFinite(pageNo)) pages.push({ page: pageNo, text: body });
  }
  return pages;
}

/** Human-readable text with page markers stripped, for display. */
export function plainDocumentText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\f\[page \d+\]\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Which page a character offset falls on. Used to attach pages to quotes. */
export function pageForQuote(text: string | null | undefined, quote: string): number | null {
  const pages = splitPages(text);
  if (pages.length === 0 || !quote.trim()) return null;
  const needle = quote.trim().slice(0, 80).toLowerCase();
  for (const p of pages) {
    if (p.text.toLowerCase().includes(needle)) return p.page;
  }
  return null;
}
