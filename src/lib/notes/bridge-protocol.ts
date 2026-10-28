import { z } from 'zod';
import { clipText } from '@/lib/relay/soft-fields';
import type {
  ActionItem,
  EnhancedBlock,
  NotesLineRef,
  SegmentRange,
  TemplateSection,
} from '@/lib/types/notes';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { formatOffset } from './api';
import { carriedTaskId, dueFromText, parseTypedNotes } from './draft';

/**
 * The notes half of the Ask bridge (D-076, zero spend): what Kraken sends
 * Arwin's Claude routine to write a meeting's notes, and how what comes back
 * through the Slack relay is checked before it is stored. No paid API is
 * involved: the routine runs on Arwin's Claude plan.
 *
 *   NOTES_REQUEST_V1           app → routine, in the routine's /fire text
 *   `{ request_id, meeting_id, title, when, timezone, attendees, template,
 *      typed_notes, transcript: [[line_id, speaker, "m:ss", text], …],
 *      relay_channel }`
 *
 *   NOTES_RESULT_V1            routine → Slack relay → app, in parts
 *   `{ request_id, part, of, notes: { summary, sections, action_items,
 *      decisions, open_questions } }`
 *
 * The transcript is condensed to fit NOTES_FIRE_MAX_CHARS (consecutive lines
 * of one speaker merged, fillers dropped, then the middle trimmed with a
 * marker) and every kept line keeps its id, so a cited id always resolves to
 * the lines it stands for. What comes back is data from a model: it is
 * validated, made plain text, capped, and every cited id is checked against
 * what was sent; typed lines are put back by the app word for word.
 *
 * Pure and client-safe: the service (services/notes-bridge.ts) does the I/O.
 * docs/NOTES_ROUTINE.md is the routine's side of this contract.
 */

export const NOTES_REQUEST_MARKER = 'NOTES_REQUEST_V1';
export const NOTES_RESULT_MARKER = 'NOTES_RESULT_V1';
/** meeting_notes.model for notes Arwin's routine wrote. */
export const ARWIN_NOTES_MODEL = 'arwin-routine';
/** meeting_notes.prompt_version for those notes: the routine prompt's section (docs/NOTES_ROUTINE.md). */
export const NOTES_ROUTINE_VERSION = 'notes-routine@1';
/** The routine posts parts of at most this many characters. */
export const NOTES_RESULT_PART_MAX_CHARS = 3_500;

/* ======================================================== plain text == */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * A string the routine may read inside backticks: Slack and the parser both
 * take the first backtick pair as the JSON, so none may appear inside it.
 */
