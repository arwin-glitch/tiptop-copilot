import 'server-only';
import { env, perksChatRelayProblem } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore, Filter } from '@/lib/db/store';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import { buildFireCatalog, getPerksKnowledge } from '@/lib/perks-ask/knowledge';
import { fireRoutineWithText, readRelayChannel } from '@/lib/services/ask-routine';
import type { PerksChatQuestion } from '@/lib/types/domain';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { newId, sha256 } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';

/**
 * The perks-site Ask Arwin bridge (D-079, free path), on Arwin's own Claude
 * plan: no API key, no model call from this app, nothing billed - the same
 * rails as the booking assistant (D-078, lib/booking/chat-bridge.ts).
 *
 * A visitor question from perks.tiptop.vc is kept in `perks_chat_questions`
 * and sent to the perks assistant routine (a Claude routine with no data
 * connectors beyond one Slack post, docs/PERKS_CHAT_ROUTINE.md) through its
 * API trigger, as `PERKS_QUESTION_V1` and one backticked JSON object: the
 * question id, a one-time answer key and the visitor's recent questions -
 * followed by a digest of the public perks catalog (lib/perks-ask/knowledge),
 * because the routine's cloud environment has no network access to
 * perks.tiptop.vc. The bot can still never know more than the site shows. The
 * routine posts `PERKS_ANSWER_V1` and `{question_id, answer_key, answer}` to
 * its relay channel; while the widget polls, the app reads that channel,
 * takes only posts from the configured posters, verifies the one-time key
 * timing-safely (only its SHA-256 is kept, cleared once used - so the
 * routine MAY post as the same Slack account the other routines use, the
 * job-board assistant's design), and makes the answer plain before anyone
 * sees it (`sanitisePerksAnswer`: text only, perks.tiptop.vc links only).
 *
 * Off unless PERKS_CHAT_FIRE_URL, PERKS_CHAT_TOKEN,
 * PERKS_CHAT_RELAY_CHANNEL_ID, PERKS_CHAT_POSTER_IDS and the relay's read
 * token are all set. Capped per visitor address a day and in total a day,
 * counted from the table so the caps hold across restarts.
 */

export const PERKS_QUESTION_MARKER = 'PERKS_QUESTION_V1';
export const PERKS_ANSWER_MARKER = 'PERKS_ANSWER_V1';

export const QUESTION_MAX_CHARS = 500;
export const ANSWER_MAX_CHARS = 900;
/** How long the widget polls before falling back to the email line. */
export const ANSWER_WAIT_MS = 150_000;
/** A question still waiting this long is expired (a little past the widget's wait). */
export const EXPIRE_AFTER_MS = 4 * 60_000;

export const PER_ADDRESS_PER_DAY = 20;
export const PER_DAY_TOTAL = 300;
const DAY_MS = 86_400_000;
const MIN_SLACK_CHECK_INTERVAL_MS = 3_000;

const PERKS_SITE = 'https://perks.tiptop.vc';

/* ------------------------------------------------------------------ setup */

/** The routine can be fired and its answer read back, through a safe relay of its own. */
export function perksChatConfigured(e = env()): boolean {
  return (
    Boolean(e.perksChatFireUrl && e.perksChatToken && e.askRelaySlackToken) &&
    perksChatRelayProblem(e) === null
  );
}

/* ---------------------------------------------------------------- payload */

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

/** A visitor's question as it may be sent: plain text, capped. */
export function cleanQuestion(text: unknown): string {
  return plainLine(text, QUESTION_MAX_CHARS);
}

export interface PerksQuestionPayload {
  question_id: string;
  /** The question's one-time answer key, which the routine must echo. */
  answer_key: string;
  /** The visitor's recent questions, oldest first; the last is the live one. */
  questions: string[];
}

/* ------------------------------------------------------------- answer key */

/** 24 random bytes as base64url: 32 characters. */
const ANSWER_KEY = /^[A-Za-z0-9_-]{32}$/;
const KEY_HASH = /^[0-9a-f]{64}$/;

/** A new one-time answer key and the SHA-256 hex kept in its place. */
export function newPerksAnswerKey(): { key: string; hash: string } {
  const key = randomBytes(24).toString('base64url');
  return { key, hash: sha256(key) };
}

