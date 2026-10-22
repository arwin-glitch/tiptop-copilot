#!/usr/bin/env node
/**
 * TipTop Copilot phone alerts: the sender, run from GitHub Actions.
 *
 * The app decides what is due (GET /api/cron/push); this script signs and
 * sends each alert with the VAPID private key, which exists only as the
 * VAPID_PRIVATE_KEY repository secret, then reports back (POST
 * /api/cron/push) which alert keys were delivered and which subscriptions the
 * push service says are gone. Keeping the key here means nothing has to be
 * set on Render.
 *
 * Meeting alerts must land about five minutes before a meeting, which a
 * GitHub schedule (often hours late) cannot do. So one run loops: every
 * minute it asks for meetings only, and every half hour for everything,
 * between LOOP_FROM_HOUR and LOOP_UNTIL_HOUR Central, waiting quietly
 * outside them. At LOOP_MAX_MINUTES it stops and sets the `handover` step
 * output, and the workflow starts the next run, so a loop is always going
 * and 6am never depends on a late schedule. Without LOOP_MAX_MINUTES it runs
 * once, as before.
 *
 * Needs the `web-push` package; the workflow installs it without touching
 * package.json, because the app itself never sends.
 */
import { appendFileSync } from 'node:fs';
import webpush from 'web-push';

const APP_URL = (process.env.APP_URL || 'https://tiptop-copilot.onrender.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const LOOP_MAX_MINUTES = Number(process.env.LOOP_MAX_MINUTES || 0);
const LOOP_UNTIL_HOUR = Number(process.env.LOOP_UNTIL_HOUR || 21);
const LOOP_FROM_HOUR = Number(process.env.LOOP_FROM_HOUR || 6);
const FULL_EVERY = 30;

if (!CRON_SECRET) {
  console.log('::error::CRON_SECRET is not set.');
  process.exit(1);
}
if (!PRIVATE_KEY) {
  console.log('::notice::VAPID_PRIVATE_KEY is not set yet, so phone alerts are off. Nothing sent.');
  process.exit(0);
}

const headers = { Authorization: `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function centralHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'America/Chicago',
    }).format(date),
  );
}

/** One pass: fetch what is due for `scope`, send it, report back. Returns the failure count. */
async function runOnce(scope) {
  let res;
  try {
    res = await fetch(`${APP_URL}/api/cron/push?scope=${scope}`, {
      headers,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    console.log(`outbox request failed (${scope}): ${error?.message ?? error}`);
    return 1;
  }
  if (!res.ok) {
    console.log(`::warning::Outbox request failed (${scope}): HTTP ${res.status}`);
    return 1;
  }
  const { publicKey, outbox } = await res.json();

  let failures = 0;
  for (const entry of outbox ?? []) {
    const sent = [];
    const gone = new Set();
    for (const alert of entry.alerts) {
      const payload = JSON.stringify({
        title: alert.title,
        body: alert.body,
        url: alert.url,
        tag: alert.tag,
        // A meeting alert's "Start notes" button (D-076); absent on every other alert.
        notesUrl: alert.notesUrl,
      });
      let delivered = false;
      for (const subscription of entry.subscriptions) {
        if (gone.has(subscription.endpoint)) continue;
        try {
          await webpush.sendNotification(subscription, payload, {
            // A meeting alert is useless once the meeting has started.
            TTL: alert.tag.startsWith('meeting-') ? 10 * 60 : 6 * 60 * 60,
            urgency: alert.tag.startsWith('meeting-') ? 'high' : 'normal',
            vapidDetails: { subject: APP_URL, publicKey, privateKey: PRIVATE_KEY },
          });
          delivered = true;
        } catch (error) {
          const status = error?.statusCode;
          if (status === 404 || status === 410) {
            gone.add(subscription.endpoint);
          } else {
            failures++;
            console.log(`send failed: HTTP ${status ?? '?'} (${alert.tag})`);
          }
        }
      }
      if (delivered) sent.push(...alert.keys);
      console.log(`${alert.tag}: ${delivered ? 'delivered' : 'not delivered'}`);
    }
    if (sent.length || gone.size) {
      const report = await fetch(`${APP_URL}/api/cron/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ organizationId: entry.organizationId, sent, gone: [...gone] }),
      });
      console.log(`report: HTTP ${report.status}`);
    }
  }
  return failures;
}

if (!LOOP_MAX_MINUTES) {
  const failures = await runOnce('all');
  process.exit(failures ? 1 : 0);
}

const started = Date.now();
let minute = 0;
let idleNoted = false;
for (;;) {
  if (Date.now() - started > LOOP_MAX_MINUTES * 60_000) {
    console.log('reached the run limit; handing over to the next run');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'handover=true\n');
    break;
  }
  const hour = centralHour();
  // Overnight the run just waits (no calls to the app, so it can sleep), and
  // is already running when 6am comes: GitHub starts scheduled runs late.
  if (hour >= LOOP_UNTIL_HOUR || hour < LOOP_FROM_HOUR) {
    if (!idleNoted)
      console.log(`outside ${LOOP_FROM_HOUR}:00-${LOOP_UNTIL_HOUR}:00 Central; waiting`);
    idleNoted = true;
    await sleep(60_000);
    continue;
  }
  idleNoted = false;
  const tickStart = Date.now();
  try {
    await runOnce(minute % FULL_EVERY === 0 ? 'all' : 'meetings');
  } catch (error) {
    // One bad minute (a dropped connection, a garbled reply) must not end the loop.
    console.log(`pass failed: ${error?.message ?? error}`);
  }
  minute++;
  await sleep(Math.max(1_000, 60_000 - (Date.now() - tickStart)));
}
