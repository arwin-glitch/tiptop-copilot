#!/usr/bin/env node
/**
 * Import the Granola backlog, start to finish.
 *
 * The backfill endpoint is deliberately resumable rather than long-running —
 * thousands of notes will not fit in one request on a free instance — so each
 * call returns the cursor it stopped at and the caller loops. Doing that by
 * hand means copying an opaque cursor between a dozen terminal commands, which
 * is a bad job for a person. This is that loop.
 *
 * It reuses `GRANOLA_WEBHOOK_URL`, the same secret the Slack sync already
 * holds, and swaps `/webhook` for `/backfill` — one fewer secret to configure
 * and one fewer chance to paste the wrong one.
 *
 * Ingestion is idempotent on the note id, so stopping this halfway and running
 * it again is safe: notes already imported come back as updates, not copies.
 */

import process from 'node:process';

/** Derives the backfill URL from the webhook URL, preserving its token. */
export function backfillUrlFrom(webhookUrl) {
  const url = new URL(webhookUrl);
  if (!url.pathname.includes('/granola/')) {
    throw new Error('GRANOLA_WEBHOOK_URL does not look like the Granola webhook URL.');
  }
  url.pathname = url.pathname.replace(/\/webhook\/?$/, '/backfill');
  if (!url.searchParams.get('token')) {
    throw new Error(
      'GRANOLA_WEBHOOK_URL has no ?token=. The backfill authenticates with GRANOLA_WEBHOOK_SECRET.',
    );
  }
  return url;
}

async function callOnce(url, cursor, pages) {
  const target = new URL(url);
  target.searchParams.set('pages', String(pages));
  if (cursor) target.searchParams.set('cursor', cursor);

  // The free-tier host sleeps and takes ~50s to wake; each call also fetches
  // every note in its pages, so the ceiling is generous on purpose.
  const response = await fetch(target, {
    method: 'POST',
    signal: AbortSignal.timeout(280_000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

async function main() {
  const webhookUrl = process.env.GRANOLA_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('Set GRANOLA_WEBHOOK_URL (the webhook URL including ?token=).');
    process.exitCode = 1;
    return;
  }

  let url;
  try {
    url = backfillUrlFrom(webhookUrl);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const pages = Number.parseInt(process.env.PAGES ?? '3', 10);
  // A ceiling rather than a target: it stops as soon as Granola says there is
  // no more, and only exists so a paging bug cannot loop for ever.
  const maxCalls = Number.parseInt(process.env.MAX_CALLS ?? '400', 10);

  let cursor = process.env.START_CURSOR || null;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  console.log('Importing the Granola backlog. Already-imported notes update in place.\n');

  for (let call = 1; call <= maxCalls; call++) {
    let result;
    try {
      result = await callOnce(url, cursor, pages);
    } catch (error) {
      console.error(`\nStopped on call ${call}: ${error.message}`);
      if (cursor) console.error(`Resume with START_CURSOR=${cursor}`);
      process.exitCode = 1;
      return;
    }

    created += result.created ?? 0;
    updated += result.updated ?? 0;
    skipped += result.skipped ?? 0;
    cursor = result.cursor ?? null;

    console.log(
      `call ${call}: +${result.created ?? 0} new, ${result.updated ?? 0} updated, ` +
        `${result.skipped ?? 0} skipped  (running total ${created + updated})`,
    );

    if (!result.hasMore) {
      console.log(`\nDone. ${created} imported, ${updated} already present, ${skipped} skipped.`);
      return;
    }
  }

  console.log(`\nStopped at the ${maxCalls}-call ceiling with more remaining.`);
  if (cursor) console.log(`Continue with START_CURSOR=${cursor}`);
}

if (process.argv[1]?.endsWith('granola-backfill.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