export function noBackticks(text: string): string {
  return text.replace(/`/g, "'").replace(CONTROL, '');
}

/** One line of display text from the routine: plain, single-spaced, capped at a word. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = unwrapSlackText(value, { preferLabel: true })
    .replace(CONTROL, '')
    .replace(/`+/g, "'")
    .replace(/\*\*|__/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(text, max);
}

/* ============================================================ request == */

/** One final transcript line, its speaker already named the way the People tab names them. */
export interface CondenseLine {
  seq: number;
  speaker: string;
  startMs: number;
  text: string;
}

/** [line_id (the first seq it stands for, null for the gap marker), speaker, "m:ss", text]. */
export type TranscriptRow = [number | null, string, string, string];

interface MergedLine {
  fromSeq: number;
  toSeq: number;
  speaker: string;
  startMs: number;
  text: string;
}

/** Hesitations removed from inside a line. */
const FILLER_RE = /(^|[\s,.;!?])(?:u+m+|u+h+|e+r+m+|h+m+|mm+-?h+m+|uh-huh)(?=$|[\s,.;!?])[,.]?/gi;
/** A whole line that is only a back-channel ("mm-hmm", "right"), dropped. "Yes" and "no" stay. */
const BACKCHANNEL_RE = /^(?:mm+-?h+m+|uh-huh|h+m+|right|got it|i see|okay|ok|oh|ah)[.!?,]*$/i;
/** A merged line never grows past this, so one monologue cannot crowd out the rest. */
const MERGE_MAX_CHARS = 1_500;
/** Any one line sent is cut here. */
const ROW_MAX_CHARS = 900;

function cleanLine(text: string): string {
  return noBackticks(text)
    .replace(FILLER_RE, '$1')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/^[\s,.;]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fillers out, back-channels dropped, then consecutive lines of one speaker
 * merged (up to MERGE_MAX_CHARS). Each merged line remembers the seqs it
 * stands for. Lines must arrive in seq order.
 */
export function condenseLines(lines: readonly CondenseLine[]): {
  merged: MergedLine[];
  dropped: number;
} {
  const merged: MergedLine[] = [];
  let dropped = 0;
  for (const line of lines) {
    const text = cleanLine(line.text);
    if (!text || BACKCHANNEL_RE.test(text)) {
      dropped += 1;
      continue;
    }
    const speaker = noBackticks(line.speaker).trim() || 'Guest';
    const last = merged[merged.length - 1];
    if (last && last.speaker === speaker && last.text.length + text.length + 1 <= MERGE_MAX_CHARS) {
      last.text = `${last.text} ${text}`;
      last.toSeq = line.seq;
      continue;
    }
    merged.push({ fromSeq: line.seq, toSeq: line.seq, speaker, startMs: line.startMs, text });
  }
  return { merged, dropped };
}

function rowOf(line: MergedLine): TranscriptRow {
  return [
    line.fromSeq,
    line.speaker,
    formatOffset(line.startMs),
    clipText(line.text, ROW_MAX_CHARS),
  ];
}

function gapRow(omitted: number, startMs: number): TranscriptRow {
  return [null, '', formatOffset(startMs), `[... ${omitted} lines omitted ...]`];
}

/** Characters a row adds to the JSON array, its comma included. */
const rowCost = (row: TranscriptRow) => JSON.stringify(row).length + 1;

/**
 * The rows that fit `budget` characters: all of them, or the start and the
 * end of the meeting with the middle trimmed evenly (a line from each end in
 * turn) and one marker where the gap is.
 */
export function fitRows(
  lines: readonly MergedLine[],
  budget: number,
): { rows: TranscriptRow[]; kept: MergedLine[]; omitted: number } {
  const rows = lines.map(rowOf);
  const total = rows.reduce((sum, row) => sum + rowCost(row), 0);
  if (total <= budget) return { rows, kept: [...lines], omitted: 0 };

  const markerCost = rowCost(gapRow(lines.length, 359_999_000));
  let room = budget - markerCost;
  let head = 0;
  let tail = 0;
  let headOpen = true;
  let tailOpen = true;
  let turn: 'head' | 'tail' = 'head';
  while ((headOpen || tailOpen) && head + tail < rows.length) {
    if (turn === 'head' && headOpen) {
      const cost = rowCost(rows[head] as TranscriptRow);
      if (cost <= room) {
        room -= cost;
        head += 1;
      } else headOpen = false;
    } else if (turn === 'tail' && tailOpen) {
      const cost = rowCost(rows[rows.length - 1 - tail] as TranscriptRow);
      if (cost <= room) {
        room -= cost;
        tail += 1;
      } else tailOpen = false;
    }
    turn = turn === 'head' ? 'tail' : 'head';
  }
  const omitted = rows.length - head - tail;
  const firstGone = lines[head];
  const kept = [...lines.slice(0, head), ...lines.slice(lines.length - tail)];
  return {
    rows: [
      ...rows.slice(0, head),
      gapRow(omitted, firstGone?.startMs ?? 0),
      ...rows.slice(rows.length - tail),
    ],
    kept,
    omitted,
  };
}

export interface NotesRequestInput {
  requestId: string;
  meetingId: string;
  title: string;
  /** When the meeting happened, ISO. */
  when: string;
  timezone: string;
  /** Names and roles only: never an address. */
  attendees: { name: string; role: string }[];
  template: {
    name: string;
    sections: readonly TemplateSection[];
    instructions: string;
  } | null;
  typedNotes: string | null;
  lines: readonly CondenseLine[];
  /** The Slack channel the routine posts its NOTES_RESULT_V1 to. */
  relayChannel: string;
}

export interface BuiltNotesRequest {
  text: string;
  lineMap: Record<string, NotesLineRef>;
  /** Lines sent (after merging). */
  sent: number;
  omitted: number;
  dropped: number;
}

const TYPED_MAX_SHARE = 0.2;
const TYPED_MAX_CHARS = 12_000;
/** Kept free under the budget for JSON escaping surprises. */
const SAFETY_CHARS = 200;

const short = (text: string, max: number) =>
  clipText(noBackticks(text).replace(/\s+/g, ' ').trim(), max);

/**
 * The NOTES_REQUEST_V1 text for one meeting, at most `maxChars` long, and the
 * map from every line id in it to the seqs it stands for.
 */
export function buildNotesRequest(input: NotesRequestInput, maxChars: number): BuiltNotesRequest {
  const { merged, dropped } = condenseLines(input.lines);
  const typedCap = Math.min(TYPED_MAX_CHARS, Math.floor(maxChars * TYPED_MAX_SHARE));
  const typed = input.typedNotes ? clipText(noBackticks(input.typedNotes).trim(), typedCap) : '';
  const payload = {
    request_id: input.requestId,
    meeting_id: input.meetingId,
    title: short(input.title, 300),
    when: input.when,
    timezone: input.timezone,
    attendees: input.attendees.slice(0, 40).map((a) => ({
      name: short(a.name, 120),
      role: short(a.role, 40),
    })),
    template: input.template
      ? {
          name: short(input.template.name, 120),
          sections: input.template.sections.slice(0, 15).map((s) => ({
            heading: short(s.heading, 120),
            prompt: short(s.prompt, 400),
          })),
          instructions: short(input.template.instructions, 1_500),
        }
      : null,
    typed_notes: typed,
    transcript: [] as TranscriptRow[],
    relay_channel: input.relayChannel,
  };
  const wrap = (body: unknown) => `${NOTES_REQUEST_MARKER}\n\`${JSON.stringify(body)}\``;
  const overhead = wrap(payload).length;
  const fitted = fitRows(merged, Math.max(0, maxChars - overhead - SAFETY_CHARS));
  payload.transcript = fitted.rows;
  const lineMap: Record<string, NotesLineRef> = {};
  for (const line of fitted.kept) {
    lineMap[String(line.fromSeq)] = { fromSeq: line.fromSeq, toSeq: line.toSeq };
  }
  return {
    text: wrap(payload),
    lineMap,
    sent: fitted.kept.length,
    omitted: fitted.omitted,
    dropped,
  };
}

/* ============================================================= result == */

/** One cited id, or a list of them; anything else reads as none. */
const sourceIds = z
  .preprocess(
    (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]),
    z.array(z.unknown()),
  )
  .transform((list) =>
    list
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : v))
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(0, 40),
  );

