#!/usr/bin/env node
/**
 * TipTop Copilot Ask page → Slack DM → ask-bridge-answerer routine → back,
 * polled from GitHub Actions.
 *
 * Answering an Ask-page question needs a real Claude agent with live
 * Gmail/Calendar/Slack access — not something a plain script can do — so the
 * "thinking" step is a cloud routine (ask-bridge-answerer). But that
 * routine's sandbox can't reach tiptop-copilot.onrender.com directly (the
 * same network-level 403 that blocks the Daily Overview/Recap routines), so
 * this script does the two things its sandbox can't:
 *
 *   PHASE A (webhook → Slack): poll the ask-bridge webhook for pending
 *   questions and post each one to Arwin's DM as a machine-readable message,
 *   so the routine can pick it up on its own (hourly) schedule.
 *
 *   PHASE B (Slack → webhook): read that same DM for the routine's answers
 *   and POST each one back to the webhook to complete delivery.
 *
 * Message convention (see the routine's prompt): a question relay is
 *   ASK_QUESTION_V1
 *   `{"message_id":"...","thread_id":"...","deal_id":null,"question":"..."}`
 * and an answer relay is
 *   ASK_ANSWER_V1
 *   `{"message_id":"...","answer":"..."}`
 * The backticks stop Slack from auto-linking a URL inside the JSON, which
 * would otherwise corrupt it.
 *
 * Why re-post-dedup matters here (unlike the briefing relay): this script
 * polls every few minutes but the routine only runs hourly (routines have a
 * 1-hour minimum interval), so without checking Slack history first, the
 * same question would get posted a dozen times before the routine ever saw
 * it. Phase A checks for an existing question post with the same message_id
 * before adding a new one. Phase B needs no such check — POSTing an answer
 * the webhook already delivered just gets back {"skipped":"not_pending"}.
 *
 * Env:
 *   SLACK_BOT_TOKEN       xoxb- token with im:history for Arwin's DM channel
 *   ASK_BRIDGE_SLACK_CHANNEL   the DM channel id (D0AJY5ZHUA1)
 *   ASK_BRIDGE_WEBHOOK_URL     the Copilot ask-bridge webhook, including
 *                              ?token=…
 */

import process from 'node:process';

/* ------------------------------------------------------------- transforms */

const QUESTION_MARKER = 'ASK_QUESTION_V1';
const ANSWER_MARKER = 'ASK_ANSWER_V1';

function unescapeSlackEntities(text) {
  return text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function extractBacktickJson(text) {
  const match = /`([^`]+)`/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** A Slack message → the pending question it relays, or null. */
export function toQuestionPayload(message) {
  if (!message || typeof message.text !== 'string') return null;
  const text = unescapeSlackEntities(message.text).trim();
  if (!text.startsWith(QUESTION_MARKER)) return null;
  const payload = extractBacktickJson(text);
  if (!payload || typeof payload.message_id !== 'string' || typeof payload.question !== 'string') {
    return null;
  }
  return payload;
}

/** A Slack message → the answer it relays, or null. */
export function toAnswerPayload(message) {
  if (!message || typeof message.text !== 'string') return null;
  const text = unescapeSlackEntities(message.text).trim();
  if (!text.startsWith(ANSWER_MARKER)) return null;
  const payload = extractBacktickJson(text);
  if (!payload || typeof payload.message_id !== 'string' || typeof payload.answer !== 'string') {
    return null;
  }
  return payload;
}

/** JSON, wrapped in backticks, on its own line under the marker. */
export function toQuestionMessageText(pending) {
  return `${QUESTION_MARKER}\n\`${JSON.stringify(pending)}\``;
}

/* ------------------------------------------------------------------- Slack */

async function slackHistory(token, channel) {
  const response = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json();
  if (!body.ok) throw new Error(`Slack API (history): ${body.error ?? 'unknown error'}`);
  return body.messages ?? [];
}

async function slackPost(token, channel, text) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`Slack API (postMessage): ${body.error ?? 'unknown error'}`);
}

/* --------------------------------------------------------------- webhook */

async function fetchJson(url, options) {
  // Generous timeout plus one retry: the free-tier host may need ~50s to wake.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
      if (response.ok) return await response.json();
      throw new Error(`webhook answered ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  throw new Error('unreachable');
}

/* ------------------------------------------------------------------- main */

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.ASK_BRIDGE_SLACK_CHANNEL;
  const webhookUrl = process.env.ASK_BRIDGE_WEBHOOK_URL;

  if (!token || !channel || !webhookUrl) {
    console.error('Set SLACK_BOT_TOKEN, ASK_BRIDGE_SLACK_CHANNEL and ASK_BRIDGE_WEBHOOK_URL.');
    process.exitCode = 1;
    return;
  }

  const messages = await slackHistory(token, channel);
  const alreadyPostedQuestionIds = new Set(
    messages
      .map(toQuestionPayload)
      .filter(Boolean)
      .map((p) => p.message_id),
  );

  // Phase A — webhook → Slack.
  const { pending } = await fetchJson(webhookUrl, { method: 'GET' });
  const newQuestions = (pending ?? []).filter((p) => !alreadyPostedQuestionIds.has(p.message_id));

  for (const question of newQuestions) {
    await slackPost(token, channel, toQuestionMessageText(question));
    console.log(`posted question: ${question.message_id} — ${question.question}`);
  }
  if (newQuestions.length === 0) {
    console.log(`${pending?.length ?? 0} pending, all already relayed to Slack.`);
  }

  // Phase B — Slack → webhook.
  const answers = messages.map(toAnswerPayload).filter(Boolean);
  let relayed = 0;
  for (const answer of answers) {
    try {
      const result = await fetchJson(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(answer),
      });
      relayed++;
      console.log(`relayed answer: ${answer.message_id} — ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`failed to relay answer ${answer.message_id}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`${relayed}/${answers.length} answers relayed.`);
}

if (process.argv[1]?.endsWith('ask-bridge-slack-sync.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
