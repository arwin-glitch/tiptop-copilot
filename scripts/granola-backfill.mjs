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

  const started = Date.now();
  let response;
  try {
    response = await fetch(target, { method: 'POST', signal: AbortSignal.timeout(110_000) });
  } catch (error) {
    // A timeout here is the most likely failure on a free instance, and the
    // least self-explanatory. Name it, and say what to do about it.
    const seconds = Math.round((Date.now() - started) / 1000);
    if (error?.name === 'TimeoutError' || /abort/i.test(String(error?.message))) {
      throw new Error(
        `no answer after ${seconds}s. The server is doing too much per call — ` +
          `re-run with a smaller "pages" value (1 is the safest).`,
      );
    }
    throw new Error(`could not reach the app after ${seconds}s: ${error?.message ?? 'unknown'}`);
  }

  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML error page rather than JSON means the request never reached the
    // route — a wrong path, or the host's own error page.
    throw new Error(
      `HTTP ${response.status} and the reply was not JSON. First 200 characters:\n${text.slice(0, 200)}`,
    );
  }

  if (!response.ok || body.ok === false) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

/**
 * Wake the host before timing anything.
 *
 * The free instance sleeps after fifteen minutes and takes the better part of
 * a minute to come back. Spending that inside the first real call makes a
 * slow start look like a hung import.
 */
async function wake(url) {
  const origin = new URL(url).origin;
  process.stdout.write('Waking the app (up to 60s if it was asleep)… ');
  const started = Date.now();
  try {
    await fetch(`${origin}/login`, { signal: AbortSignal.timeout(90_000) });
    console.log(`awake after ${Math.round((Date.now() - started) / 1000)}s.\n`);
  } catch {
    console.log('no answer — continuing anyway.\n');
  }
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

  // One page — about ten notes — per call. Small enough that a free instance
  // finishes comfortably inside the timeout; the loop below does the volume.
  const pages = Number.parseInt(process.env.PAGES ?? '1', 10);
  // A ceiling rather than a target: it stops as soon as Granola says there is
  // no more, and only exists so a paging bug cannot loop for ever.
  const maxCalls = Number.parseInt(process.env.MAX_CALLS ?? '400', 10);

  /**
   * How many consecutive pages of nothing-new before stopping.
   *
   * Granola lists newest first, so a catch-up run finds whatever arrived since
   * last time in the first page or two and then walks into history it already
   * has. Without this it would re-read all nine hundred notes every hour to
   * discover one. Two pages of confirmation rather than one, because a note
   * edited long ago can surface among recent ones and produce a page that is
   * all updates without meaning the catch-up is finished.
   *
   * Set to 0 for a genuine full import, which is what the first run wants.
   */
  const stopAfterKnown = Number.parseInt(process.env.STOP_AFTER_KNOWN ?? '2', 10);

  let cursor = process.env.START_CURSOR || null;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let quietPages = 0;

  await wake(url);
  console.log(
    stopAfterKnown > 0
      ? `Catching up. Stops after ${stopAfterKnown} pages with nothing new.\n`
      : 'Full import. Walks the entire history.\n',
  );

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

    const newHere = result.created ?? 0;
    created += newHere;
    updated += result.updated ?? 0;
    skipped += result.skipped ?? 0;
    cursor = result.cursor ?? null;

    console.log(
      `call ${call}: +${newHere} new, ${result.updated ?? 0} updated, ` +
        `${result.skipped ?? 0} skipped  (running total ${created + updated})`,
    );

    if (!result.hasMore) {
      console.log(`\nDone. ${created} imported, ${updated} already present, ${skipped} skipped.`);
      return;
    }

    quietPages = newHere > 0 ? 0 : quietPages + 1;
    if (stopAfterKnown > 0 && quietPages >= stopAfterKnown) {
      console.log(
        `\nCaught up. ${created} new note${created === 1 ? '' : 's'} imported; ` +
          `the rest was already here.`,
      );
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
