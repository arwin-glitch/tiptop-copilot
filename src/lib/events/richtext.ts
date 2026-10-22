import { createElement, Fragment, type ReactNode } from 'react';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * export: `renderRichText(source, options) → ReactNode`.
 *
 * The real one parses the campaign template grammar (lib/campaigns/template.ts:
 * **bold**, *italic*, [links](https://…), lists, merge fields) plus `## ` and
 * `### ` headings, and returns React nodes — NEVER an HTML string. Links get
 * rel="noopener noreferrer" and only isAllowedHref addresses.
 *
 * This stub renders paragraphs of plain text, which is already safe: React
 * escapes every string it is given.
 */
export interface RichTextOptions {
  /** Merge values for {{first_name}}, {{name}}, {{company}} (fallbacks after |). */
  merge?: { first_name?: string | null; name?: string | null; company?: string | null };
}

export function renderRichText(source: string, options: RichTextOptions = {}): ReactNode {
  void options;
  const paragraphs = source
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return createElement(
    Fragment,
    null,
    ...paragraphs.map((p, i) => createElement('p', { key: i }, p)),
  );
}
