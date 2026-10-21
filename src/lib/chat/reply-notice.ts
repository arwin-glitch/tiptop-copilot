import type { ChatMessage } from '@/lib/types/domain';
import { stripSlackLinks } from '@/lib/util/slack-text';
import { snippet } from '@/lib/util/text';

/**
 * The "Arwin replied" pop-up: when an answer lands somewhere the reader is not
 * looking, a small card above the Ask Arwin launcher says so for a few
 * seconds, previewing the answer, and opens the conversation when clicked.
 *
 * The rules for when it shows live here, pure, so they are tested without a
 * browser; the widget supplies what it can see (which conversation is on
 * screen, whether the tab is hidden, whether a guided tour is running).
 *
 * - Never for the conversation already on screen.
 * - Never twice for the same answer: every answer id handled is remembered.
 * - Answers that land close together share one pop-up ("Arwin replied to 2
 *   questions"), which opens the newest.
 * - With the tab hidden, or a tour running, it waits; when the tab is back
 *   (within ten minutes) or the tour ends, it shows then. An older answer is
 *   left to the launcher's dot.
 * - With the tab hidden, the page title counts the answers that landed:
 *   "(1) Today".
 */

/** How long the pop-up stays up unless hovered or focused. */
export const REPLY_NOTICE_MS = 3_500;
/** A pop-up held back by a hidden tab is still worth showing within this. */
export const REPLY_DEFER_MAX_MS = 10 * 60_000;
export const REPLY_PREVIEW_MAX = 70;
const QUESTION_MAX = 80;
/** Enough for a long session; the oldest are forgotten first. */
const SEEN_MAX = 60;

export interface ReplyArrival {
  /** The answer's message id. */
  answerId: string;
  threadId: string;
  /** The answer's first line as plain text, clipped; may be empty. */
  preview: string;
  /** The question it answers, as plain text, clipped. */
  question: string | null;
  /** When it was seen to land, in ms. */
  at: number;
}

export interface ReplyNotice {
  /** Oldest first: the last one is the newest, which the pop-up previews and opens. */
  arrivals: ReplyArrival[];
}

export interface ReplyNoticeState {
  /** Answer ids already handled, shown or not, oldest first. */
  seen: string[];
  /** The pop-up on screen. */
  current: ReplyNotice | null;
  /** Held back until the tab is visible and no tour is running. */
  deferred: ReplyNotice | null;
  /** Answers that landed while the tab was hidden, for the title. */
  hiddenCount: number;
}

export interface ReplyContext {
  /** The conversation the reader has in front of them, if any. */
  onScreenThreadId: string | null;
  tabHidden: boolean;
  tourRunning: boolean;
  now: number;
}

/**
 * - `seen`: this answer was handled already.
 * - `on-screen`: its conversation is in front of the reader.
 * - `show`: a new pop-up.
 * - `grouped`: folded into the pop-up already showing.
 * - `deferred`: held back for a hidden tab or a running tour.
 */
export type ReplyOutcome = 'seen' | 'on-screen' | 'show' | 'grouped' | 'deferred';

export const EMPTY_REPLY_STATE: ReplyNoticeState = {
  seen: [],
  current: null,
  deferred: null,
  hiddenCount: 0,
};

/* --------------------------------------------------------------- arrivals */

/**
 * The arrival a conversation's messages describe: its last message, when that
 * is a finished answer. Null while the answer is still on its way.
 */
export function replyArrival(
  threadId: string,
  messages: readonly ChatMessage[],
  now: number,
): ReplyArrival | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.status === 'pending') return null;
  let question: string | null = null;
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      question = plainQuestion(m.content);
      break;
    }
  }
  return { answerId: last.id, threadId, preview: replyPreview(last.content), question, at: now };
}

/**
 * The answer's first line as plain text: Slack and Markdown markup, list
 * markers and citation markers removed, clipped to `max` with an ellipsis.
 * An answer's first line is the direct answer; the rest is support.
 */
export function replyPreview(content: string, max = REPLY_PREVIEW_MAX): string {
  let fenced = false;
  for (const raw of stripSlackLinks(content).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const text = plainLine(line);
    if (text) return snippet(text, max);
  }
  return '';
}

function plainQuestion(text: string): string | null {
  const plain = snippet(stripSlackLinks(text), QUESTION_MAX);
  return plain || null;
}

