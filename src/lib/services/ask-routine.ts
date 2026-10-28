import 'server-only';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import {
  answerBridgeQuestion,
  listPendingBridgeQuestions,
  threadHistoryBefore,
} from './ask-bridge';
import type { AskBridgeContext, PendingBridgeQuestion } from './ask-bridge';
import { recordAudit } from '@/lib/security/audit';
import type { ChatMessage, ChatThread } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { truncate } from '@/lib/util/text';

/**
 * The event-driven half of the Ask bridge.
 *
 * The answering routine runs in Anthropic's cloud, where an organization
 * policy blocks it from reaching this app. So it cannot be polled *by* the app
 * and cannot call back *into* it. This module closes both gaps from the app's
 * side, using only calls the app is allowed to make:
 *
 *   1. `fireAskRoutine` — the moment a question is asked, call the routine's
 *      API trigger so it starts now instead of on its hourly timer.
 *   2. `settleAnswersFromSlack` — the routine posts its answer to the relay
 *      Slack channel (it has Slack access; the app does not need to be
 *      reachable). While an Ask page is waiting, the app reads that channel
 *      and completes the pending message itself.
 *
 * Both are best-effort. If either is unconfigured or fails, the older path
 * (GitHub relay + the routine's own timer) still delivers the answer.
 */

const FIRE_TIMEOUT_MS = 8_000;
const SLACK_TIMEOUT_MS = 6_000;
const MIN_SLACK_CHECK_INTERVAL_MS = 3_000;
const ANSWER_MARKER = 'ASK_ANSWER_V1';

export function directCallConfigured(): boolean {
  const e = env();
  return Boolean(e.askRoutineFireUrl && e.askRoutineToken);
}

export function slackReadConfigured(): boolean {
  return Boolean(env().askRelaySlackToken);
}

/** What the routine is told when it is fired. Slack-relay shaped, so the routine has one format to parse. */
export function fireText(question: PendingBridgeQuestion): string {
  return [
    'ASK_QUESTION_V1',
    `\`${JSON.stringify({
      message_id: question.message_id,
      thread_id: question.thread_id,
      deal_id: question.deal_id,
      question: question.question,
      history: question.history,
      // Only a Kraken Notes chat question has one; every other payload is unchanged.
      ...(question.context ? { context: question.context } : {}),
      // Places in Kraken the question may be about, when the Help registry matched.
      ...(question.app_guide?.length ? { app_guide: question.app_guide } : {}),
    })}\``,
  ].join('\n');
}

export async function fireAskRoutine(
  question: PendingBridgeQuestion,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  return fireRoutineText(fireText(question), fetchImpl);
}

/**
 * The headers a cloud routine's /fire address takes: the routine's own
 * trigger token and the routines protocol version. No API key: a routine
 * runs on Arwin's Claude plan. Shared with the meeting follow-up routine.
 */
export function routineFireHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'experimental-cc-routine-2026-04-01',
    'Content-Type': 'application/json',
  };
}

/**
 * Start the answering routine with any relay-shaped text: an Ask question
 * (fireText) or a Kraken Notes job (NOTES_REQUEST_V1, lib/notes/
 * bridge-protocol.ts). The routine runs on Arwin's Claude plan, so nothing
 * is billed per call. Best-effort, like fireAskRoutine.
 */
