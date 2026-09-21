#!/usr/bin/env node
/**
 * Daily Overview / Daily Recap → Slack channel → TipTop Copilot, polled from
 * GitHub Actions.
 *
 * Both routines' own direct POST to the briefing webhook fails on every run
 * with a network-level 403 — their cloud sandbox's egress proxy blocks
 * tiptop-copilot.onrender.com (an organization-policy restriction with no
 * self-service fix). So each routine also posts its payload as a plain Slack
 * message to the relay channel (in addition to its usual teaser to Arwin's
 * DM), and this script relays those payloads to the webhook. It runs on
 * GitHub Actions' schedule — no machine of ours involved, unlike the local
 * scheduled-task workaround this replaces.
 *
 * The relay channel is #briefing-ask-relay (C0C3JPW6PTJ). (#granola-notes was archived Aug 28, so Slack rejects every post to it.) It's hardcoded below
 * rather than read from a secret — see ask-bridge-slack-sync.mjs for why
 * (it isn't sensitive, and the secret it used to come from was stuck on a
 * stale value because GitHub's secret-edit page silently needs a browser
 * sudo-mode/email re-verification that kept failing without visible error).
 *
 * Message convention (see the routine prompts' "BRIEFING CARD RELAY"
 * section): a relay message is exactly two lines —
 *   BRIEFING_PAYLOAD_V1
 *   `<the webhook JSON body, one line, wrapped in backticks>`
 * The backticks stop Slack from auto-linking the URL inside the JSON, which
 * would otherwise corrupt it.
 *
 * Why polling and not Slack's Events API: see granola-slack-sync.mjs — same
 * reasoning (3s ack deadline vs. a free-tier host that can take ~50s to wake).
 *
 * Why stateless: the webhook upserts on (organization_id, kind), so
 * re-relaying a payload already delivered is a harmless no-op. The last ~50
 * messages are re-scanned each pass; anything older was already sent (or is
 * a stale day whose kind has since been superseded).
 *
 * Env:
 *   SLACK_BOT_TOKEN          xoxb- token with channels:history for the
 *                            relay channel (already granted — same token
 *                            the Granola relay uses)
 *   BRIEFING_WEBHOOK_URL     the Copilot webhook including ?token=…
 */

import process from 'node:process';

const RELAY_CHANNEL = 'C0C3JPW6PTJ'; // #briefing-ask-relay — not a secret, see header.

/* ------------------------------------------------------------- transforms */

const PAYLOAD_MARKER = 'BRIEFING_PAYLOAD_V1';
const VALID_KINDS = new Set(['morning', 'afternoon', 'dossier']);

/** Slack escapes these regardless of code-span; undo just the entities. */
function unescapeSlackEntities(text) {
  // Slack also rewrites bare URLs as <url> or <url|label>, even inside a code
  // span. Unwrap those first (a raw "<" here is link markup; a literal one
  // arrives as &lt;), or a source_url reaches the webhook as "<https://…>".
  return text
    .replace(/<((?:https?|mailto):[^|>\s]+)(?:\|[^>]*)?>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * One Slack message → the webhook payload, or null.
 *
 * Expects the exact two-line convention: a marker line, then the JSON body
 * wrapped in backticks. Anything else (the human teaser, Arwin's own
 * messages, a malformed relay) is silently skipped rather than guessed at —
 * a bad guess here would post garbage to the Today page.
 */
export function toPayload(message) {
  if (!message || typeof message.text !== 'string') return null;
  const text = unescapeSlackEntities(message.text).trim();
  if (!text.startsWith(PAYLOAD_MARKER)) return null;

  const backtickMatch = /`([^`]+)`/.exec(text);
  if (!backtickMatch) return null;

  let payload;
  try {
    payload = JSON.parse(backtickMatch[1]);
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !VALID_KINDS.has(payload.kind) ||
    typeof payload.date_key !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.summary !== 'string'
  ) {
    return null;
  }

  return payload;
}

/* ------------------------------------------------------------------- main */

async function history(token, channel) {
  const response = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await response.json();
  if (!body.ok) throw new Error(`Slack API: ${body.error ?? 'unknown error'}`);
  return body.messages ?? [];
}

async function post(url, payload) {
  // Generous timeout plus one retry: the free-tier host may need ~50s to wake.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return await response.json();
      throw new Error(`webhook answered ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = RELAY_CHANNEL;
  const url = process.env.BRIEFING_WEBHOOK_URL;

  if (!token || !url) {
    console.error('Set SLACK_BOT_TOKEN and BRIEFING_WEBHOOK_URL.');
    process.exitCode = 1;
    return;
  }

  const messages = await history(token, channel);
  const payloads = messages.map(toPayload).filter(Boolean);

  if (payloads.length === 0) {
    console.log(`Read ${messages.length} messages; none are briefing-card relay payloads.`);
    return;
  }

  let sent = 0;
  for (const payload of payloads) {
    try {
      const result = await post(url, payload);
      sent++;
      console.log(`relayed: ${payload.kind} ${payload.date_key} — ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`failed: ${payload.kind} ${payload.date_key} — ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`${sent}/${payloads.length} briefing-card payloads relayed.`);
}

if (process.argv[1]?.endsWith('briefing-slack-sync.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
