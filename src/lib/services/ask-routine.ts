import 'server-only';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import { answerBridgeQuestion, listPendingBridgeQuestions } from './ask-bridge';
import type { PendingBridgeQuestion } from './ask-bridge';
import { processWide } from '@/lib/util/process-state';

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
    })}\``,
  ].join('\n');
}

export async function fireAskRoutine(
  question: PendingBridgeQuestion,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const e = env();
  if (!e.askRoutineFireUrl || !e.askRoutineToken) return false;

  try {
    const response = await fetchImpl(e.askRoutineFireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.askRoutineToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: fireText(question) }),
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

/** Slack escapes these regardless of a code span; undo just the entities. */
function unescapeSlackEntities(text: string): string {
  return text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

export interface RelayedAnswer {
  message_id: string;
  answer: string;
}

/** One Slack message's text → the answer it relays, or null. */
export function parseAnswerMessage(rawText: unknown): RelayedAnswer | null {
  if (typeof rawText !== 'string') return null;
  const text = unescapeSlackEntities(rawText).trim();
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
