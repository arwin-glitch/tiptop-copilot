import {
  classifyDigestReply,
  DIGEST_RUN_RE,
  firstLine,
  REPOST_RE,
  ROSTER_RE,
} from '@/lib/updates/classify';
import { isConfidential } from '@/lib/updates/dealflow';
import {
  inline,
  plainText,
  repairBrokenLinks,
  stripFooters,
  toBlocks,
  unwrapEmphasis,
} from '@/lib/updates/mrkdwn';
import type {
  Block,
  DigestItem,
  DigestItemGroup,
  DigestKind,
  DigestNote,
  DigestPost,
  RosterList,
  RosterPost,
} from '@/lib/updates/types';

/**
 * The Nick Update Digest: a run is a parent message (header, counts, the
 * "worth your attention" list) plus one threaded reply per update; month-end
 * runs may carry their items inline. Ledger lines are the routine's dedup
 * record and are dropped here, before anything becomes a segment.
 */

type PostBaseKeys = 'ts' | 'postedAt' | 'permalink' | 'settling' | 'threadMissing';
export type DigestBody = Omit<DigestPost, PostBaseKeys>;
export type RosterBody = Omit<RosterPost, PostBaseKeys>;

export interface ReplyText {
  ts: string;
  text: string;
  subtype?: string;
}

const ITEM_START_RE = /^\s*── /;
const RULE_RE = /^\s*─{10,}/;
const LEDGER_RE = /^\s*[_*]?Ledger[_*]?\s*:/i;
const LINK_RE = /^\s*[_*]?Link(?: \(([^)]*)\))?[_*]?\s*:\s*(.*)$/i;
const GROUP_RE =
  /^\s*(:warning:\s*|⚠️\s*)?[_*]{0,2}\s*(key takeaways|metrics|decisions(?:\/changes)?|action items(?: (?:&amp;|&) deadlines)?|needs attention|highlights|notes)(\s*\([^)]*\))?[_*]{0,2}\s*:\s*[_*]{0,2}\s*(.*)$/i;
const DONE_RE = /^\s*(?::white_check_mark:|✅)\s*(.*)$/;
const ISSUE_RE = /^\s*\*Issue [A-Z0-9]+\*/;
const COUNTS_RE = /^(\d+) updates? \((\d+) weekly \/ (\d+) monthly(.*)\)$/;
/** ` | ` before a known key only: a quoted subject may contain one. */
const META_SPLIT_RE = / \| (?=[_*]*(?:From|Subject|Received|Sent|Period)[_*]*\s*:)/i;
const CANDIDATES_RE = /^[_*]*Candidate series noticed/i;
const NOTHING_NEW_RE = /\b(?:nothing new|no new|none)\b/i;
/** A line that opens with an emphasised label starts the next block. */
const LABEL_START_RE = /^[_*][^_*\s][^_*]*[_*]/;
const CALLOUT_RE =
  /time-sensitive|\bflags?\b|worth (?:your )?attention|needs attention|investors?[- ]only|do[- ]not[- ]forward|:lock:|🔒/i;

function kindFor(label: string): DigestKind {
  const l = label.toLowerCase();
  if (l === 'weekly') return 'weekly';
  if (l === 'month-start') return 'month-start';
  if (l === 'month-end') return 'month-end';
  if (l === 'supplemental') return 'supplemental';
  if (l.includes('catch-up')) return 'catch-up';
  return 'other';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface SplitBody {
  head: string[];
  chunks: string[][];
  house: string[];
}

/** Lines -> the part before any item, the `── ` item chunks, and what follows a rule. */
function splitBody(lines: string[]): SplitBody {
  const out: SplitBody = { head: [], chunks: [], house: [] };
  let state: 'head' | 'item' | 'house' = 'head';
  for (const line of lines) {
    if (RULE_RE.test(line)) {
      state = 'house';
      continue;
    }
    if (state !== 'house' && ITEM_START_RE.test(line)) {
      out.chunks.push([line]);
      state = 'item';
      continue;
    }
    if (state === 'house') out.house.push(line);
    else if (state === 'item') out.chunks[out.chunks.length - 1]?.push(line);
    else out.head.push(line);
  }
  return out;
}

interface OpenGroup extends DigestItemGroup {
  pending: string[];
}

function flushGroup(group: OpenGroup | null): void {
  if (!group || group.pending.length === 0) return;
  group.blocks.push(...toBlocks(group.pending.join('\n')));
  group.pending = [];
}

/** Split `(…)` off the end of a title, respecting nesting. */
function trailingParen(text: string): { head: string; paren: string | null } {
  const t = text.trimEnd();
  if (!t.endsWith(')')) return { head: t, paren: null };
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0) {
      return { head: t.slice(0, i).trimEnd(), paren: t.slice(i + 1, -1) };
    }
  }
  return { head: t, paren: null };
}

