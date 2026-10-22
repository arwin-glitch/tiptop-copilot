import type { CampaignMerge } from '@/lib/types/domain';

/**
 * A campaign's subject and body: light Markdown with merge fields.
 *
 * Pure and shared by the server (which renders each recipient's email) and
 * the composer (which previews it), so the preview is the email.
 *
 * The body is parsed once into a small tree, and merge values are dropped
 * into that tree as text. So a recipient called `**Bob**` or
 * `[me](https://evil.example)` shows up as those characters: a merge value
 * can never add a link, a tag or formatting, and every text node is escaped
 * when rendered to HTML. A merge field inside a link's address is refused for
 * the same reason, and because the click allowlist is the body's links.
 *
 * Syntax, kept to what an LP update needs:
 *   - a blank line between paragraphs; a single newline is a line break
 *   - **bold**, *italic*, [link text](https://...), and bare https:// links
 *   - lines starting "- " or "* " are a bulleted list, "1. " a numbered one
 *   - {{first_name}}, {{name}}, {{company}}, each with an optional fallback
 *     after a bar: {{first_name|there}}
 *   - {{rsvp_link}} (event messages only, D-075): the recipient's personal
 *     RSVP link, optionally with link text after a bar: {{rsvp_link|RSVP here}}.
 *     Its address is never typed: the server writes it into the recipient's
 *     `merge.rsvp_link` when it adds them from an event's guest list, and a
 *     person cannot fill it in (missing-fields.ts fills only MERGE_FIELDS).
 *     A recipient without one cannot be sent to (the review refuses).
 */

export const MERGE_FIELDS = ['first_name', 'name', 'company'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** What a merge field reads as when the recipient has no value and the tag names no fallback. */
export const DEFAULT_FALLBACKS: Record<MergeField, string> = {
  first_name: 'there',
  name: 'there',
  company: 'your company',
};

/**
 * The one link-valued merge field. Kept out of MERGE_FIELDS on purpose: those
 * are text a person may type in from the review; this one only the server
 * sets (see the header).
 */
export const RSVP_LINK_FIELD = 'rsvp_link';

/** What a {{rsvp_link}} reads as when the recipient has none (a test email, a preview). */
export const RSVP_LINK_PLACEHOLDER = 'your personal RSVP link';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'merge'; field: MergeField; fallback: string | null }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] }
  /** {{rsvp_link}}: the recipient's own RSVP link, with optional link text. */
  | { t: 'rsvp'; label: string | null }
  | { t: 'br' };

export type Block =
  { t: 'p'; c: Inline[] } | { t: 'ul'; items: Inline[][] } | { t: 'ol'; items: Inline[][] };

export interface ParsedTemplate {
  blocks: Block[];
  /** Problems a person must fix before the campaign can be confirmed. */
  issues: string[];
}