export async function fireRoutineText(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const e = env();
  if (!e.askRoutineFireUrl || !e.askRoutineToken) return false;

  try {
    const response = await fetchImpl(e.askRoutineFireUrl, {
      method: 'POST',
      headers: routineFireHeaders(e.askRoutineToken),
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn('Ask routine trigger refused the request', { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    log.warn('Ask routine trigger could not be reached', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

export interface QueuedBridgeQuestion {
  thread: ChatThread;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** The routine's trigger accepted it; false means the routine's own run picks it up. */
  fired: boolean;
}

/**
 * Ask a question through the bridge from somewhere other than the Ask page
 * (Kraken Notes' chat, D-076): the rows `ask()` writes on its bridge path
 * (the question, then a pending answer), the same audit and the same fire,
 * plus optional `context` for the routine. It never falls back to an in-app
 * model call, so it costs nothing: without ASK_BRIDGE_TOKEN it is refused
 * (unless `force`, demo mode's stand-in) and the caller answers another way.
 */
export async function queueBridgeQuestion(
  store: DataStore,
  auth: { organizationId: string; userId: string },
  input: { question: string; threadId?: string | null; context?: AskBridgeContext },
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Result<QueuedBridgeQuestion>> {
  const question = input.question.trim();
  if (!question) return err('invalid_input', 'Ask a question first.');
  if (question.length > 4_000) {
    return err('invalid_input', 'That question is too long. Trim it to under 4,000 characters.');
  }
  if (!env().askBridgeToken && !options.force) {
    return err('not_configured', 'The Ask bridge is not set up (ASK_BRIDGE_TOKEN).');
  }

  let thread = input.threadId
    ? ((await store.get('chat_threads', auth.organizationId, input.threadId)) as ChatThread | null)
    : null;
  // Only the asker's own conversation, as ask() does.
  if (input.threadId && (!thread || thread.user_id !== auth.userId)) {
    return err('not_found', 'That conversation does not exist.');
  }
  const now = () => new Date().toISOString();
  if (!thread) {
    thread = {
      id: newId(),
      organization_id: auth.organizationId,
      user_id: auth.userId,
      title: truncate(question, 70),
      deal_id: null,
      created_at: now(),
      updated_at: now(),
    };
    await store.insert('chat_threads', thread);
  }
  const base = {
    organization_id: auth.organizationId,
    thread_id: thread.id,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
  };
  const userMessage: ChatMessage = {
    ...base,
    id: newId(),
    role: 'user',
    content: question,
    status: 'answered',
    created_at: now(),
  };
  await store.insert('chat_messages', userMessage);
  const assistantMessage: ChatMessage = {
    ...base,
    id: newId(),
    role: 'assistant',
    content: '',
    status: 'pending',
    created_at: now(),
  };
  await store.insert('chat_messages', assistantMessage);
  await store.update('chat_threads', auth.organizationId, thread.id, { updated_at: now() });
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'chat.question_asked',
    entityType: 'chat_thread',
    entityId: thread.id,
    metadata: { routed_to: 'ask_bridge', from: 'copilot_notes', scoped_to_deal: false },
  });
  const fired = await fireAskRoutine(
    {
      message_id: assistantMessage.id,
      thread_id: thread.id,
      deal_id: thread.deal_id,
      question,
      created_at: assistantMessage.created_at,
      history: await threadHistoryBefore(store, auth.organizationId, thread.id, userMessage.id),
      ...(input.context ? { context: input.context } : {}),
    },
    options.fetchImpl,
  );
  return ok({ thread, userMessage, assistantMessage, fired });
}

export interface RelayedAnswer {
  message_id: string;
  answer: string;
}

/** One Slack message's text → the answer it relays, or null. */
export function parseAnswerMessage(rawText: unknown): RelayedAnswer | null {
  if (typeof rawText !== 'string') return null;
  // Undo Slack's link markup before parsing, not after. An answer that ends
  // in a bare URL gets auto-linked with the closing `"}` swallowed into the
  // link (`<https://…"}>`), which is invalid JSON; two answers were silently
  // dropped that way on 2026-10-01. A labelled link keeps its label (Slack
  // turns a bare `Bill.com` into `<http://Bill.com|Bill.com>`).
  const text = unwrapSlackText(rawText, { preferLabel: true }).trim();
  if (!text.startsWith(ANSWER_MARKER)) return null;
  const json = /`([^`]+)`/.exec(text)?.[1];
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as Partial<RelayedAnswer>;
    if (
      typeof payload.message_id !== 'string' ||
      typeof payload.answer !== 'string' ||
      !payload.answer.trim()
    ) {
      return null;
    }
    return { message_id: payload.message_id, answer: payload.answer.trim().slice(0, 20_000) };
  } catch {
    // Say so: a dropped answer otherwise looks like a routine that never replied.
    log.warn('Ask answer in the relay channel is not valid JSON', { length: json.length });
    return null;
  }
}

const askState = processWide('ask-routine', () => ({
  lastSlackCheck: 0,
  inFlight: null as Promise<number> | null,
}));

/** Test hook: the throttle is process-wide, so tests must be able to reset it. */
export function resetSettleThrottle(): void {
  askState.lastSlackCheck = 0;
  askState.inFlight = null;
}

/**
 * If any Ask question is waiting, look for its answer in the relay channel and
 * complete it. Returns how many messages were answered. Throttled, because the
 * Ask page polls every few seconds while it waits.
 */
export async function settleAnswersFromSlack(
  store: DataStore,
  organizationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const e = env();
  if (!e.askRelaySlackToken) return 0;
  if (askState.inFlight) return askState.inFlight;
  if (Date.now() - askState.lastSlackCheck < MIN_SLACK_CHECK_INTERVAL_MS) return 0;

  askState.inFlight = (async () => {
    try {
      const pending = await listPendingBridgeQuestions(store, organizationId);
      if (pending.length === 0) return 0;

      const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
        e.askRelayChannelId,
      )}&limit=100`;
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ text?: unknown }>;
      };
      if (!body.ok) {
        log.warn('Slack relay channel could not be read', { error: body.error ?? 'unknown' });
        return 0;
      }

      const waiting = new Set(pending.map((p) => p.message_id));
      let settled = 0;
      for (const message of body.messages ?? []) {
        const answer = parseAnswerMessage(message.text);
        if (!answer || !waiting.has(answer.message_id)) continue;
        const result = await answerBridgeQuestion(
          store,
          organizationId,
          answer.message_id,
          answer.answer,
        );
        if (result.ok) {
          waiting.delete(answer.message_id);
          settled++;
        }
      }
      return settled;
    } catch (error) {
      log.warn('Settling Ask answers from Slack failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return 0;
    } finally {
      askState.lastSlackCheck = Date.now();
      askState.inFlight = null;
    }
  })();
  return askState.inFlight;
}

