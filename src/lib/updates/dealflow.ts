import {
  decodeEntities,
  plainText,
  segText,
  stripFooters,
  toBlocks,
  unwrapEmphasis,
} from '@/lib/updates/mrkdwn';
import type { Block, DealflowPost, ReportSection, SectionKey } from '@/lib/updates/types';

/**
 * The weekly dealflow reports. Three layouts are live — a parent plus thread
 * replies with emphasised headings (T), `=== X ===` sections (S) and `====`
 * rulers over uppercase headings (R) — and anything else with two recognised
 * headings parses through the same heading rules (G). The name before the
 * format marker is captured generically and never matched.
 */

export type DealflowFormat = 'T' | 'S' | 'R' | 'G';

export const FORMAT_T_RE = /^(.+?)\s+Deal Flow\s+[—–-]\s+Weekly Update\s*\|\s*(.+)$/i;
export const FORMAT_S_RE = /^(.+?)\s+DEALFLOW\s+[—–-]\s+WEEKLY REPORT$/i;
export const FORMAT_R_RE = /^(.+?)\s+[—–-]\s+WEEKLY DEAL-FLOW UPDATE(?:\s+\((INCREMENTAL)\))?$/i;

export type DealflowBody = Omit<
  DealflowPost,
  'ts' | 'postedAt' | 'permalink' | 'settling' | 'threadMissing'
>;

const TITLES: Record<Exclude<SectionKey, 'other'>, string> = {
  summary: 'Summary',
  new: 'New deals',
  updates: 'Material updates',
  actions: 'Action items',
  deadlines: 'Upcoming deadlines & meetings',
  risks: 'Risks & watch list',
  whatsnew: "What's new since last report",
};
const ORDER = Object.keys(TITLES) as Exclude<SectionKey, 'other'>[];

function sentenceCase(text: string): string {
  const t = text.trim();
  if (t !== t.toUpperCase()) return t;
  return t.charAt(0) + t.slice(1).toLowerCase();
}

/** A heading's text -> its section key and display title. */
export function headingKey(text: string): { key: SectionKey; title: string } {
  const decoded = decodeEntities(text).replace(/[*_]/g, '').replace(/:\s*$/, '').trim();
  const norm = decoded
    .replace(/:/g, '')
    .toUpperCase()
    .replace(/\(CONT[’']D\)|\(CONTINUED\)|\(\d\/\d\)/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const starts = (...prefixes: string[]) => prefixes.some((p) => norm.startsWith(p));
  let key: SectionKey = 'other';
  if (starts('EXECUTIVE SUMMARY', 'SUMMARY')) key = 'summary';
  else if (starts('NEW DEAL')) key = 'new';
  else if (starts('MATERIAL UPDATE', 'UPDATES')) key = 'updates';
  else if (starts('ACTION ITEM')) key = 'actions';
  else if (starts('UPCOMING DEADLINE', 'DEADLINES')) key = 'deadlines';
  else if (starts('RISK', 'WATCH LIST')) key = 'risks';
  else if (starts('WHAT IS NEW', "WHAT'S NEW", 'WHAT’S NEW')) key = 'whatsnew';
  if (key !== 'other') return { key, title: TITLES[key] };
  return { key, title: sentenceCase(decoded.replace(/\s*\([^)]*\)\s*$/, '')) || 'Other' };
}

interface Heading {
  key: SectionKey;
  title: string;
  rest?: string;
}

const UPPERCASE_RE = /^[A-Z0-9 &/'’().,-]+$/;
const WHATS_NEW_RE = /^WHAT[’']S NEW vs\.? LAST REPORT:\s*(.*)$/i;

function detectHeading(
  line: string,
  ctx: { afterRuler: boolean; firstOfReply: boolean },
): Heading | null {
  const t = line.trim();
  let m = /^=== (.+) ===$/.exec(t);
  if (m?.[1]) return headingKey(m[1]);

  const decoded = decodeEntities(t);
  if (ctx.afterRuler && UPPERCASE_RE.test(decoded) && /[A-Z]/.test(decoded)) {
    return headingKey(decoded);
  }

  m = WHATS_NEW_RE.exec(t);
  if (m) return { key: 'whatsnew', title: TITLES.whatsnew, rest: m[1] ?? '' };

  m = /^([*_])([^*_]+?)\1(:?)$/.exec(t);
  if (m?.[2]) {
    const h = headingKey(m[2]);
    if (h.key !== 'other') return h;
  }

  if (ctx.firstOfReply && t.length <= 60 && !/^[•◦-]/.test(t)) {
    const h = headingKey(t);
    if (h.key !== 'other') return h;
  }
  return null;
}

/** How many recognised section headings a text carries (for the generic fallback). */
export function countSectionHeadings(text: string): number {
  let count = 0;
  let afterRuler = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^={10,}$/.test(t)) {
      afterRuler = true;
      continue;
    }
    if (!t) continue;
    const h = detectHeading(t, { afterRuler, firstOfReply: false });
    afterRuler = false;
    if (h && h.key !== 'other') count++;
  }
  return count;
}

function isPointer(line: string): boolean {
  return /in thread below/i.test(line) || line.includes(':thread:') || line.includes('🧵');
}

/**
 * A reply is part of the report when it opens with a section heading (after
 * any ruler) or carries the routine's footer; anything else is a person
 * talking about the report.
 */
function isReportReply(text: string, hadFooter: boolean): boolean {
  if (hadFooter) return true;
  let afterRuler = false;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || isPointer(t)) continue;
    if (/^={10,}$/.test(t)) {
      afterRuler = true;
      continue;
    }
    return detectHeading(t, { afterRuler, firstOfReply: true }) !== null;
  }
  return false;
}