const MERGE_TAG = /\{\{\s*([a-zA-Z_]+)\s*(?:\|([^{}]*))?\}\}/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const BOLD = /\*\*([^*\n]+)\*\*/y;
const ITALIC = /\*([^*\n]+)\*/y;
const BARE_URL = /https?:\/\/[^\s<>()[\]{}"]+/y;
/** Trailing punctuation after a bare URL belongs to the sentence, not the link. */
const URL_TAIL = /[.,;:!?'"]+$/;

/** A link address the email may carry: http(s) or mailto, and no merge field inside it. */
export function isAllowedHref(href: string): boolean {
  if (href.includes('{{') || href.includes('}}')) return false;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return true;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Whether an address is a personal RSVP link as the server writes it: an
 * http(s) origin, then exactly /e/<slug>/i/<token> (the personal invite path,
 * eventPaths.invite in lib/events/contracts.ts), nothing before or after.
 * The token is base64url, optionally two parts joined by one dot (WS4's
 * event-rsvp/v1 token is `<43>.<22>`, lib/events/tokens.ts).
 */
export function isRsvpLinkUrl(href: string | null | undefined): href is string {
  if (typeof href !== 'string' || href.length > 2000) return false;
  return /^https?:\/\/[^/\s?#@]+\/e\/[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?\/i\/[A-Za-z0-9_-]{8,512}(?:\.[A-Za-z0-9_-]{8,512})?$/.test(
    href,
  );
}

/** Whether any of these templates uses {{rsvp_link}}. */
export function rsvpLinkUsed(...templates: string[]): boolean {
  return templates.some((t) => /\{\{\s*rsvp_link\s*(?:\|[^{}]*)?\}\}/i.test(t));
}

/** Whether a link can be click-tracked (mailto links go out as they are). */
export function isTrackableHref(href: string): boolean {
  return /^https?:\/\//i.test(href) && isAllowedHref(href);
}

/** The text a link shows, formatting dropped, merge fields as their tags. */
function labelOf(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.t === 'text'
        ? n.v
        : n.t === 'merge'
          ? `{{${n.field}}}`
          : n.t === 'rsvp'
            ? `{{${RSVP_LINK_FIELD}}}`
            : n.t === 'b' || n.t === 'i' || n.t === 'a'
              ? labelOf(n.c)
              : ' ',
    )
    .join('');
}

/**
 * Whether a link's visible text is itself an address: a bare URL, or link
 * text like "docsend.com/view/abc". Such a link always goes exactly where it
 * says, untracked. Rewriting it through Copilot would show one address and
 * open another, which mail filters treat as a phishing sign.
 */
export function showsAddress(link: { href: string; c: Inline[] }): boolean {
  const label = labelOf(link.c).trim();
  if (!label) return false;
  if (label === link.href) return true;
  if (/^(?:https?:\/\/|www\.)/i.test(label)) return true;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(
    label,
  );
}

/** Whether a link is rewritten for click tracking when the email is tracked. */
export function isTrackedLink(link: { href: string; c: Inline[] }): boolean {
  return isTrackableHref(link.href) && !showsAddress(link);
}

function parseInline(text: string, issues: Set<string>, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) out.push({ t: 'text', v: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '{' && text[i + 1] === '{') {
      MERGE_TAG.lastIndex = i;
      const m = MERGE_TAG.exec(text);
      if (m) {
        const field = (m[1] as string).toLowerCase();
        if (field === RSVP_LINK_FIELD) {
          if (depth >= 2) {
            // Inside a link's text: a link cannot hold another link.
            issues.add('{{rsvp_link}} cannot go inside the text of another link.');
            buffer += m[0];
          } else {
            flush();
            const label = m[2] === undefined ? '' : m[2].trim();
            out.push({ t: 'rsvp', label: label || null });
          }
          i += m[0].length;
          continue;
        }
        if ((MERGE_FIELDS as readonly string[]).includes(field)) {
          flush();
          const fallback = m[2] === undefined ? null : m[2].trim();
          out.push({ t: 'merge', field: field as MergeField, fallback });
        } else {
          issues.add(
            `{{${m[1]}}} is not a merge field. Use {{first_name}}, {{name}} or {{company}}.`,
          );
          buffer += m[0];
        }
        i += m[0].length;
        continue;
      }
      issues.add('A merge field is missing its closing }}.');
    }
    if (ch === '[' && depth < 2) {
      LINK.lastIndex = i;
      const m = LINK.exec(text);
      if (m) {
        const href = m[2] as string;
        if (href.includes('{{') || !isAllowedHref(href)) {
          issues.add(
            href.includes('{{')
              ? 'A merge field cannot go inside a link address.'
              : `"${href.slice(0, 80)}" is not a web or email address, so it cannot be a link.`,
          );
          // Kept as plain text, whole: no part of a refused link becomes one.
          buffer += m[0];
          i += m[0].length;
          continue;
        }
        flush();
        out.push({ t: 'a', href, c: parseInline(m[1] as string, issues, depth + 2) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*' && depth < 2) {
      BOLD.lastIndex = i;
      const bold = BOLD.exec(text);
      if (bold) {
        flush();
        out.push({ t: 'b', c: parseInline(bold[1] as string, issues, depth + 1) });
        i += bold[0].length;
        continue;
      }
      ITALIC.lastIndex = i;
      const italic = ITALIC.exec(text);
      // "*" between word characters (2*3*4) is arithmetic, not emphasis.
      if (italic && !/\w/.test(text[i - 1] ?? '') && !/\s/.test((italic[1] as string)[0] ?? ' ')) {
        flush();
        out.push({ t: 'i', c: parseInline(italic[1] as string, issues, depth + 1) });
        i += italic[0].length;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && depth < 2 && /\W|^$/.test(text[i - 1] ?? '')) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(text);
      if (m) {
        const href = (m[0] as string).replace(URL_TAIL, '');
        if (text.startsWith('{{', i + href.length)) {
          issues.add('A merge field cannot go inside a link address.');
        }
        if (isAllowedHref(href)) {
          flush();
          out.push({ t: 'a', href, c: [{ t: 'text', v: href }] });
          i += href.length;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

function withBreaks(lines: string[], issues: Set<string>): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ t: 'br' });
    out.push(...parseInline(line, issues));
  });
  return out;
}

/** Parse a body template into blocks, collecting anything that must be fixed first. */
export function parseTemplate(template: string): ParsedTemplate {
  const issues = new Set<string>();
  const blocks: Block[] = [];
  const paragraphs = template
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\s+$/g, ''))
    .filter((p) => p.trim());
  for (const paragraph of paragraphs) {
    let lines: string[] = [];
    let list: { t: 'ul' | 'ol'; items: Inline[][] } | null = null;
    const endText = () => {
      if (lines.length) blocks.push({ t: 'p', c: withBreaks(lines, issues) });
      lines = [];
    };
    const endList = () => {
      if (list) blocks.push(list);
      list = null;
    };
    for (const line of paragraph.split('\n')) {
      const bullet = BULLET.exec(line);
      const numbered = bullet ? null : NUMBERED.exec(line);
      const kind = bullet ? 'ul' : numbered ? 'ol' : null;
      if (kind) {
        endText();
        if (list && list.t !== kind) endList();
        list ??= { t: kind, items: [] };
        list.items.push(
          parseInline(((bullet ?? numbered) as RegExpExecArray)[1] as string, issues),
        );
      } else {
        endList();
        lines.push(line);
      }
    }
    endText();
    endList();
  }
  return { blocks, issues: [...issues] };
}

/* ------------------------------------------------------------ merge values */

/** First word of a name, unless the "name" is really an email address. */
export function firstNameOf(name: string | null | undefined): string {
  const clean = (name ?? '').trim();
  if (!clean || clean.includes('@')) return '';
  return clean.split(/\s+/)[0] ?? '';
}

/** The value a merge field takes for one recipient, before any fallback. */
export function mergeValue(field: MergeField, merge: CampaignMerge | null | undefined): string {
  const m = merge ?? {};
  if (field === 'first_name') return (m.first_name ?? '').trim() || firstNameOf(m.name);
  const value = (m[field] ?? '').trim();
  return field === 'name' && value.includes('@') ? '' : value;
}

function resolveMerge(
  field: MergeField,
  fallback: string | null,
  merge: CampaignMerge | null | undefined,
): string {
  return mergeValue(field, merge) || (fallback ?? DEFAULT_FALLBACKS[field]);
}

/** Merge fields a template uses, so the review can say who will see a fallback. */
export function mergeFieldsUsed(...templates: string[]): MergeField[] {
  const used = new Set<MergeField>();
  for (const template of templates) {
    for (const m of template.matchAll(/\{\{\s*([a-zA-Z_]+)\s*(?:\|[^{}]*)?\}\}/g)) {
      const field = (m[1] as string).toLowerCase();
      if ((MERGE_FIELDS as readonly string[]).includes(field)) used.add(field as MergeField);
    }
  }
  return MERGE_FIELDS.filter((f) => used.has(f));
}

/** Subject (or any one-line text) with merge fields filled in. No Markdown. */
export function renderSubject(subject: string, merge: CampaignMerge | null | undefined): string {
  const out = subject.replace(
    /\{\{\s*([a-zA-Z_]+)\s*(?:\|([^{}]*))?\}\}/g,
    (whole, raw: string, fallback?: string) => {
      const field = raw.toLowerCase();
      if (!(MERGE_FIELDS as readonly string[]).includes(field)) return whole;
      return resolveMerge(
        field as MergeField,
        fallback === undefined ? null : fallback.trim(),
        merge,
      );
    },
  );
  return out.replace(/[\r\n]+/g, ' ').trim();
}

/** Problems in a subject line. */
export function subjectIssues(subject: string): string[] {
  const issues: string[] = [];
  for (const m of subject.matchAll(/\{\{\s*([a-zA-Z_]+)\s*(?:\|[^{}]*)?\}\}/g)) {
    if (!(MERGE_FIELDS as readonly string[]).includes((m[1] as string).toLowerCase())) {
      issues.push(`{{${m[1]}}} in the subject is not a merge field.`);
    }
  }
  if (/\{\{(?![^{}]*\}\})/.test(subject))
    issues.push('A merge field in the subject is missing its closing }}.');
  return issues;
}

/* --------------------------------------------------------------- rendering */

export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface RenderOptions {
  merge: CampaignMerge | null | undefined;
  /**
   * Rewrites a link for click tracking; links go out as written without it.
   * Only links whose text is not itself an address are rewritten.
   */
  trackHref?: (href: string) => string;
}

function inlineHtml(nodes: Inline[], options: RenderOptions): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
          return escapeHtml(node.v);
        case 'merge':
          return escapeHtml(resolveMerge(node.field, node.fallback, options.merge));
        case 'b':
          return `<b>${inlineHtml(node.c, options)}</b>`;
        case 'i':
          return `<i>${inlineHtml(node.c, options)}</i>`;
        case 'br':
          return '<br>';
        case 'rsvp': {
          const url = options.merge?.rsvp_link;
          if (!isRsvpLinkUrl(url)) return escapeHtml(node.label ?? RSVP_LINK_PLACEHOLDER);
          // Like any link: tracked only when its text is not the address itself.
          const href = options.trackHref && node.label ? options.trackHref(url) : url;
          return `<a href="${escapeHtml(href)}" target="_blank">${escapeHtml(node.label ?? url)}</a>`;
        }
        case 'a': {
          // A link whose text is an address goes straight there (showsAddress).
          const href =
            options.trackHref && isTrackedLink(node) ? options.trackHref(node.href) : node.href;
          return `<a href="${escapeHtml(href)}" target="_blank">${inlineHtml(node.c, options)}</a>`;
        }
      }
    })
    .join('');
}