/** One `── ` chunk -> one digest item. */
export function parseDigestItem(chunk: string): DigestItem {
  const lines = repairBrokenLinks(chunk).split('\n');
  let i = lines.findIndex((l) => l.trim());
  let repost: string | null = null;
  const repostMatch = REPOST_RE.exec((lines[i] ?? '').trim());
  if (repostMatch) {
    repost = plainText(repostMatch[1] ?? '') || null;
    i = lines.findIndex((l, idx) => idx > i && l.trim());
  }

  // Title line: markers, lock, emphasis, then the trailing cadence.
  let titleLine = (lines[i] ?? '').replace(ITEM_START_RE, '').trim();
  const newsletter = /[✲✷⁂]/.test(titleLine);
  titleLine = titleLine.replace(/[✲✷⁂]/g, '').replace(/\s+/g, ' ').trim();

  let locked = false;
  let lockNote: string | null = null;
  const lock = /:lock:|🔒/.exec(titleLine);
  if (lock) {
    locked = true;
    const before = titleLine.slice(0, lock.index);
    const after = titleLine.slice(lock.index + lock[0].length);
    const open = (before.match(/\(/g) ?? []).length - (before.match(/\)/g) ?? []).length;
    let noteRaw = after;
    if (open > 0) {
      // The lock sits inside the cadence parentheses: keep them balanced.
      const close = after.indexOf(')');
      noteRaw = close >= 0 ? after.slice(0, close) : after;
      titleLine = `${before.replace(/[\s—–,-]+$/, '')}${close >= 0 ? after.slice(close) : ')'}`;
    } else {
      titleLine = before.trim();
    }
    lockNote = plainText(noteRaw.replace(/_/g, '')) || null;
  }

  let name = titleLine;
  let rest = '';
  const wrapped = /^([_*])\s*([^_*]+?)\s*\1(?=\s|$)(.*)$/.exec(titleLine);
  if (wrapped) {
    name = wrapped[2] ?? '';
    rest = wrapped[3] ?? '';
  }
  let cadence: string | null = null;
  const fromRest = trailingParen(rest || name);
  if (fromRest.paren !== null) {
    cadence = plainText(fromRest.paren) || null;
    if (rest) rest = fromRest.head;
    else name = fromRest.head;
  }
  const plainName = plainText(unwrapEmphasis(name));
  const dash = plainName.indexOf(' — ');
  const title = dash >= 0 ? plainName.slice(0, dash).trim() : plainName;
  const detail = dash >= 0 ? plainName.slice(dash + 3).trim() || null : null;

  const meta: string[] = [];
  const links: { label: string; href: string }[] = [];
  const groups: OpenGroup[] = [];
  let current: OpenGroup | null = null;
  const ensure = (): OpenGroup => {
    if (!current) {
      // After a one-line status the text carries on unlabelled.
      current = {
        label: groups.length > 0 ? '' : 'Details',
        tone: 'default',
        blocks: [],
        pending: [],
      };
      groups.push(current);
    }
    return current;
  };

  for (const line of lines.slice(i + 1)) {
    const t = line.trim();
    if (!t) {
      current?.pending.push('');
      continue;
    }
    if (LEDGER_RE.test(t)) continue;
    const rp = REPOST_RE.exec(t);
    if (rp) {
      repost = plainText(rp[1] ?? '') || null;
      continue;
    }
    if (/^[_*]*From[_*]*:/i.test(t)) {
      meta.push(
        ...t
          .split(META_SPLIT_RE)
          .map((part) => plainText(part))
          .filter(Boolean),
      );
      continue;
    }
    if (/^[_*]*Period[_*]*:/i.test(t)) {
      meta.push(plainText(t));
      continue;
    }
    const link = LINK_RE.exec(t);
    if (link) {
      for (const seg of inline(link[2] ?? '')) {
        if (!seg.href) continue;
        const gmail = /^https:\/\/mail\.google\.com\//.test(seg.href);
        const base = gmail ? 'Open in Gmail' : 'Open link';
        links.push({ label: link[1] ? `${base} (${link[1]})` : base, href: seg.href });
      }
      continue;
    }
    const group = GROUP_RE.exec(t);
    if (group) {
      flushGroup(current);
      const attention = Boolean(group[1]) || /needs attention/i.test(group[2] ?? '');
      current = {
        label: capitalise(plainText(`${group[2] ?? ''}${group[3] ?? ''}`)),
        tone: attention ? 'attention' : 'default',
        blocks: [],
        pending: [group[4] ?? ''],
      };
      groups.push(current);
      continue;
    }
    const done = DONE_RE.exec(t);
    if (done) {
      // A one-line status, not a heading: the lines after it are not "done".
      flushGroup(current);
      const status: OpenGroup = {
        label: 'Done',
        tone: 'done',
        blocks: [],
        pending: [done[1] ?? ''],
      };
      flushGroup(status);
      groups.push(status);
      current = null;
      continue;
    }
    if (ISSUE_RE.test(t)) {
      const g = ensure();
      flushGroup(g);
      g.blocks.push({ type: 'label', segs: inline(t) });
      continue;
    }
    ensure().pending.push(line);
  }
  for (const g of groups) flushGroup(g);

  const finished: DigestItemGroup[] = groups
    .filter((g) => g.blocks.length > 0)
    .map(({ label, tone, blocks }) => ({ label, tone, blocks }));
  return {
    title: title || 'Update',
    detail,
    cadence,
    newsletter,
    locked,
    lockNote,
    repost,
    meta,
    groups: finished,
    links,
    needsAttention: finished.some((g) => g.tone === 'attention'),
  };
}

