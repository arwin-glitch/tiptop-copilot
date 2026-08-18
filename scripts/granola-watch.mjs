#!/usr/bin/env node
/**
 * Granola → TipTop Copilot, without Zapier.
 *
 * Granola's desktop app keeps every note in a local cache file. This script
 * reads that file, finds notes that are new or changed since its last pass,
 * and POSTs each one to the Copilot's Granola webhook — the same endpoint a
 * Zapier delivery would hit, so the server neither knows nor cares which
 * sender is in front of it. Ingestion is idempotent on the note id, which is
 * what makes a file-watcher safe: re-sending is always harmless.
 *
 * It runs on the machine where Granola runs (Nick's Mac), because that is
 * where the notes physically are. Nothing here talks to Granola's servers.
 *
 * Usage:
 *   GRANOLA_WEBHOOK_URL='https://…/api/integrations/granola/webhook?token=…' \
 *     node granola-watch.mjs              # one pass: send anything new, exit
 *     node granola-watch.mjs --watch      # keep running, check every 60s
 *     node granola-watch.mjs --since 2024-01-01   # backfill older notes too
 *     node granola-watch.mjs --dry-run    # show what would be sent
 *
 * Install as a background job (macOS):
 *   crontab -e   →   * * * * * GRANOLA_WEBHOOK_URL='…' /usr/local/bin/node /path/to/granola-watch.mjs
 *
 * State lives in ~/.granola-copilot-sync.json: a hash per sent note, so an
 * unchanged note is never re-sent, and an edited one is (the server treats
 * that as the edit it is). Deleting the state file just causes one harmless
 * full re-send.
 *
 * The cache format is Granola's own and undocumented; the shapes handled here
 * are the ones the community exporters have relied on across versions. If a
 * Granola update changes the format, this script reports "0 notes found"
 * loudly rather than sending something misread.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Overridable so the pipeline can be rehearsed against a copy of the cache
// before it is pointed at the real one.
const CACHE_CANDIDATES = process.env.GRANOLA_CACHE_PATH
  ? [process.env.GRANOLA_CACHE_PATH]
  : [
      join(homedir(), 'Library', 'Application Support', 'Granola', 'cache-v3.json'),
      join(process.env.APPDATA ?? '', 'Granola', 'cache-v3.json'),
      join(homedir(), '.config', 'Granola', 'cache-v3.json'),
    ];

const STATE_PATH = process.env.GRANOLA_STATE_PATH ?? join(homedir(), '.granola-copilot-sync.json');

/* ------------------------------------------------------------- extraction */

/**
 * The cache is JSON, and in every observed version the interesting part sits
 * under a `cache` key that is itself a JSON *string* (double-encoded), holding
 * `state.documents` — either an object keyed by id or an array.
 */
export function parseCache(rawText) {
  const outer = JSON.parse(rawText);
  const inner = typeof outer.cache === 'string' ? JSON.parse(outer.cache) : outer;
  const documents = inner?.state?.documents ?? inner?.documents ?? null;
  if (!documents) return [];
  return Array.isArray(documents) ? documents : Object.values(documents);
}

/** One document → the webhook payload shape, or null if it is not a note. */
export function toPayload(doc) {
  if (!doc || typeof doc !== 'object' || !doc.id) return null;

  const content = firstString(doc.notes_markdown, doc.notes_plain, doc.notes) ?? '';
  if (!content.trim()) return null; // a meeting with no note yet

  const calendarEvent = doc.google_calendar_event ?? doc.calendar_event ?? null;
  const occurredAt =
    firstString(
      calendarEvent?.start?.dateTime,
      calendarEvent?.start?.date,
      doc.created_at,
      doc.createdAt,
    ) ?? null;
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;

  const rawAttendees = calendarEvent?.attendees ?? doc.attendees ?? doc.people ?? [];
  const attendees = (Array.isArray(rawAttendees) ? rawAttendees : [])
    .map((a) => ({
      email: firstString(a?.email, a?.emailAddress) ?? null,
      name: firstString(a?.displayName, a?.name) ?? null,
    }))
    .filter((a) => a.email && a.email.includes('@'));

  return {
    external_id: String(doc.id),
    title: firstString(doc.title, calendarEvent?.summary) ?? 'Untitled meeting',
    occurred_at: new Date(occurredAt).toISOString(),
    attendee_emails: attendees.map((a) => a.email).join(', '),
    attendee_names: attendees.map((a) => a.name ?? '').join(', '),
    content,
  };
}

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return null;
}

