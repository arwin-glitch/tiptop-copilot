import 'server-only';
import { env } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore, Filter } from '@/lib/db/store';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { fireRoutineWithText, readRelayChannel } from '@/lib/services/ask-routine';
import type { BookingChatQuestion } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { FAQ_LIMITS, type ChatbotConfig, type FaqItem } from './chatbot-config';

/**
 * The booking page assistant's optional AI answers (D-078), on Arwin's own
 * Claude plan: no API key, no model call from this app, nothing billed.
 *
 * A question no written answer matches is kept in `booking_chat_questions`
 * and sent to the booking assistant routine (a Claude Code routine with no
 * data connectors, docs/BOOKING_CHAT_ROUTINE.md) through its API trigger, as
 * `BOOKING_QUESTION_V1` and one backticked JSON object: the question and the
 * page's public facts, nothing else. The routine posts `BOOKING_ANSWER_V1`
 * and `{question_id, answer}` to the Slack relay the app already reads; while
 * the visitor's widget waits, the app reads that channel, takes only posts
 * from the configured posters, matches the question id, and makes the answer
 * plain before anyone sees it (`sanitiseBookingAnswer`).
 *
 * Off unless BOOKING_CHAT_FIRE_URL, BOOKING_CHAT_TOKEN and the relay's read
 * token are all set and the Booking tab turns AI answers on. Capped three
 * ways: 3 per visitor session (in memory), 5 per visitor address a day and
 * the Booking tab's daily total (both counted from the table, so they hold
 * across restarts). Past any cap, or with the table missing, the assistant
 * answers from the written questions only.
 */

export const BOOKING_QUESTION_MARKER = 'BOOKING_QUESTION_V1';
export const BOOKING_ANSWER_MARKER = 'BOOKING_ANSWER_V1';

export const QUESTION_MAX_CHARS = 300;
export const ANSWER_MAX_CHARS = 600;
/** How long the widget waits for an answer before offering to leave a message. */
export const ANSWER_WAIT_MS = 3 * 60_000;
/** A question still waiting this long is expired (a little past the widget's wait). */
export const EXPIRE_AFTER_MS = 5 * 60_000;

export const PER_SESSION = 3;
export const PER_ADDRESS_PER_DAY = 5;
const SESSION_WINDOW_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_SLACK_CHECK_INTERVAL_MS = 3_000;

const FACT_LIMITS = { offers: 8, times: 6, text: 600, profile: 1200 } as const;

/* ------------------------------------------------------------------ setup */

/** The routine can be fired and its answer read back. */
export function bookingChatConfigured(e = env()): boolean {
  return Boolean(e.bookingChatFireUrl && e.bookingChatToken && e.askRelaySlackToken);
}

/* ---------------------------------------------------------------- payload */

/** What the routine is told about the page: public facts only, by name. */
export interface BookingQuestionFacts {
  host_name: string;
  firm: string;
  /** The public card's title and bio, as Arwin wrote them. */
  profile_text: string;
  faq: FaqItem[];
  /** What can be booked, e.g. "30-min call (video)", and the listed places. */
  offers: string[];
  /** The next open times, labelled in the visitor's zone. */
  next_open_times: string[];
}

export interface BookingQuestionPayload {
  question_id: string;
  question: string;
  facts: BookingQuestionFacts;
}

/**
 * One line of text made safe to carry inside the backticked JSON: no
 * control, invisible or direction characters, no backticks (they would end
 * the fence early), no angle brackets, spaces collapsed, cut to `max`.
 */
export function plainLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[`<>]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** A visitor's question as it may be sent: at most 300 characters of plain text. */
export function cleanQuestion(text: unknown): string {
  return plainLine(text, QUESTION_MAX_CHARS);
}

export interface FactsInput {
  hostName: string;
  firmName: string;
  title: string;
  bio: string;
  faqItems: readonly FaqItem[];
  offers: readonly string[];
  nextOpenTimes: readonly string[];
}

/**
 * The facts block, built from named public fields only. Nothing else can
 * reach it: no calendar entry, no email address, no home city, no request,
 * no id other than the question's own.
 */
export function buildQuestionFacts(input: FactsInput): BookingQuestionFacts {
  return {
    host_name: plainLine(input.hostName, 80),
    firm: plainLine(input.firmName, 80),
    profile_text: plainLine(
      [input.title, input.bio].filter((v) => v && v.trim()).join('. '),
      FACT_LIMITS.profile,
    ),
    faq: input.faqItems.slice(0, FAQ_LIMITS.items).map((item) => ({
      q: plainLine(item.q, FAQ_LIMITS.question),
      a: plainLine(item.a, FAQ_LIMITS.answer),
    })),
    offers: input.offers
      .map((o) => plainLine(o, FACT_LIMITS.text))
      .filter(Boolean)
      .slice(0, FACT_LIMITS.offers),
    next_open_times: input.nextOpenTimes
      .map((t) => plainLine(t, 80))
      .filter(Boolean)
      .slice(0, FACT_LIMITS.times),
  };
}

/** What the routine is fired with: the marker line, then the payload as one backticked JSON object. */
export function bookingQuestionText(payload: BookingQuestionPayload): string {
  return [
    BOOKING_QUESTION_MARKER,
    `\`${JSON.stringify({
      question_id: payload.question_id,
      question: cleanQuestion(payload.question),
      facts: payload.facts,
    })}\``,
  ].join('\n');
}