function bulletLine(line: string): boolean {
  return /^\s*(?:[•◦]|-\s)/.test(line);
}

/**
 * Which head lines are the attention list: the "worth your attention" line
 * and the bullets under it, else the parent's first three top-level bullets.
 */
function attentionLines(head: string[]): { used: Set<number>; bullets: string[] } {
  const used = new Set<number>();
  const bullets: string[] = [];
  const at = head.findIndex((l) => /worth your attention/i.test(l));
  if (at < 0) {
    head.forEach((line, i) => {
      if (bullets.length < 3 && /^(?:\s?•|-)\s/.test(line)) {
        used.add(i);
        bullets.push(line);
      }
    });
    return { used, bullets };
  }
  used.add(at);
  for (let j = at + 1; j < head.length; j++) {
    const line = head[j] ?? '';
    if (bulletLine(line)) {
      used.add(j);
      bullets.push(line);
      continue;
    }
    if (!line.trim()) {
      const next = head.slice(j + 1).find((l) => l.trim());
      if (next !== undefined && bulletLine(next)) continue;
    }
    break;
  }
  return { used, bullets };
}

/**
 * Lift an open "Candidate series noticed" block out of `lines`: the routine is
 * waiting for someone to approve a series. "Nothing new" is not a question.
 */
function takeAsks(lines: string[]): { asks: string[]; rest: string[] } {
  const start = lines.findIndex((l) => CANDIDATES_RE.test(l.trim()));
  if (start < 0 || NOTHING_NEW_RE.test(plainText(lines[start] ?? ''))) {
    return { asks: [], rest: lines };
  }
  let end = start + 1;
  while (end < lines.length && !LABEL_START_RE.test((lines[end] ?? '').trim())) end++;
  return { asks: lines.slice(start, end), rest: [...lines.slice(0, start), ...lines.slice(end)] };
}

/** The sentences of the run's own prose that flag something, as bullets. */
function calloutBlocks(lines: string[]): Block[] {
  const picked: Block[] = [];
  for (const line of lines) {
    if (!line.trim() || bulletLine(line)) continue;
    for (const sentence of line.trim().split(/(?<=[.!?])\s+(?=\S)/)) {
      if (CALLOUT_RE.test(sentence))
        picked.push({ type: 'bullet', depth: 0, segs: inline(sentence) });
    }
  }
  return picked;
}