export function contentHash(payload) {
  return createHash('sha256')
    .update(`${payload.title}\n${payload.occurred_at}\n${payload.content}`)
    .digest('hex');
}

/* ---------------------------------------------------------------- sending */

async function send(url, payload) {
  // The Copilot's free-tier host sleeps when idle and takes ~50s to wake, so
  // the timeout is generous and one retry covers the wake-up race.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return await response.json();
      if (response.status === 401) throw new Error('rejected: wrong or missing token');
      if (response.status === 503)
        throw new Error('rejected: webhook not configured on the server');
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  throw new Error('unreachable');
}

/* ------------------------------------------------------------------- main */

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sent: {} };
  }
}

async function pass({ url, since, dryRun }) {
  const cachePath = CACHE_CANDIDATES.find((p) => p && existsSync(p));
  if (!cachePath) {
    console.error('No Granola cache found. Is Granola installed on this machine?');
    console.error('Looked in:\n  ' + CACHE_CANDIDATES.filter(Boolean).join('\n  '));
    process.exitCode = 1;
    return;
  }

  let documents;
  try {
    documents = parseCache(readFileSync(cachePath, 'utf8'));
  } catch (error) {
    console.error(`Could not parse ${cachePath}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const payloads = documents.map(toPayload).filter(Boolean);
  if (payloads.length === 0) {
    console.error(
      'Parsed the cache but found 0 notes. Either there are none yet, or a ' +
        'Granola update changed the format — nothing was sent, nothing guessed.',
    );
    return;
  }

  const state = loadState();
  const cutoff = since ? Date.parse(since) : null;

  let sent = 0;
  let skipped = 0;
  for (const payload of payloads) {
    if (cutoff !== null && Date.parse(payload.occurred_at) < cutoff) {
      skipped++;
      continue;
    }
    const hash = contentHash(payload);
    if (state.sent[payload.external_id] === hash) {
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`would send: ${payload.occurred_at.slice(0, 10)}  ${payload.title}`);
      sent++;
      continue;
    }

    try {
      const result = await send(url, payload);
      state.sent[payload.external_id] = hash;
      writeFileSync(STATE_PATH, JSON.stringify(state));
      sent++;
      console.log(
        `${result.created ? 'sent' : 'updated'}: ${payload.title}` +
          (result.flagged ? '  [flagged as containing AI-directed text]' : ''),
      );
    } catch (error) {
      console.error(`failed: ${payload.title} — ${error.message}`);
    }
  }

  console.log(`${dryRun ? '[dry run] ' : ''}${sent} sent, ${skipped} already up to date.`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.GRANOLA_WEBHOOK_URL;
  const dryRun = args.includes('--dry-run');

  if (!url && !dryRun) {
    console.error(
      'Set GRANOLA_WEBHOOK_URL to the webhook including its token, e.g.\n' +
        "  GRANOLA_WEBHOOK_URL='https://tiptop-copilot.onrender.com/api/integrations/granola/webhook?token=…'",
    );
    process.exitCode = 1;
    return;
  }

  const sinceIndex = args.indexOf('--since');
  // Default: only meetings from the last 7 days, so the first run does not
  // blast years of history at the server by accident. Backfill is a choice:
  // pass --since with an old date to make it.
  const since =
    sinceIndex !== -1 ? args[sinceIndex + 1] : new Date(Date.now() - 7 * 86_400_000).toISOString();

  if (args.includes('--watch')) {
    console.log('Watching for new Granola notes (every 60s). Ctrl-C to stop.');
    for (;;) {
      await pass({ url, since, dryRun });
      await new Promise((r) => setTimeout(r, 60_000));
    }
  } else {
    await pass({ url, since, dryRun });
  }
}

// Only run when executed directly, so tests can import the pure functions.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('granola-watch.mjs')
) {
  main();
}