const textItem = z.preprocess(
  (v) => (typeof v === 'string' ? { text: v } : v),
  z.object({ text: z.unknown(), sources: sourceIds.optional() }).passthrough(),
);

/** A list read row by row: a row that does not parse is left out, never the whole result. */
function rows<T extends z.ZodType>(item: T, max: number) {
  return z
    .preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown()))
    .transform((list) =>
      list.slice(0, max).flatMap((row) => {
        const parsed = item.safeParse(row);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      }),
    );
}

const sectionSchema = z.object({
  heading: z.unknown(),
  bullets: rows(textItem, 40),
});

const actionSchema = z
  .object({
    text: z.unknown(),
    owner_name: z.unknown().optional(),
    due: z.unknown().optional(),
    is_nick_promise: z.unknown().optional(),
    sources: sourceIds.optional(),
  })
  .passthrough();

export const notesFragmentSchema = z
  .object({
    summary: z.unknown().optional(),
    summary_sources: sourceIds.optional(),
    sections: rows(sectionSchema, 20).optional(),
    action_items: rows(actionSchema, 40).optional(),
    decisions: rows(textItem, 30).optional(),
    open_questions: rows(textItem, 30).optional(),
  })
  .passthrough();
export type NotesFragment = z.infer<typeof notesFragmentSchema>;

export const notesResultPartSchema = z.object({
  request_id: z.string().uuid(),
  part: z.coerce.number().int().min(1).max(20).catch(1),
  of: z.coerce.number().int().min(1).max(20).catch(1),
  /** The routine could not write them: why, in plain words. */
  error: z.unknown().optional(),
  notes: notesFragmentSchema.optional(),
});
export type NotesResultPart = z.infer<typeof notesResultPartSchema>;

const MAX_RESULT_JSON = 60_000;

