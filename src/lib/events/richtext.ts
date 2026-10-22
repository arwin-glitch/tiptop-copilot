import { createElement, Fragment, type ReactNode } from 'react';
import {
  DEFAULT_FALLBACKS,
  mergeValue,
  parseTemplate,
  type Block,
  type Inline,
  type MergeField,
} from '@/lib/campaigns/template';

/**
 * Event rich text (D-075, WS2). Export kept from the contract:
 * `renderRichText(source, options) → ReactNode`.
 *
 * The grammar is the campaign template's (lib/campaigns/template.ts:
 * paragraphs, single-newline breaks, **bold**, *italic*, [links](https://…),
 * bare https:// links, "- " and "1. " lists, {{first_name|fallback}} merge
 * fields), plus three block forms the page needs:
 *   "## Heading" and "### Smaller heading" on a line of their own
 *   "> quoted line" (consecutive lines form one quote)
 *
 * It renders to React nodes and NEVER to an HTML string: every piece of text
 * is a React text node (escaped by React), links are <a> elements whose href
 * passed isAllowedHref in the campaign parser (http, https, mailto; no merge
 * field inside an address), and merge values are dropped in as text, so a
 * guest called "**Bob**" stays literally that.
 */

export interface RichTextOptions {
  /** Merge values for {{first_name}}, {{name}}, {{company}} (fallbacks after |). */
  merge?: { first_name?: string | null; name?: string | null; company?: string | null };
  /** The level "##" maps to (default 3, under the section's own h2). */
  headingLevel?: 2 | 3 | 4;
  /**
   * Studio: links carry data-inert-link and no target; the canvas swallows
   * clicks on them (no handler here, so a server render stays serializable).
   */
  inertLinks?: boolean;
}

type RichBlock = Block | { t: 'h'; level: 1 | 2; c: Inline[] } | { t: 'quote'; c: Inline[] };

const HEADING = /^(#{2,3})\s+(.+?)\s*#*\s*$/;
const QUOTE = /^>\s?(.*)$/;

/** The inline nodes of one line of text (the campaign parser's first paragraph). */
function inlineOf(text: string): Inline[] {
  const parsed = parseTemplate(text.replace(/\n/g, ' '));
  const first = parsed.blocks[0];
  return first && first.t === 'p' ? first.c : [{ t: 'text', v: text }];
}

/** Parse source into blocks: headings and quotes here, everything else by the campaign grammar. */
export function parseRichText(source: string): RichBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: RichBlock[] = [];
  let buffer: string[] = [];
  let quote: string[] = [];
  const flushText = () => {
    if (buffer.join('').trim()) out.push(...parseTemplate(buffer.join('\n')).blocks);
    buffer = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push({ t: 'quote', c: inlineOf(quote.join(' ')) });
    quote = [];
  };
  for (const line of lines) {
    const heading = HEADING.exec(line);
    const quoted = QUOTE.exec(line);
    if (heading) {
      flushText();
      flushQuote();
      out.push({
        t: 'h',
        level: (heading[1] as string).length === 2 ? 1 : 2,
        c: inlineOf(heading[2] as string),
      });
    } else if (quoted) {
      flushText();
      quote.push(quoted[1] as string);
    } else {
      flushQuote();
      buffer.push(line);
    }
  }
  flushText();
  flushQuote();
  return out;
}

function resolveMerge(
  field: MergeField,
  fallback: string | null,
  merge: RichTextOptions['merge'],
): string {
  const values = {
    first_name: merge?.first_name ?? undefined,
    name: merge?.name ?? undefined,
    company: merge?.company ?? undefined,
  };
  return mergeValue(field, values) || (fallback ?? DEFAULT_FALLBACKS[field]);
}

function renderInline(nodes: Inline[], options: RichTextOptions, keyBase: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyBase}.${i}`;
    switch (node.t) {
      case 'text':
        return node.v;
      case 'merge':
        return resolveMerge(node.field, node.fallback, options.merge);
      case 'b':
        return createElement('strong', { key }, ...renderInline(node.c, options, key));
      case 'i':
        return createElement('em', { key }, ...renderInline(node.c, options, key));
      case 'br':
        return createElement('br', { key });
      case 'a':
        return createElement(
          'a',
          options.inertLinks
            ? { key, href: node.href, 'data-inert-link': '' }
            : { key, href: node.href, target: '_blank', rel: 'noopener noreferrer' },
          ...renderInline(node.c, options, key),
        );
    }
  });
}

/** Render rich text to React nodes. Empty source renders nothing. */
export function renderRichText(source: string, options: RichTextOptions = {}): ReactNode {
  if (!source || !source.trim()) return null;
  const base = options.headingLevel ?? 3;
  const blocks = parseRichText(source);
  return createElement(
    Fragment,
    null,
    ...blocks.map((block, i) => {
      const key = String(i);
      switch (block.t) {
        case 'p':
          return createElement('p', { key }, ...renderInline(block.c, options, key));
        case 'ul':
        case 'ol':
          return createElement(
            block.t,
            { key },
            ...block.items.map((item, j) =>
              createElement(
                'li',
                { key: `${key}.${j}` },
                ...renderInline(item, options, `${key}.${j}`),
              ),
            ),
          );
        case 'h':
          return createElement(
            `h${Math.min(6, base + block.level - 1)}`,
            { key, className: 'ev-rt-h' },
            ...renderInline(block.c, options, key),
          );
        case 'quote':
          return createElement(
            'blockquote',
            { key },
            createElement('p', null, ...renderInline(block.c, options, key)),
          );
      }
    }),
  );
}

/** The plain-text form (for summaries, the OG card, aria labels): formatting dropped, merges filled. */
export function richTextToPlain(source: string, options: RichTextOptions = {}): string {
  const text = (nodes: Inline[]): string =>
    nodes
      .map((n) =>
        n.t === 'text'
          ? n.v
          : n.t === 'merge'
            ? resolveMerge(n.field, n.fallback, options.merge)
            : n.t === 'br'
              ? ' '
              : text(n.c),
      )
      .join('');
  return parseRichText(source)
    .map((b) => (b.t === 'ul' || b.t === 'ol' ? b.items.map(text).join(' · ') : text(b.c)))
    .join('\n')
    .trim();
}

const MERGE_IN_TEXT = /\{\{\s*([a-zA-Z_]+)\s*(?:\|([^{}]*))?\}\}/g;

/**
 * Merge fields in a PLAIN text field (a headline, a greeting): "Sarah, you're
 * invited" on a personal link, the fallback on the public URL. The result is
 * still plain text for React to render. Unknown tags stay as typed.
 */
export function mergePlainText(value: string, merge: RichTextOptions['merge']): string {
  if (!value || !value.includes('{{')) return value;
  return value.replace(MERGE_IN_TEXT, (whole, raw: string, fallback?: string) => {
    const field = raw.toLowerCase();
    if (field !== 'first_name' && field !== 'name' && field !== 'company') return whole;
    return resolveMerge(field, fallback === undefined ? null : fallback.trim(), merge);
  });
}