/* ------------------------------------------------- shared with other routines */

/**
 * Fire any routine's API trigger with a text payload: the same call
 * `fireAskRoutine` makes, for another routine with its own URL and token
 * (the booking page assistant, lib/booking/chat-bridge.ts). Starts a routine
 * on its owner's Claude plan; it is not a model call and bills nothing.
 * Best-effort: false on any refusal or failure, never a throw.
 */
export async function fireRoutineWithText(
  target: { url: string; token: string },
  text: string,
  fetchImpl: typeof fetch = fetch,
  label = 'Routine',
): Promise<boolean> {
  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn(`${label} trigger refused the request`, { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    log.warn(`${label} trigger could not be reached`, {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

/** One message from a relay channel's history, as Slack returns it. */
export interface RelayChannelMessage {
  text?: unknown;
  user?: unknown;
  subtype?: unknown;
  ts?: unknown;
}

/**
 * The newest messages in a relay channel, read with the relay's read-only
 * token, or null when it could not be read. The same read
 * `settleAnswersFromSlack` makes, for another reader with its own channel.
 */
export async function readRelayChannel(
  channelId: string,
  fetchImpl: typeof fetch = fetch,
  limit = 100,
): Promise<RelayChannelMessage[] | null> {
  const e = env();
  if (!e.askRelaySlackToken) return null;
  try {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
      channelId,
    )}&limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      messages?: RelayChannelMessage[];
    };
    if (!body.ok) {
      log.warn('Slack relay channel could not be read', { error: body.error ?? 'unknown' });
      return null;
    }
    return Array.isArray(body.messages) ? body.messages : [];
  } catch (error) {
    log.warn('Slack relay channel could not be read', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