function isNone(blocks: Block[]): boolean {
  const content = blocks.filter((b) => b.type !== 'label');
  if (content.length !== 1 || !content[0]) return false;
  const b = content[0];
  const text = b.type === 'para' ? b.lines.map(segText).join(' ') : segText(b.segs);
  return /^(none|no new|nothing)/i.test(text.trim());
}

/** Numbered items, else top-level bullets; "None" is zero. */
export function countItems(blocks: Block[]): number {
  if (isNone(blocks)) return 0;
  const numbered = blocks.filter((b) => b.type === 'numbered').length;
  if (numbered > 0) return numbered;
  return blocks.filter((b) => b.type === 'bullet' && b.depth === 0).length;
}

/**
 * New deals / updates: "None" is zero; items, else one per paragraph (a
 * routine sometimes writes an update as prose); null when nothing is countable.
 */
export function countDeals(blocks: Block[]): number | null {
  if (isNone(blocks)) return 0;
  const items = countItems(blocks);
  if (items > 0) return items;
  const paras = blocks.filter((b) => b.type === 'para').length;
  return paras > 0 ? paras : null;
}

/** Times add length, not information: "Fri Sep 11 12:01 AM – …" -> "Fri Sep 11 – …". */
function compactWindow(text: string): string {
  return text
    .replace(/\s*\d{1,2}:\d{2}\s*[AP]M\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONFIDENTIAL_RE = /CONFIDENTIAL|do not forward|investors?[- ]only|:lock:|🔒/i;

export function isConfidential(text: string): boolean {
  return CONFIDENTIAL_RE.test(text);
}

interface RawSection {
  key: SectionKey;
  title: string;
  lines: string[];
}

export function parseDealflowReport(
  format: DealflowFormat,
  parentText: string,
  replyTexts: string[],
): DealflowBody {
  const parts = [stripFooters(parentText).text];
  const notes: Block[][] = [];
  for (const reply of replyTexts) {
    const { text, hadFooter } = stripFooters(reply);
    if (isReportReply(text, hadFooter)) parts.push(text);
    else if (text.trim()) notes.push(toBlocks(text));
  }

  const preamble: string[] = [];
  const raw: RawSection[] = [];
  let current: RawSection | null = null;

  parts.forEach((part, index) => {
    let afterRuler = false;
    let seenFirst = false;
    for (const rawLine of part.split('\n')) {
      const line = rawLine.trimEnd();
      const t = line.trim();
      if (isPointer(t)) continue;
      if (/^={10,}$/.test(t)) {
        afterRuler = true;
        continue;
      }
      if (!t) {
        (current ? current.lines : preamble).push('');
        continue;
      }
      const firstOfPart = !seenFirst;
      seenFirst = true;
      // The report's own title line is never a section, whatever its name says.
      if (index === 0 && firstOfPart) {
        preamble.push(line);
        continue;
      }
      const heading = detectHeading(t, { afterRuler, firstOfReply: index > 0 && firstOfPart });
      afterRuler = false;
      if (heading) {
        current = {
          key: heading.key,
          title: heading.title,
          lines: heading.rest ? [heading.rest] : [],
        };
        raw.push(current);
        continue;
      }
      (current ? current.lines : preamble).push(line);
    }
    (current ? current.lines : preamble).push('');
  });

  // Preamble: the heading line, the window, Baseline/Note lines, and any
  // loose text (the exec paragraph of a thread-format parent).
  const pre = preamble.filter((l) => l.trim());
  const heading = plainText(unwrapEmphasis(pre[0] ?? '')).slice(0, 500);
  let windowLabel: string | null = null;
  if (format === 'T') windowLabel = FORMAT_T_RE.exec(heading)?.[2]?.trim() ?? null;
  const meta: string[] = [];
  const loose: string[] = [];
  for (const line of pre.slice(1)) {
    const u = unwrapEmphasis(line);
    const win = /^[_*]*(?:Review window|Window)[_*]*:[_*]*\s*(.*)$/i.exec(u);
    if (win) {
      windowLabel ??= compactWindow(plainText(win[1] ?? '')) || null;
    } else if (/^[_*]*(?:Baseline|Note)[_*]*:/i.test(u)) {
      meta.push(plainText(line));
    } else {
      loose.push(line);
    }
  }

  const merged: RawSection[] = [];
  for (const section of raw) {
    const same = merged.find((s) =>
      s.key === 'other'
        ? section.key === 'other' && s.title === section.title
        : s.key === section.key,
    );
    if (same) same.lines.push('', ...section.lines);
    else merged.push({ ...section, lines: [...section.lines] });
  }
  if (loose.length > 0) {
    const summary = merged.find((s) => s.key === 'summary');
    if (summary) summary.lines.unshift(...loose, '');
    else merged.unshift({ key: 'summary', title: TITLES.summary, lines: loose });
  }

  const sections: ReportSection[] = [];
  const build = (s: RawSection) => {
    const blocks = toBlocks(s.lines.join('\n'));
    if (blocks.length === 0) return;
    const deals = s.key === 'new' || s.key === 'updates';
    sections.push({
      key: s.key,
      title: s.title,
      blocks,
      count: deals ? countDeals(blocks) : countItems(blocks),
    });
  };
  for (const key of ORDER) {
    const s = merged.find((m) => m.key === key);
    if (s) build(s);
  }
  for (const s of merged) if (s.key === 'other') build(s);

  const all = parts.join('\n');
  const count = (key: SectionKey) => sections.find((s) => s.key === key)?.count ?? null;
  return {
    type: 'dealflow',
    heading,
    windowLabel,
    meta,
    flags: {
      baseline:
        /^[_*]*Baseline[_*]*:.*\bfirst\b/im.test(all) ||
        /This is the first report/i.test(all) ||
        /\bBASELINE\b/.test(all),
      incremental: Boolean(FORMAT_R_RE.exec(heading)?.[2]),
      confidential: isConfidential(all),
    },
    counts: { newDeals: count('new'), updates: count('updates') },
    sections,
    notes,
  };
}
