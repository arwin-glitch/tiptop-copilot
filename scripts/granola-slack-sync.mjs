#!/usr/bin/env node
/**
 * Granola → Slack channel → TipTop Copilot, polled from GitHub Actions.
 *
 * Granola's Slack integration auto-posts a summary and a link to a channel
 * when a note lands in a watched folder. This script reads that channel's
 * recent history and forwards each Granola post to the Copilot's existing
 * webhook. It runs on GitHub Actions' schedule — no machine of ours involved.
 *
 * Why polling and not Slack's Events API: Slack requires an acknowledgement
 * within three seconds, and the Copilot's free-tier host takes ~50 seconds to
 * wake from sleep. Chronic timeouts would get the event subscription paused.
 * A poller has no such deadline — it simply waits for the wake-up.
 *
 * Why stateless: the webhook upserts on the note's external id, so re-sending
 * the same recent messages every run costs nothing and needs no cursor to
 * store. The last ~30 messages are re-scanned each pass; anything older was
 * already sent on an earlier pass.
 *
 * The Slack post carries a summary, not the full note. If the Mac watcher
 * (granola-watch.mjs) also runs, both feed the same id — the note's Granola
 * link id — so the fuller version simply replaces the summary whenever the
 * Mac is on. Coverage from the cloud, depth when the desktop is around.
 *
 * Env:
 *   SLACK_BOT_TOKEN         xoxb- token with channels:history (+ groups:history
 *                           and membership for a private channel)
 *   GRANOLA_SLACK_CHANNEL   channel id, e.g. C0123456789
 *   GRANOLA_WEBHOOK_URL     the Copilot webhook including ?token=…
 */

import process from 'node:process';

/* ------------------------------------------------------------- transforms */

/** Slack link syntax → readable text: <url|label> → "label (url)", <url> → url. */
export function unescapeSlackText(text) {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<([^>]+)>/g, '$1')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

/** True for messages that came from Granola's Slack app, not from people. */
export function isGranolaMessage(message) {
  if (!message || typeof message.text !== 'string') return false;
  const botName = message.bot_profile?.name ?? message.username ?? '';
  if (/granola/i.test(botName)) return true;
  return /notes\.granola\.ai\//.test(message.text);
}

/**
 * One Slack message → the webhook payload, or null.
 *
 * The stable identity is the note's Granola link id when the post carries one
 * — the same id the Mac watcher uses, which is what lets the two senders
 * converge on one row. A post with no link falls back to its Slack timestamp,
 * which is unique and stable for that message.
 */
/**
 * True when a post carries nothing but a blocked link preview.
 *
 * Granola shares a *link*, and Slack unfurls it. When the note is private —
 * which every one of Nick's is — the unfurl cannot read it, so the post
 * degrades to Granola's own marketing copy plus "Log in to Granola to view
 * this note". The only real information left is the note id in the URL.
 *
 * Ingesting that would file a meeting called "Granola meeting notes" whose
 * body is an advert, against whichever company the calendar happened to
 * match. Junk that looks like a record is worse than an empty section, so
 * these are refused outright.
 */
export function isBlockedUnfurl(text) {
  return (
    /log in to granola to view this note/i.test(text) ||
    /:?lock:?\s*\*?private meeting notes/i.test(text)
  );
}

export function toPayload(message) {
  if (!isGranolaMessage(message)) return null;

  const text = unescapeSlackText(message.text).trim();
  if (!text) return null;
  if (isBlockedUnfurl(text)) return null;

  const linkMatch = /notes\.granola\.ai\/[a-z]\/([A-Za-z0-9-]+)/.exec(text);
  const externalId = linkMatch ? linkMatch[1] : `slack-${message.ts}`;

  const lines = text.split('\n').map((l) => l.trim());
  const title = (lines.find((l) => l.length > 0) ?? 'Untitled meeting')
    .replace(/^[*_~`#>\s]+|[*_~`\s]+$/g, '')
    .slice(0, 300);

  const urlMatch = /(https:\/\/notes\.granola\.ai\/[^\s)]+)/.exec(text);

  return {
    external_id: externalId,
    title: title || 'Untitled meeting',
    occurred_at: new Date(parseFloat(message.ts) * 1000).toISOString(),
    // A Slack summary names nobody by address. The server recovers attendees
    // from the synced calendar when the title matches an event exactly.
    attendee_emails: '',
    attendee_names: '',
    content: text,
    ...(urlMatch ? { source_url: urlMatch[1] } : {}),
  };
}

/* ------------------------------------------------------------------- main */

async function history(token, channel) {
  const response = await fetch(
    `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=30`,
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
  const channel = process.env.GRANOLA_SLACK_CHANNEL;
  const url = process.env.GRANOLA_WEBHOOK_URL;

  if (!token || !channel || !url) {
    console.error('Set SLACK_BOT_TOKEN, GRANOLA_SLACK_CHANNEL and GRANOLA_WEBHOOK_URL.');
    process.exitCode = 1;
    return;
  }

  const messages = await history(token, channel);
  const payloads = messages.map(toPayload).filter(Boolean);

  if (payloads.length === 0) {
    console.log(`Read ${messages.length} messages; none are Granola posts.`);
    return;
  }

  let sent = 0;
  for (const payload of payloads) {
    try {
      const result = await post(url, payload);
      sent++;
      console.log(
        `${result.created ? 'sent' : 'up to date'}: ${payload.title}` +
          (result.flagged ? '  [flagged as containing AI-directed text]' : ''),
      );
    } catch (error) {
      console.error(`failed: ${payload.title} — ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`${sent}/${payloads.length} Granola posts forwarded.`);
}

if (process.argv[1]?.endsWith('granola-slack-sync.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