/** The body as email HTML, Gmail-style: one div per paragraph, a blank div between. */
export function renderHtml(blocks: Block[], options: RenderOptions): string {
  return blocks
    .map((block) => {
      if (block.t === 'p') return `<div>${inlineHtml(block.c, options)}</div>`;
      const tag = block.t;
      const items = block.items.map((item) => `<li>${inlineHtml(item, options)}</li>`).join('');
      return `<${tag} style="margin:0 0 0 1.2em;padding:0">${items}</${tag}>`;
    })
    .join('<div><br></div>');
}

function inlineText(nodes: Inline[], options: RenderOptions): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
          return node.v;
        case 'merge':
          return resolveMerge(node.field, node.fallback, options.merge);
        case 'b':
        case 'i':
          return inlineText(node.c, options);
        case 'br':
          return '\n';
        case 'rsvp': {
          const url = options.merge?.rsvp_link;
          if (!isRsvpLinkUrl(url)) return node.label ?? RSVP_LINK_PLACEHOLDER;
          return node.label ? `${node.label} (${url})` : url;
        }
        case 'a': {
          const label = inlineText(node.c, options);
          const address = node.href.replace(/^mailto:/i, '');
          return label === node.href || label === address ? label : `${label} (${address})`;
        }
      }
    })
    .join('');
}

/** The body as the plain-text part. Links are written out, untracked. */
export function renderText(blocks: Block[], options: RenderOptions): string {
  return blocks
    .map((block) => {
      if (block.t === 'p') return inlineText(block.c, options);
      return block.items
        .map((item, n) => `${block.t === 'ul' ? '-' : `${n + 1}.`} ${inlineText(item, options)}`)
        .join('\n');
    })
    .join('\n\n');
}

/**
 * Every distinct link in the body, in order: the click allowlist. A
 * {{rsvp_link}} is not one of them: it is different for every recipient, and
 * the click endpoint checks it against that recipient's own (campaigns.ts).
 */
export function collectLinks(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.t === 'a') {
        if (!out.includes(node.href)) out.push(node.href);
        walk(node.c);
      } else if (node.t === 'b' || node.t === 'i') walk(node.c);
    }
  };
  for (const block of blocks) {
    if (block.t === 'p') walk(block.c);
    else block.items.forEach(walk);
  }
  return out;
}

/** Merge fields this recipient lacks among those used: they will see the fallback. */
export function missingMergeFields(
  used: readonly MergeField[],
  merge: CampaignMerge | null | undefined,
): MergeField[] {
  return used.filter((field) => !mergeValue(field, merge));
}