/** One Slack message's text → the NOTES_RESULT_V1 part it carries, or null. */
export function parseNotesResultMessage(rawText: unknown): NotesResultPart | null {
  if (typeof rawText !== 'string') return null;
  const text = unwrapSlackText(rawText, { preferLabel: true }).trim();
  if (!text.startsWith(NOTES_RESULT_MARKER)) return null;
  let json = /`([^`]+)`/.exec(text)?.[1]?.trim();
  if (!json || json.length > MAX_RESULT_JSON) return null;
  if (json.startsWith('json')) json = json.slice(4).trim();
  try {
    const parsed = notesResultPartSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    if (parsed.data.part > parsed.data.of) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** What `notes_requests.parts` holds while a result arrives. */
export interface StoredParts {
  of: number;
  got: Record<string, unknown>;
  error?: string;
}

export function readStoredParts(value: unknown): StoredParts | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredParts>;
  if (typeof v.of !== 'number' || !v.got || typeof v.got !== 'object') return null;
  return { of: v.of, got: v.got, ...(typeof v.error === 'string' ? { error: v.error } : {}) };
}

/**
 * Parts of one request, new and already stored, put together. The first part
 * that says how many there are decides; a part repeated is the same part.
 * `complete` once every part from 1 to `of` is here, or as soon as one says
 * the routine could not write the notes.
 */
export function collectParts(
  stored: StoredParts | null,
  incoming: readonly NotesResultPart[],
): { parts: StoredParts; complete: boolean } {
  const parts: StoredParts = stored
    ? { of: stored.of, got: { ...stored.got }, ...(stored.error ? { error: stored.error } : {}) }
    : { of: incoming[0]?.of ?? 1, got: {} };
  for (const part of incoming) {
    const why = plainText(part.error, 280);
    if (why && !part.notes) {
      parts.error = why;
      continue;
    }
    if (!part.notes) continue;
    if (!(String(part.part) in parts.got)) parts.got[String(part.part)] = part.notes;
  }
  if (parts.error) return { parts, complete: true };
  let complete = true;
  for (let i = 1; i <= parts.of; i++) if (!(String(i) in parts.got)) complete = false;
  return { parts, complete };
}

/** The parts' notes as one, in part order: sections with the same heading become one. */
export function mergeFragments(parts: StoredParts): NotesFragment {
  const ordered: NotesFragment[] = [];
  for (let i = 1; i <= parts.of; i++) {
    const parsed = notesFragmentSchema.safeParse(parts.got[String(i)] ?? {});
    if (parsed.success) ordered.push(parsed.data);
  }
  const summaries: string[] = [];
  const summarySources: string[] = [];
  const sections: { heading: unknown; bullets: z.infer<typeof textItem>[] }[] = [];
  const actions: z.infer<typeof actionSchema>[] = [];
  const decisions: z.infer<typeof textItem>[] = [];
  const questions: z.infer<typeof textItem>[] = [];
  for (const f of ordered) {
    if (typeof f.summary === 'string' && f.summary.trim()) summaries.push(f.summary.trim());
    summarySources.push(...(f.summary_sources ?? []));
    for (const s of f.sections ?? []) {
      const key = typeof s.heading === 'string' ? s.heading.trim().toLowerCase() : '';
      const same = key
        ? sections.find(
            (x) => typeof x.heading === 'string' && x.heading.trim().toLowerCase() === key,
          )
        : undefined;
      if (same) same.bullets.push(...s.bullets);
      else sections.push({ heading: s.heading, bullets: [...s.bullets] });
    }
    actions.push(...(f.action_items ?? []));
    decisions.push(...(f.decisions ?? []));
    questions.push(...(f.open_questions ?? []));
  }
  return {
    summary: summaries.join(' '),
    summary_sources: summarySources,
    sections,
    action_items: actions,
    decisions,
    open_questions: questions,
  };
}

/* =========================================================== assembly == */

export interface RoutineSpeaker {
  clusterKey: string;
  name: string;
  email: string | null;
  isPrincipal: boolean;
}

export interface AssembleInput {
  notes: NotesFragment;
  lineMap: Readonly<Record<string, NotesLineRef>>;
  /** The notepad, word for word: put back by the app, never by the routine. */
  typedNotes: string | null;
  speakers: readonly RoutineSpeaker[];
  /** The principal's (Nick's) name, for an owner the voices do not name. */
  principalName: string | null;
  /** YYYY-MM-DD: due dates said in words are read relative to it. */
  meetingDay: string;
  /** The items before this result: tasks already made from them carry over. */
  previous?: readonly ActionItem[];
}

export interface AssembledNotes {
  blocks: EnhancedBlock[];
  actionItems: ActionItem[];
  /** Points the routine wrote (bullets, decisions, questions, the summary). */
  points: number;
  /** Cited ids that were not in the request, dropped. */
  unknownIds: number;
}

const HEADING_MAX = 120;
const BULLET_MAX = 500;
const SUMMARY_MAX = 1_500;
const ACTION_MAX = 300;
const MAX_SECTIONS = 12;
const MAX_BULLETS = 25;
const MAX_LIST = 15;
const MAX_ACTIONS = 30;
const MAX_BLOCKS = 160;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** "[12]", "[12, 14]" or "[L12]" written into a point's own words. */
const INLINE_CITE_RE = /\s*\[(?:L?\d{1,7})(?:\s*[,;]\s*L?\d{1,7})*\]/g;

/** Cited ids that were sent, as the seq ranges they stand for; the rest counted and dropped. */
export function rangesFor(
  ids: readonly string[],
  lineMap: Readonly<Record<string, NotesLineRef>>,
): { ranges: SegmentRange[]; unknown: number } {
  const ranges: SegmentRange[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  for (const raw of ids) {
    const id = String(raw).trim().replace(/^L/i, '');
    const ref = lineMap[id];
    if (!ref) {
      unknown += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ranges.push({ fromSeq: ref.fromSeq, toSeq: ref.toSeq });
  }
  ranges.sort((a, b) => a.fromSeq - b.fromSeq);
  return { ranges: ranges.slice(0, 12), unknown };
}

/** A point's words with its inline citations lifted out into its sources. */
function liftInline(value: unknown, ids: readonly string[]): { text: string; ids: string[] } {
  if (typeof value !== 'string') return { text: '', ids: [...ids] };
  const found: string[] = [];
  const text = value.replace(INLINE_CITE_RE, (match) => {
    found.push(...(match.match(/\d{1,7}/g) ?? []));
    return '';
  });
  return { text, ids: [...ids, ...found] };
}

/** A point as the schema reads it, or a bare string (a point with no sources). */
function asItem(value: unknown): { text: unknown; sources: string[] } {
  if (typeof value === 'string') return { text: value, sources: [] };
  const v = (value ?? {}) as { text?: unknown; sources?: unknown };
  const sources = Array.isArray(v.sources) ? v.sources.map((x) => String(x)) : [];
  return { text: v.text, sources };
}

function hashKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function ownerOf(name: string, speakers: readonly RoutineSpeaker[]): RoutineSpeaker | null {
  const key = nameKey(name);
  if (!key) return null;
  const exact = speakers.find((s) => nameKey(s.name) === key);
  if (exact) return exact;
  // "Dana" for "Dana Reyes": only when exactly one voice has that first name.
  const first = speakers.filter((s) => nameKey(s.name).split(' ')[0] === key.split(' ')[0]);
  return first.length === 1 ? (first[0] as RoutineSpeaker) : null;
}

/**
 * The routine's notes as the blocks and action items Kraken stores: the
 * typed lines first, word for word, then the summary, the template's sections,
 * decisions, open questions and the action items, each point linked to the
 * lines it cites.
 */
export function assembleRoutineNotes(input: AssembleInput): AssembledNotes {
  const blocks: EnhancedBlock[] = [...parseTypedNotes(input.typedNotes)];
  let points = 0;
  let unknownIds = 0;
  const add = (block: EnhancedBlock) => {
    if (blocks.length < MAX_BLOCKS) blocks.push(block);
  };
  const point = (
    id: string,
    kind: 'bullet' | 'paragraph',
    value: unknown,
    ids: readonly string[],
    max: number,
  ) => {
    const lifted = liftInline(value, ids);
    const text = plainText(lifted.text, max);
    if (!text) return false;
    const { ranges, unknown } = rangesFor(lifted.ids, input.lineMap);
    unknownIds += unknown;
    add({ id, kind, text, depth: 0, source: 'ai', sources: ranges });
    points += 1;
    return true;
  };
  const heading = (id: string, text: string) =>
    add({ id, kind: 'heading', text, depth: 0, source: 'ai', sources: [] });

  const summary = input.notes.summary;
  if (typeof summary === 'string' && plainText(summary, SUMMARY_MAX)) {
    heading('ar-summary', 'Summary');
    point('ar-summary-text', 'paragraph', summary, input.notes.summary_sources ?? [], SUMMARY_MAX);
  }

  (input.notes.sections ?? []).slice(0, MAX_SECTIONS).forEach((section, s) => {
    const title = plainText(section.heading, HEADING_MAX);
    const before = blocks.length;
    if (title) heading(`ar-s${s}`, title);
    let wrote = 0;
    section.bullets.slice(0, MAX_BULLETS).forEach((bullet, b) => {
      const item = asItem(bullet);
      if (point(`ar-s${s}-b${b}`, 'bullet', item.text, item.sources, BULLET_MAX)) wrote += 1;
    });
    // A heading with nothing under it goes.
    if (wrote === 0) blocks.length = before;
  });

  const list = (key: 'decisions' | 'open_questions', title: string, prefix: string) => {
    const items = (input.notes[key] ?? []).slice(0, MAX_LIST);
    const before = blocks.length;
    heading(`ar-${prefix}`, title);
    let wrote = 0;
    items.forEach((raw, i) => {
      const item = asItem(raw);
      if (point(`ar-${prefix}-${i}`, 'bullet', item.text, item.sources, BULLET_MAX)) wrote += 1;
    });
    if (wrote === 0) blocks.length = before;
  };
  list('decisions', 'Decisions', 'dec');
  list('open_questions', 'Open questions', 'q');

  const previous = input.previous ?? [];
  const actionItems: ActionItem[] = [];
  const principal = input.speakers.find((s) => s.isPrincipal) ?? null;
  for (const raw of (input.notes.action_items ?? []).slice(0, MAX_ACTIONS)) {
    const lifted = liftInline(raw.text, raw.sources ?? []);
    const text = plainText(lifted.text, ACTION_MAX);
    if (!text) continue;
    const ownerName = plainText(raw.owner_name, 120) || null;
    const owner = ownerName ? ownerOf(ownerName, input.speakers) : null;
    const flagged = raw.is_nick_promise === true || raw.is_nick_promise === 'true';
    const isPrincipal =
      flagged ||
      Boolean(owner?.isPrincipal) ||
      Boolean(
        ownerName && input.principalName && nameKey(ownerName) === nameKey(input.principalName),
      );
    const dueText = plainText(raw.due, 60);
    const due =
      DATE_RE.test(dueText) && !Number.isNaN(Date.parse(`${dueText}T12:00:00Z`))
        ? dueText
        : dueText
          ? dueFromText(dueText, input.meetingDay)
          : null;
    const { ranges, unknown } = rangesFor(lifted.ids, input.lineMap);
    unknownIds += unknown;
    const id = `ar-action-${hashKey(text.toLowerCase())}`;
    if (actionItems.some((a) => a.id === id)) continue;
    const named = owner ?? (isPrincipal ? principal : null);
    actionItems.push({
      id,
      text,
      ownerEmail: named?.email ?? null,
      ownerName: named?.name ?? ownerName,
      ownerClusterKey: named?.clusterKey ?? null,
      due,
      isPrincipalPromise: isPrincipal,
      taskId: carriedTaskId(previous, id, text),
      sources: ranges,
    });
  }
  if (actionItems.length) {
    heading('ar-actions', 'Action items');
    for (const a of actionItems) {
      add({
        id: `ai-box-${a.id}`,
        kind: 'checkbox',
        text: `${a.ownerName ?? 'Someone'}: ${a.text}`,
        depth: 0,
        source: 'ai',
        sources: a.sources,
        checked: false,
      });
    }
  }
  return { blocks, actionItems, points, unknownIds };
}

/* =========================================================== renaming == */

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Notes after voices were renamed, with no new request: every whole-word
 * mention of an old name in what the routine wrote becomes the new name.
 * Typed lines are the person's own words and are never touched.
 */
export function renameInBlocks(
  blocks: readonly EnhancedBlock[],
  renames: ReadonlyMap<string, string>,
): { blocks: EnhancedBlock[]; changed: number } {
  const pairs = [...renames]
    .filter(([from, to]) => from.trim() && to.trim() && from !== to)
    .sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return { blocks: [...blocks], changed: 0 };
  let changed = 0;
  const out = blocks.map((block) => {
    if (block.source !== 'ai') return block;
    let text = block.text;
    for (const [from, to] of pairs) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, 'gu');
      text = text.replace(re, (_match, lead: string) => `${lead}${to}`);
    }
    if (text === block.text) return block;
    changed += 1;
    return { ...block, text };
  });
  return { blocks: out, changed };
}