export function parseDigestRun(parentText: string, replies: ReplyText[]): DigestBody {
  const parent = repairBrokenLinks(stripFooters(parentText).text);
  const lines = parent.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim());
  const first = firstLine(parent);

  let kind: DigestKind = 'other';
  let kindLabel = 'Digest';
  let dateLabel = '';
  let covering: string | null = null;
  const header = DIGEST_RUN_RE.exec(first);
  const repostHeader = header ? null : REPOST_RE.exec(first);
  if (header) {
    kindLabel = plainText(header[1] ?? '') || 'Digest';
    kind = kindFor(kindLabel);
    dateLabel = plainText(header[2] ?? '');
    covering = header[3] ? plainText(header[3]) || null : null;
  } else if (repostHeader) {
    kind = 'repost';
    kindLabel = 'Repost';
    covering = plainText(repostHeader[1] ?? '') || null;
  }

  // A repost carries its item from the first line on; a run's header is line one.
  const bodyLines = repostHeader ? lines.slice(firstIdx) : lines.slice(firstIdx + 1);
  const body = splitBody(bodyLines);

  let counts: DigestBody['counts'] = null;
  const meta: string[] = [];
  const houseLines: string[] = [...body.house];
  const attention = attentionLines(body.head);
  const leadLines: string[] = [];
  body.head.forEach((line, i) => {
    if (attention.used.has(i)) return;
    const t = plainText(line);
    const c = COUNTS_RE.exec(t);
    if (c && !counts) {
      counts = { total: Number(c[1]), weekly: Number(c[2]), monthly: Number(c[3]) };
      // "(… / 6 monthly, across 5 series — …)": the aside after the numbers.
      const aside = (c[4] ?? '').replace(/^[\s,;—–-]+/, '').trim();
      if (aside) meta.push(capitalise(aside));
    } else if (/^(?:(?:First run|Running) on ROSTER v)/i.test(t) && meta.length < 2) {
      meta.push(/^.*?\.(?=\s|$)/.exec(t)?.[0] ?? t);
    } else if (/^scope note/i.test(t) && meta.length < 2) {
      meta.push(t);
    } else if (/^No issue this period from/i.test(t)) {
      houseLines.push(line);
    } else if (!LEDGER_RE.test(line)) {
      leadLines.push(line);
    }
  });

  const items: DigestItem[] = body.chunks.map((c) => {
    const item = parseDigestItem(c.join('\n'));
    if (kind === 'repost') item.repost ??= covering;
    return item;
  });
  const notes: DigestNote[] = [];
  const sorted = [...replies].sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const reply of sorted) {
    const cls = classifyDigestReply(reply.text, reply.subtype);
    const text = repairBrokenLinks(stripFooters(reply.text).text);
    if (cls === 'items') {
      const split = splitBody(text.split('\n'));
      const preface = split.head.map((l) => REPOST_RE.exec(l.trim())).find(Boolean);
      for (const chunk of split.chunks) {
        const item = parseDigestItem(chunk.join('\n'));
        if (preface && !item.repost) item.repost = plainText(preface[1] ?? '') || null;
        items.push(item);
      }
      houseLines.push('', ...split.house);
    } else if (cls === 'repost') {
      items.push(parseDigestItem(text));
    } else if (cls === 'housekeeping') {
      houseLines.push('', ...text.split('\n'));
    } else if (cls === 'correction' || cls === 'note') {
      notes.push({ ts: reply.ts, correction: cls === 'correction', blocks: toBlocks(text) });
    }
  }

  const fromLead = takeAsks(leadLines);
  const fromHouse = takeAsks(houseLines);
  return {
    type: 'digest',
    kind,
    kindLabel,
    dateLabel,
    covering,
    counts,
    provisional: /provisional run/i.test(parent),
    empty: /No (monthly )?updates received/i.test(parent),
    meta,
    attention: toBlocks(attention.bullets.join('\n')),
    lead: toBlocks(fromLead.rest.join('\n')),
    callouts: calloutBlocks(fromLead.rest),
    asks: toBlocks([...fromLead.asks, '', ...fromHouse.asks].join('\n')),
    items,
    housekeeping: toBlocks(fromHouse.rest.join('\n')),
    notes,
  };
}

const LIST_RE = /^\*(WEEKLY|MONTHLY|ALSO INCLUDED)(?: \((\d+)\))?\*/;

/** The roster: its lists (parent) and appendix (thread). */
export function parseRoster(parentText: string, appendixTexts: string[]): RosterBody {
  const text = stripFooters(parentText).text;
  const version = Number(ROSTER_RE.exec(firstLine(text))?.[1] ?? 0);
  const lists: (RosterList & { lines: string[] })[] = [];
  let current: (RosterList & { lines: string[] }) | null = null;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim());
  // Only the roster's own preamble marks it confidential; an entry's lock shows with the entry.
  const listAt = lines.findIndex((l) => LIST_RE.test(l.trim()));
  const preamble = lines.slice(0, listAt < 0 ? lines.length : listAt).join('\n');
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (/supersedes/i.test(t)) continue;
    const list = LIST_RE.exec(t);
    if (list) {
      const title = list[1] ?? '';
      current = {
        title: capitalise(title.toLowerCase()),
        count: list[2] ? Number(list[2]) : null,
        blocks: [],
        lines: [],
      };
      lists.push(current);
      continue;
    }
    if (!t) {
      current?.lines.push('');
      continue;
    }
    if (current && (bulletLine(line) || /^\s*\d+\.\s/.test(line))) {
      current.lines.push(line);
      continue;
    }
    current = null;
  }

  const appendix = appendixTexts.flatMap((a) => {
    const body = stripFooters(a).text.split('\n');
    const at = body.findIndex((l) => l.trim());
    return toBlocks(body.slice(at + 1).join('\n'));
  });
  return {
    type: 'roster',
    version,
    confidential: isConfidential(preamble),
    lists: lists.map(({ lines: listLines, ...l }) => ({
      ...l,
      blocks: toBlocks(listLines.join('\n')),
    })),
    appendix,
  };
}