/** Whether a relayed key is the one whose hash was kept, compared in constant time. */
export function perksAnswerKeyMatches(key: string | null, storedHash: string | null): boolean {
  if (!key || !ANSWER_KEY.test(key) || !storedHash || !KEY_HASH.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(sha256(key), 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * What the routine is fired with: the marker line, one backticked JSON
 * object, and (when the catalog could be read) the catalog block it answers
 * from. Without the block the routine answers its cannot-check fallback.
 */
export function perksQuestionText(payload: PerksQuestionPayload, catalog?: string): string {
  const lines = [
    PERKS_QUESTION_MARKER,
    `\`${JSON.stringify({
      question_id: payload.question_id,
      answer_key: payload.answer_key,
      questions: payload.questions
        .map((q) => cleanQuestion(q))
        .filter(Boolean)
        .slice(-6),
    })}\``,
  ];
  if (catalog) lines.push('', catalog);
  return lines.join('\n');
}

/* ----------------------------------------------------------------- answer */

export interface RelayedPerksAnswer {
  question_id: string;
  /** The one-time key the routine echoed, or null when it sent none. */
  answer_key: string | null;
  answer: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One relay message's text → the perks answer it carries, or null. */
export function parsePerksAnswer(rawText: unknown): RelayedPerksAnswer | null {
  if (typeof rawText !== 'string') return null;
  const text = unwrapSlackText(rawText, { preferLabel: true }).trim();
  if (!text.startsWith(PERKS_ANSWER_MARKER)) return null;
  const first = text.indexOf('`');
  const last = text.lastIndexOf('`');
  if (first < 0 || last <= first) return null;
  try {
    const payload = JSON.parse(text.slice(first + 1, last)) as Partial<RelayedPerksAnswer>;
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
      answer_key: typeof payload.answer_key === 'string' ? payload.answer_key.slice(0, 64) : null,
      answer: payload.answer.slice(0, 4000),
    };
  } catch {
    log.warn('Perks answer in the relay channel is not valid JSON', { length: text.length });
    return null;
  }
}

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE =
  /(?:\bhttps?:\/\/|\bwww\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/[^\s]*)?/gi;
const SPELLED_DOT =
  /\s*(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\})\s*|\s+dot\s+(?=[a-z0-9-]+\b)/gi;
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g;

function linkKey(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#]+$/, '');
}

/**
 * The routine's answer made safe to show a visitor: plain text (no markup,
 * no tags, no code), the one allowed email (arwin@tiptop.vc), no phone
 * number, and no link except the perks site's own pages - a perks answer
 * SHOULD link perk pages, unlike the booking sanitiser which strips
 * everything. At most 900 characters. Null when nothing worth showing is
 * left.
 */
export function sanitisePerksAnswer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const site = linkKey(PERKS_SITE);
  let text = unwrapSlackText(raw, { preferLabel: true })
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')
    .replace(SPELLED_DOT, '.');
  text = text.replace(EMAIL_RE, (match) =>
    match.toLowerCase() === 'arwin@tiptop.vc' ? match : ' ',
  );
  text = text.replace(URL_RE, (match) => {
    const trimmed = match.replace(/[.,;:!?)\]'"]+$/, '');
    const tail = match.slice(trimmed.length);
    const key = linkKey(trimmed);
    if (key === site || key.startsWith(`${site}/`)) {
      const path = trimmed.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '');
      return `https://${path}${tail}`;
    }
    // arwin@tiptop.vc survives above; URL_RE then sees the bare "tiptop.vc"
    // tail of the address - keep it rather than leaving "arwin@ ".
    if (key === 'tiptop.vc') return match;
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
  'not_set_up' | 'address_cap' | 'daily_cap' | 'no_table' | 'fire_failed';

export type AskOutcome =
  { kind: 'pending'; id: string } | { kind: 'unavailable'; reason: AskUnavailable };

/** Questions are counted and kept one at a time per organization, so the caps cannot be raced. */
const askLocks = processWide('perks-chat-ask-locks', () => new Map<string, Promise<void>>());

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
  /** The visitor's recent questions, oldest first; the last is the live one. */
  questions: string[];
  /** A keyed hash of the visitor's address (lib/security/crypto hashIp). */
  ipHash: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}

/**
 * Send one question to the perks assistant routine, within every cap.
 * Pending with the question's id when it went; otherwise why not, and the
 * widget shows its email fallback.
 */
export async function askPerksRoutine(store: DataStore, input: AskInput): Promise<AskOutcome> {
  const unavailable = (reason: AskUnavailable): AskOutcome => ({ kind: 'unavailable', reason });
  const e = env();
  if (!perksChatConfigured(e) || !e.perksChatFireUrl || !e.perksChatToken) {
    return unavailable('not_set_up');
  }
  const question = cleanQuestion(input.questions[input.questions.length - 1]);
  if (!question) return unavailable('not_set_up');
  const now = input.now ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();

  const kept = await oneAtATime(input.organizationId, async () => {
    try {
      const byAddress: Filter = input.ipHash
        ? { eq: { ip_hash: input.ipHash }, gte: { created_at: dayAgo } }
        : { isNull: ['ip_hash'], gte: { created_at: dayAgo } };
      const [fromAddress, today] = await Promise.all([
        store.count('perks_chat_questions', input.organizationId, byAddress),
        store.count('perks_chat_questions', input.organizationId, {
          gte: { created_at: dayAgo },
        }),
      ]);
      if (fromAddress >= PER_ADDRESS_PER_DAY) return unavailable('address_cap');
      if (today >= PER_DAY_TOTAL) return unavailable('daily_cap');
      const answerKey = newPerksAnswerKey();
      const row: PerksChatQuestion = {
        id: newId(),
        organization_id: input.organizationId,
        question,
        answer: null,
        status: 'pending',
        ip_hash: input.ipHash,
        answer_key_hash: answerKey.hash,
        created_at: now.toISOString(),
        answered_at: null,
      };
      await store.insert('perks_chat_questions', row);
      return { row, key: answerKey.key };
    } catch (error) {
      if (isMissingTableError(error)) return unavailable('no_table');
      log.warn('Perks question could not be kept', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return unavailable('no_table');
    }
  });
  if ('kind' in kept) return kept;

  // The catalog travels with the question (the routine has no network). On a
  // bad fetch the knowledge module's last good copy answers; with none at all
  // the routine gives its honest cannot-check fallback.
  const knowledge = await getPerksKnowledge(input.fetchImpl);
  const catalog = knowledge.ok ? buildFireCatalog(knowledge.value.facts, question) : undefined;

  const fired = await fireRoutineWithText(
    { url: e.perksChatFireUrl, token: e.perksChatToken },
    perksQuestionText(
      {
        question_id: kept.row.id,
        answer_key: kept.key,
        questions: input.questions,
      },
      catalog,
    ),
    input.fetchImpl,
    'Perks assistant routine',
  );
  if (!fired) {
    await store
      .updateWhere(
        'perks_chat_questions',
        input.organizationId,
        { eq: { id: kept.row.id, status: 'pending' } },
        { status: 'expired', answer_key_hash: null },
      )
      .catch(() => []);
    return unavailable('fire_failed');
  }
  return { kind: 'pending', id: kept.row.id };
}

/* ----------------------------------------------------------------- settle */

const settleState = processWide('perks-chat-settle', () => ({
  lastSlackCheck: 0,
  inFlight: null as Promise<number> | null,
}));

/** Test hook: the throttle is process-wide. */
export function resetPerksSettleThrottle(): void {
  settleState.lastSlackCheck = 0;
  settleState.inFlight = null;
}

/** Questions still waiting past EXPIRE_AFTER_MS become expired. */
async function expireStale(store: DataStore, organizationId: string, now: Date): Promise<void> {
  await store.updateWhere(
    'perks_chat_questions',
    organizationId,
    {
      eq: { status: 'pending' },
      lt: { created_at: new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString() },
    },
    { status: 'expired', answer_key_hash: null },
  );
}

/** Visitors' questions (and their answers) are kept this long, then deleted. */
export const QUESTION_RETENTION_DAYS = 30;

/**
 * Delete the questions older than QUESTION_RETENTION_DAYS: a visitor's
 * question is personal data, kept only while it is useful (the caps count a
 * day of them). Run by the alerts job; never throws.
 */
export async function prunePerksQuestions(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    return await store.removeWhere('perks_chat_questions', organizationId, {
      lt: {
        created_at: new Date(now.getTime() - QUESTION_RETENTION_DAYS * DAY_MS).toISOString(),
      },
    });
  } catch (error) {
    if (!isMissingTableError(error)) {
      log.warn('Old perks questions could not be deleted', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    return 0;
  }
}

/** The alerts job's pass over every organization: never throws. */
export async function prunePerksQuestionsForAll(
  store: DataStore,
  now: Date = new Date(),
): Promise<number> {
  const organizations = (await store.list('organizations', '', {}).catch(() => [])) as {
    id: string;
  }[];
  let removed = 0;
  for (const org of organizations) removed += await prunePerksQuestions(store, org.id, now);
  return removed;
}

/**
 * If a question is waiting, read the relay channel and complete every one
 * whose answer is there, from the configured posters only, made plain
 * first. Returns how many were settled. Throttled: the widget polls.
 */
export async function settlePerksAnswers(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const e = env();
  if (!e.askRelaySlackToken || !e.perksChatRelayChannelId) return 0;
  if (settleState.inFlight) return settleState.inFlight;
  if (Date.now() - settleState.lastSlackCheck < MIN_SLACK_CHECK_INTERVAL_MS) return 0;
  const now = options.now ?? new Date();
  settleState.inFlight = (async () => {
    try {
      await expireStale(store, organizationId, now);
      const pending = await store.list('perks_chat_questions', organizationId, {
        eq: { status: 'pending' },
      });
      if (pending.length === 0) return 0;
      const messages = await readRelayChannel(e.perksChatRelayChannelId!, options.fetchImpl);
      if (!messages) return 0;
      const posters = e.perksChatPosterIds;
      const waiting = new Set(pending.map((p) => p.id.toLowerCase()));
      let settled = 0;
      for (const message of messages) {
        if (message.subtype !== undefined && message.subtype !== null) continue;
        if (!(typeof message.user === 'string' && posters.includes(message.user))) continue;
        const relayed = parsePerksAnswer(message.text);
        if (!relayed || !waiting.has(relayed.question_id)) continue;
        const question = pending.find((p) => p.id.toLowerCase() === relayed.question_id)!;
        // The one-time key makes a shared poster safe: a post without the key
        // fired with this exact question settles nothing. Compared by hash,
        // timing-safely; the hash is cleared below so the key works once.
        const storedHash = question.answer_key_hash ?? null;
        if (!storedHash || !perksAnswerKeyMatches(relayed.answer_key, storedHash)) {
          log.warn('Perks answer ignored: one-time key missing or wrong', {
            key: relayed.answer_key ? 'wrong' : 'missing',
          });
          continue;
        }
        const answer = sanitisePerksAnswer(relayed.answer);
        const changed = await store.updateWhere(
          'perks_chat_questions',
          organizationId,
          { eq: { id: question.id, status: 'pending', answer_key_hash: storedHash } },
          answer
            ? {
                status: 'answered',
                answer,
                answer_key_hash: null,
                answered_at: now.toISOString(),
              }
            : { status: 'expired', answer_key_hash: null, answered_at: now.toISOString() },
        );
        waiting.delete(relayed.question_id);
        if (changed.length > 0) settled++;
      }
      return settled;
    } catch (error) {
      if (!isMissingTableError(error)) {
        log.warn('Settling perks answers from Slack failed', {
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

export interface PerksAnswerView {
  status: PerksChatQuestion['status'];
  answer: string | null;
}

/**
 * Where one question stands, for the widget's poll: settles from the relay
 * first (throttled) while it waits, and expires it once it has waited too
 * long. Null for an id that is not a question here.
 */
export async function readPerksAnswer(
  store: DataStore,
  organizationId: string,
  id: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<PerksAnswerView | null> {
  if (!UUID.test(id)) return null;
  const now = options.now ?? new Date();
  const read = async () => {
    try {
      return await store.get('perks_chat_questions', organizationId, id);
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
          'perks_chat_questions',
          organizationId,
          { eq: { id: row.id, status: 'pending' } },
          { status: 'expired', answer_key_hash: null },
        )
        .catch(() => []);
      return { status: 'expired', answer: null };
    }
    await settlePerksAnswers(store, organizationId, options);
    row = (await read()) ?? row;
  }
  return { status: row.status, answer: row.status === 'answered' ? row.answer : null };
}