function plainLine(line: string): string {
  return (
    line
      // Images and links keep their words: ![alt](url), [label](url).
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Citation markers: [1], [1, 2], [^1], [uncited].
      .replace(/\s*\[\^?\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
      .replace(/\s*\[\^[^\]]+\]/g, '')
      .replace(/\s*\[uncited\]/gi, '')
      // Line openers: headings, quotes, bullets, numbered items.
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:>\s*)+/, '')
      .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
      // Emphasis, Markdown and Slack: **b**, __b__, *b*, _i_, ~s~, `code`.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      // Single markers only around words, so "5 * 3" and snake_case survive.
      .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/* ------------------------------------------------------------------ rules */

/** What to do with an answer that just landed. */
export function arriveReply(
  state: ReplyNoticeState,
  arrival: ReplyArrival,
  context: ReplyContext,
): { state: ReplyNoticeState; outcome: ReplyOutcome } {
  if (state.seen.includes(arrival.answerId)) return { state, outcome: 'seen' };
  const seen = rememberSeen(state.seen, [arrival.answerId]);
  const onScreen = context.onScreenThreadId === arrival.threadId;

  if (context.tabHidden) {
    const hiddenCount = state.hiddenCount + 1;
    if (onScreen) return { state: { ...state, seen, hiddenCount }, outcome: 'on-screen' };
    return {
      state: { ...state, seen, hiddenCount, deferred: merge(state.deferred, [arrival]) },
      outcome: 'deferred',
    };
  }
  if (onScreen) return { state: { ...state, seen }, outcome: 'on-screen' };
  if (context.tourRunning) {
    return {
      state: { ...state, seen, deferred: merge(state.deferred, [arrival]) },
      outcome: 'deferred',
    };
  }
  if (state.current) {
    return {
      state: { ...state, seen, current: merge(state.current, [arrival]) },
      outcome: 'grouped',
    };
  }
  return { state: { ...state, seen, current: { arrivals: [arrival] } }, outcome: 'show' };
}

/**
 * The tab is visible again, or a tour ended: whatever was held back shows now,
 * unless it is too old, or its conversation is on screen by now.
 */
export function resumeReplies(state: ReplyNoticeState, context: ReplyContext): ReplyNoticeState {
  if (context.tabHidden) return state;
  const visible = state.hiddenCount === 0 ? state : { ...state, hiddenCount: 0 };
  if (context.tourRunning || !visible.deferred) return visible;
  const fresh = visible.deferred.arrivals.filter(
    (a) => context.now - a.at <= REPLY_DEFER_MAX_MS && a.threadId !== context.onScreenThreadId,
  );
  if (fresh.length === 0) return { ...visible, deferred: null };
  return { ...visible, deferred: null, current: merge(visible.current, fresh) };
}

/** A tour started: a pop-up showing steps aside until it ends. */
export function suspendReplies(state: ReplyNoticeState): ReplyNoticeState {
  if (!state.current) return state;
  return { ...state, current: null, deferred: merge(state.deferred, state.current.arrivals) };
}

/** The pop-up timed out, was closed, or was opened. */
export function dismissReply(state: ReplyNoticeState): ReplyNoticeState {
  return state.current ? { ...state, current: null } : state;
}

/** A conversation was put on screen: nothing needs to point at it any more. */
export function viewedThread(state: ReplyNoticeState, threadId: string): ReplyNoticeState {
  const current = without(state.current, threadId);
  const deferred = without(state.deferred, threadId);
  if (current === state.current && deferred === state.deferred) return state;
  return { ...state, current, deferred };
}

function merge(notice: ReplyNotice | null, arrivals: readonly ReplyArrival[]): ReplyNotice {
  const known = new Set(notice?.arrivals.map((a) => a.answerId));
  return {
    arrivals: [...(notice?.arrivals ?? []), ...arrivals.filter((a) => !known.has(a.answerId))],
  };
}

function without(notice: ReplyNotice | null, threadId: string): ReplyNotice | null {
  if (!notice || !notice.arrivals.some((a) => a.threadId === threadId)) return notice;
  const arrivals = notice.arrivals.filter((a) => a.threadId !== threadId);
  return arrivals.length > 0 ? { arrivals } : null;
}

/* ------------------------------------------------------------------ words */

export function newestArrival(notice: ReplyNotice): ReplyArrival {
  // A notice always holds at least one arrival.
  return notice.arrivals[notice.arrivals.length - 1] as ReplyArrival;
}

/**
 * The assistant's name in a notification outside the app (desktop alerts),
 * which has no room for the "AI" tag the page draws beside it.
 */
export const ARWIN_AI_NAME = 'Arwin (AI)';

/** "Arwin replied", or "Arwin replied to 2 questions"; `name` stands in for "Arwin". */
export function replyHeadline(notice: ReplyNotice, name = 'Arwin'): string {
  const count = notice.arrivals.length;
  return count > 1 ? `${name} replied to ${count} questions` : `${name} replied`;
}

/** What a screen reader is told: the headline and the newest answer's first line. */
export function replyAnnouncement(notice: ReplyNotice): string {
  const preview = newestArrival(notice).preview;
  if (notice.arrivals.length > 1) {
    return preview ? `${replyHeadline(notice)}. Newest: ${preview}` : `${replyHeadline(notice)}.`;
  }
  return preview ? `Arwin replied: ${preview}` : 'Arwin replied.';
}

/** A stable key for one pop-up's content: changes when an answer joins it. */
export function replyKey(notice: ReplyNotice): string {
  return notice.arrivals.map((a) => a.answerId).join('|');
}

/* ------------------------------------------------------------------ title */

const COUNT_PREFIX = /^\(\d+\) /;

/** "(2) Today" while `count` answers wait unread in a hidden tab; the bare title at 0. */
export function titleWithCount(title: string, count: number): string {
  const bare = title.replace(COUNT_PREFIX, '');
  return count > 0 ? `(${count}) ${bare}` : bare;
}

/* ------------------------------------------------------------- seen ids */

export function rememberSeen(seen: readonly string[], ids: readonly string[]): string[] {
  const next = [...seen.filter((id) => !ids.includes(id)), ...ids];
  return next.length > SEEN_MAX ? next.slice(next.length - SEEN_MAX) : next;
}

/** The stored list of seen answer ids; anything malformed reads as none. */
export function parseSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string').slice(-SEEN_MAX);
  } catch {
    return [];
  }
}