/* ----------------------------------------------------------------- answer */

export interface RelayedBookingAnswer {
  question_id: string;
  answer: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One relay message's text → the booking answer it carries, or null. */
export function parseBookingAnswer(rawText: unknown): RelayedBookingAnswer | null {
  if (typeof rawText !== 'string') return null;
  // Slack's link markup first (an answer naming the booking link gets
  // auto-linked, swallowing the closing quote), as the Ask relay does.
  const text = unwrapSlackText(rawText, { preferLabel: true }).trim();
  if (!text.startsWith(BOOKING_ANSWER_MARKER)) return null;
  const first = text.indexOf('`');
  const last = text.lastIndexOf('`');
  if (first < 0 || last <= first) return null;
  try {
    const payload = JSON.parse(text.slice(first + 1, last)) as Partial<RelayedBookingAnswer>;
    if (
      typeof payload.question_id !== 'string' ||
      !UUID.test(payload.question_id) ||
      typeof payload.answer !== 'string' ||
      !payload.answer.trim()
    ) {
      return null;
    }
    return {
      question_id: payload.question_id.toLowerCase(),
      answer: payload.answer.slice(0, 4000),
    };
  } catch {
    log.warn('Booking answer in the relay channel is not valid JSON', { length: text.length });
    return null;
  }
}

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/**
 * A link: a full address with its scheme or www, or a bare lower-case domain
 * ("fund.example/apply"). One pattern, so a full address is taken whole and
 * never matched again from its middle.
 */
const URL_RE =
  /(?:\b[hH][tT][tT][pP][sS]?:\/\/|\b[wW]{3}\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/[^\s]*)?/g;
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const CONFIRM_WORD =
  /\b(confirm\w*|approv\w*|review\w*|get(?:s|ting)? back|follow(?:s|ing)? up|reach(?:es|ing)? out|be in touch|check(?:s|ing)? with)\b/i;
const PROMISE_WORD =
  /\b(will|shall|going to|until|once|pending|wait(?:ing)? for|after (?:he|she|they|someone|nick|arwin|the team))\b|['’]ll\b/i;

function linkKey(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#]+$/, '');
}

/**
 * The routine's answer made safe to show a visitor: plain text (no markup,
 * no tags, no code), no link except this booking page's own, no email
 * address, no phone number, no sentence promising that a person will
 * confirm, review or get back to them, at most 600 characters. Null when
 * nothing worth showing is left.
 */
export function sanitiseBookingAnswer(
  raw: unknown,
  options: { bookingUrl: string },
): string | null {
  if (typeof raw !== 'string') return null;
  const booking = linkKey(options.bookingUrl);
  let text = unwrapSlackText(raw, { preferLabel: true })
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(EMAIL_RE, ' ');
  text = text.replace(URL_RE, (match) => {
    const trimmed = match.replace(/[.,;:!?)\]'"]+$/, '');
    const tail = match.slice(trimmed.length);
    const key = linkKey(trimmed);
    if (booking && (key === booking || key.startsWith(`${booking}/`))) {
      return `${options.bookingUrl}${tail}`;
    }
    return ` ${tail}`;
  });
  text = text.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    const trimmed = match.trim();
    if (digits.length < 7 || digits.length > 15) return match;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(trimmed) || /^\d{4}\s*[-–]\s*\d{4}$/.test(trimmed)) {
      return match;
    }
    return ' ';
  });
  text = text
    .replace(/[*_`#~|]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    return !(CONFIRM_WORD.test(sentence) && PROMISE_WORD.test(sentence));
  });
  text = sentences
    .join(' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (text.length > ANSWER_MAX_CHARS) {
    const cut = text.slice(0, ANSWER_MAX_CHARS - 1);
    const space = cut.lastIndexOf(' ');
    text = `${(space > ANSWER_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
  }
  return /\p{L}.*\p{L}/u.test(text) ? text : null;
}

/* ------------------------------------------------------------------- asks */

export type AskUnavailable =
  'off' | 'not_set_up' | 'session_cap' | 'address_cap' | 'daily_cap' | 'no_table' | 'fire_failed';

export type AskOutcome =
  { kind: 'pending'; id: string } | { kind: 'unavailable'; reason: AskUnavailable };

/** Questions are counted and kept one at a time per organization, so the caps cannot be raced. */
const askLocks = processWide('booking-chat-ask-locks', () => new Map<string, Promise<void>>());

async function oneAtATime<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
  const before = askLocks.get(organizationId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  askLocks.set(organizationId, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (askLocks.get(organizationId) === tail) askLocks.delete(organizationId);
  }
}

export interface AskInput {
  organizationId: string;
  chatbot: Pick<ChatbotConfig, 'aiAnswers' | 'dailyAiCap'>;
  question: string;
  /** The widget's own random id for this visit, for the per-session cap. */
  sessionId: string;
  /** A keyed hash of the visitor's address (lib/security/crypto hashIp). */
  ipHash: string | null;
  facts: BookingQuestionFacts;
  now?: Date;
  fetchImpl?: typeof fetch;
}

/**
 * Send one question to the booking assistant routine, within every cap.
 * Pending with the question's id when it went; otherwise why not, and the
 * widget answers from the written questions only.
 */
export async function askBookingRoutine(store: DataStore, input: AskInput): Promise<AskOutcome> {
  const unavailable = (reason: AskUnavailable): AskOutcome => ({ kind: 'unavailable', reason });
  if (!input.chatbot.aiAnswers) return unavailable('off');
  const e = env();
  if (!bookingChatConfigured(e) || !e.bookingChatFireUrl || !e.bookingChatToken) {
    return unavailable('not_set_up');
  }
  if (input.chatbot.dailyAiCap <= 0) return unavailable('daily_cap');
  const question = cleanQuestion(input.question);
  if (!question) return unavailable('off');
  const sessionKey = `booking-ai-session:${input.sessionId}`;
  if (!rateLimitHasRoom(sessionKey, PER_SESSION)) return unavailable('session_cap');
  const now = input.now ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();

  const kept = await oneAtATime(input.organizationId, async () => {
    try {
      const byAddress: Filter = input.ipHash
        ? { eq: { ip_hash: input.ipHash }, gte: { created_at: dayAgo } }
        : { isNull: ['ip_hash'], gte: { created_at: dayAgo } };
      const [fromAddress, today] = await Promise.all([
        store.count('booking_chat_questions', input.organizationId, byAddress),
        store.count('booking_chat_questions', input.organizationId, {
          gte: { created_at: dayAgo },
        }),
      ]);
      if (fromAddress >= PER_ADDRESS_PER_DAY) return unavailable('address_cap');
      if (today >= input.chatbot.dailyAiCap) return unavailable('daily_cap');
      const row: BookingChatQuestion = {
        id: newId(),
        organization_id: input.organizationId,
        question,
        answer: null,
        status: 'pending',
        ip_hash: input.ipHash,
        created_at: now.toISOString(),
        answered_at: null,
      };
      await store.insert('booking_chat_questions', row);
      return row;
    } catch (error) {
      if (isMissingTableError(error)) return unavailable('no_table');
      log.warn('Booking question could not be kept', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return unavailable('no_table');
    }
  });
  if ('kind' in kept) return kept;

  rateLimit(sessionKey, PER_SESSION, SESSION_WINDOW_MS);
  const fired = await fireRoutineWithText(
    { url: e.bookingChatFireUrl, token: e.bookingChatToken },
    bookingQuestionText({ question_id: kept.id, question, facts: input.facts }),
    input.fetchImpl,
    'Booking assistant routine',
  );
  if (!fired) {
    await store
      .updateWhere(
        'booking_chat_questions',
        input.organizationId,
        { eq: { id: kept.id, status: 'pending' } },
        { status: 'expired' },
      )
      .catch(() => []);
    return unavailable('fire_failed');
  }
  return { kind: 'pending', id: kept.id };
}

/* ----------------------------------------------------------------- settle */

const settleState = processWide('booking-chat-settle', () => ({
  lastSlackCheck: 0,
  inFlight: null as Promise<number> | null,
}));

/** Test hook: the throttle is process-wide. */
export function resetBookingSettleThrottle(): void {
  settleState.lastSlackCheck = 0;
  settleState.inFlight = null;
}

/** Questions still waiting past EXPIRE_AFTER_MS become expired. */
async function expireStale(store: DataStore, organizationId: string, now: Date): Promise<void> {
  await store.updateWhere(
    'booking_chat_questions',
    organizationId,
    {
      eq: { status: 'pending' },
      lt: { created_at: new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString() },
    },
    { status: 'expired' },
  );
}

/**
 * If a question is waiting, read the relay channel and complete every one
 * whose answer is there, from the configured posters only, made plain
 * first. Returns how many were settled. Throttled: the widget polls.
 */
export async function settleBookingAnswers(
  store: DataStore,
  organizationId: string,
  options: { bookingUrl: string; now?: Date; fetchImpl?: typeof fetch },
): Promise<number> {
  const e = env();
  if (!e.askRelaySlackToken) return 0;
  if (settleState.inFlight) return settleState.inFlight;
  if (Date.now() - settleState.lastSlackCheck < MIN_SLACK_CHECK_INTERVAL_MS) return 0;
  const now = options.now ?? new Date();
  settleState.inFlight = (async () => {
    try {
      await expireStale(store, organizationId, now);
      const pending = await store.list('booking_chat_questions', organizationId, {
        eq: { status: 'pending' },
      });
      if (pending.length === 0) return 0;
      const messages = await readRelayChannel(e.bookingChatRelayChannelId, options.fetchImpl);
      if (!messages) return 0;
      const posters = e.bookingChatPosterIds;
      const waiting = new Set(pending.map((p) => p.id.toLowerCase()));
      let settled = 0;
      for (const message of messages) {
        if (message.subtype !== undefined && message.subtype !== null) continue;
        if (
          posters.length > 0 &&
          !(typeof message.user === 'string' && posters.includes(message.user))
        ) {
          continue;
        }
        const relayed = parseBookingAnswer(message.text);
        if (!relayed || !waiting.has(relayed.question_id)) continue;
        const answer = sanitiseBookingAnswer(relayed.answer, { bookingUrl: options.bookingUrl });
        const id = pending.find((p) => p.id.toLowerCase() === relayed.question_id)!.id;
        const changed = await store.updateWhere(
          'booking_chat_questions',
          organizationId,
          { eq: { id, status: 'pending' } },
          answer
            ? { status: 'answered', answer, answered_at: now.toISOString() }
            : { status: 'expired', answered_at: now.toISOString() },
        );
        waiting.delete(relayed.question_id);
        if (changed.length > 0) settled++;
      }
      return settled;
    } catch (error) {
      if (!isMissingTableError(error)) {
        log.warn('Settling booking answers from Slack failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      return 0;
    } finally {
      settleState.lastSlackCheck = Date.now();
      settleState.inFlight = null;
    }
  })();
  return settleState.inFlight;
}

export interface BookingAnswerView {
  status: BookingChatQuestion['status'];
  answer: string | null;
}

/**
 * Where one question stands, for the widget's poll: settles from the relay
 * first (throttled) while it waits, and expires it once it has waited too
 * long. Null for an id that is not a question here.
 */
export async function readBookingAnswer(
  store: DataStore,
  organizationId: string,
  id: string,
  options: { bookingUrl: string; now?: Date; fetchImpl?: typeof fetch },
): Promise<BookingAnswerView | null> {
  if (!UUID.test(id)) return null;
  const now = options.now ?? new Date();
  const read = async () => {
    try {
      return await store.get('booking_chat_questions', organizationId, id);
    } catch (error) {
      if (isMissingTableError(error)) return null;
      throw error;
    }
  };
  let row = await read();
  if (!row) return null;
  if (row.status === 'pending') {
    if (now.getTime() - Date.parse(row.created_at) > EXPIRE_AFTER_MS) {
      await store
        .updateWhere(
          'booking_chat_questions',
          organizationId,
          { eq: { id: row.id, status: 'pending' } },
          { status: 'expired' },
        )
        .catch(() => []);
      return { status: 'expired', answer: null };
    }
    await settleBookingAnswers(store, organizationId, options);
    row = (await read()) ?? row;
  }
  return { status: row.status, answer: row.status === 'answered' ? row.answer : null };
}

/* ----------------------------------------------------------------- status */

export interface BookingChatStatus {
  /** The routine's trigger and the relay's read token are set. */
  configured: boolean;
  /** The questions table exists. */
  tableReady: boolean;
  lastAnswerAt: string | null;
  /** Questions sent in the last day, for the cap. */
  askedToday: number;
  answeredToday: number;
}

/** For the Booking tab's assistant panel: set up or not, and when it last answered. */
export async function bookingChatStatus(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<BookingChatStatus> {
  const configured = bookingChatConfigured();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  try {
    const [last, askedToday, answeredToday] = await Promise.all([
      store.list(
        'booking_chat_questions',
        organizationId,
        { eq: { status: 'answered' } },
        { orderBy: [{ field: 'answered_at', direction: 'desc' }], limit: 1 },
      ),
      store.count('booking_chat_questions', organizationId, { gte: { created_at: dayAgo } }),
      store.count('booking_chat_questions', organizationId, {
        eq: { status: 'answered' },
        gte: { created_at: dayAgo },
      }),
    ]);
    return {
      configured,
      tableReady: true,
      lastAnswerAt: last[0]?.answered_at ?? null,
      askedToday,
      answeredToday,
    };
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Booking assistant status could not be read', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return { configured, tableReady: false, lastAnswerAt: null, askedToday: 0, answeredToday: 0 };
  }
}
