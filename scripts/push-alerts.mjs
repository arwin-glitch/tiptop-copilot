#!/usr/bin/env node
/**
 * TipTop Copilot phone alerts: the sender, run from GitHub Actions.
 *
 * The app decides what is due (GET /api/cron/push); this script signs and
 * sends each alert, then reports back (POST /api/cron/push) which alert keys
 * were delivered and which phones the push services say are gone. Two
 * channels, each with a key that exists only as a repository secret, so
 * nothing has to be set on Render:
 *
 * - Web Push, to home-screen web apps, with the VAPID_PRIVATE_KEY secret.
 * - Apple's push service (APNs), to the TipTop Copilot iPhone app, with the
 *   APNS_KEY_P8 secret plus the APNS_KEY_ID and APPLE_TEAM_ID variables.
 *
 * Each channel runs when its key is there; with neither, the script says so
 * and stops. It asks for iPhone app tokens (`apns=1`) only once Apple has
 * accepted its APNs key (a check against a made-up device before the first
 * pass), and the app holds someone's iPhone web push back for their app only
 * then (src/lib/services/ios-push.ts), so a missing or failing key never
 * leaves a phone with nothing: a key Apple refuses is set aside for an hour.
 * While Apple is not answering, or its side is failing, the sender still
 * tries the app but adds `fallback=1`, so nobody's web push is held back
 * until Apple answers again.
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
 * Needs the `web-push` package for Web Push only; the workflow installs it
 * without touching package.json, because the app itself never sends. APNs
 * needs nothing beyond Node (node:http2, and lib/apple-jwt.mjs, which the
 * workflow copies next to this file).
 */
import { appendFileSync } from 'node:fs';
import http2 from 'node:http2';
import { apnsProviderToken, loadP8 } from './lib/apple-jwt.mjs';

const APP_URL = (process.env.APP_URL || 'https://tiptop-copilot.onrender.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const APNS_KEY_P8 = process.env.APNS_KEY_P8;
const APNS_KEY_ID = (process.env.APNS_KEY_ID || '').trim();
const APPLE_TEAM_ID = (process.env.APPLE_TEAM_ID || '').trim();
// The iPhone app's bundle id (ios-app/capacitor.config.json appId).
const APNS_TOPIC = (process.env.APNS_TOPIC || 'vc.tiptop.copilot').trim();
// Production: TestFlight builds use it. Settable only for the test suite.
const APNS_ORIGIN = process.env.APNS_ORIGIN || 'https://api.push.apple.com';
// "1" once the installed app carries the Time Sensitive entitlement, so a
// meeting alert gets through Focus; until then every alert is "active".
const APNS_TIME_SENSITIVE = process.env.APNS_TIME_SENSITIVE === '1';
const LOOP_MAX_MINUTES = Number(process.env.LOOP_MAX_MINUTES || 0);
const LOOP_UNTIL_HOUR = Number(process.env.LOOP_UNTIL_HOUR || 21);
const LOOP_FROM_HOUR = Number(process.env.LOOP_FROM_HOUR || 6);
// A minute between passes. Settable only for the test suite.
const PASS_EVERY_MS = Number(process.env.PASS_EVERY_MS || 60_000);
const FULL_EVERY = 30;

if (!CRON_SECRET) {
  console.log('::error::CRON_SECRET is not set.');
  process.exit(1);
}
if (!PRIVATE_KEY && !APNS_KEY_P8) {
  console.log(
    '::notice::Neither VAPID_PRIVATE_KEY nor APNS_KEY_P8 is set yet, so phone alerts are off. Nothing sent.',
  );
  process.exit(0);
}
if (!PRIVATE_KEY)
  console.log('::notice::VAPID_PRIVATE_KEY is not set: no Web Push, iPhone app only.');

// Only when there is a VAPID key: without one this runs with no web-push
// installed (the iPhone app alone, or the test suite).
const webpush = PRIVATE_KEY ? (await import('web-push')).default : null;

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

const isMeeting = (alert) => alert.tag.startsWith('meeting-');

/* ------------------------------------------------------------------ APNs */

const MINUTE = 60_000;
/** A provider token is made again after 50 minutes: Apple wants one at least hourly, at most every 20 minutes. */
const TOKEN_REFRESH_MS = 50 * MINUTE;
const TOKEN_MIN_AGE_MS = 20 * MINUTE;
/** An unused connection is closed after this long (overnight, say). */
const IDLE_CLOSE_MS = 10 * MINUTE;
/** How long a key or setup problem sets APNs aside, so Web Push carries everything meanwhile. */
const SETUP_PAUSE_MS = 60 * MINUTE;
/**
 * After a send with no answer or a server error (5xx), how long the app
 * holds back nobody's web push. The app is still tried, once a pass, and its
 * first delivery ends this early.
 */
const OUTAGE_FALLBACK_MS = 15 * MINUTE;
const REQUEST_TIMEOUT_MS = 10_000;
/** No iPhone has it: Apple answers BadDeviceToken for it only after accepting the key. */
const CHECK_TOKEN = '0'.repeat(64);

/**
 * What an APNs answer means (Apple, "Handling notification responses from
 * APNs"):
 * - delivered;
 * - gone: this iPhone's token will never work (410 Unregistered or
 *   ExpiredToken; 400 BadDeviceToken or DeviceTokenNotForTopic, which Apple
 *   says not to retry), so it is forgotten; a problem with one iPhone only;
 * - later: this send only (429 TooManyRequests to one token, 413 one alert
 *   too large); tried again on a later pass;
 * - outage: no answer, or Apple's side failing (5xx);
 * - tokens: the provider token changed too often;
 * - setup: anything else (the key, team, topic or request), which would
 *   refuse every send.
 */
function classify(status, reason) {
  if (status === 200) return 'delivered';
  if (status === 410) return 'gone';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) {
    return 'gone';
  }
  if (status === 429 && reason === 'TooManyProviderTokenUpdates') return 'tokens';
  if (status === 429 || status === 413) return 'later';
  // A connection Apple timed out, even after a fresh one: like no answer.
  if (status === 0 || status >= 500 || reason === 'IdleTimeout') return 'outage';
  return 'setup';
}

/**
 * The APNs channel, or null without a usable key: one HTTP/2 connection kept
 * across passes and opened again when Apple ends it, and one provider token
 * kept for 50 minutes. Its mode for a pass is 'off' (key not yet accepted,
 * or set aside), 'fallback' (Apple failing lately: tried, but holding back
 * no web push) or 'on'.
 */
function createApns() {
  if (!APNS_KEY_P8) return null;
  if (!/^[A-Z0-9]{10}$/.test(APNS_KEY_ID) || !/^[A-Z0-9]{10}$/.test(APPLE_TEAM_ID)) {
    console.log(
      '::error::APNS_KEY_P8 is set but APNS_KEY_ID or APPLE_TEAM_ID is missing or not 10 letters and digits. No iPhone app alerts.',
    );
    return null;
  }
  let key;
  try {
    key = loadP8(APNS_KEY_P8);
  } catch (error) {
    console.log(`::error::APNS_KEY_P8 could not be read: ${error.message} No iPhone app alerts.`);
    return null;
  }

  let session = null;
  let lastUsed = 0;
  let token = null;
  let tokenAt = 0;
  /** Apple has accepted the key: the check, or any answer about a device. */
  let accepted = false;
  let pausedUntil = 0;
  let fallbackUntil = 0;
  /** This pass already had a send with no answer or a 5xx: no more tries until the next. */
  let passBroken = false;

  /** A key or setup problem: off for `ms`, then the key is checked again first. */
  const pause = (ms) => {
    pausedUntil = Date.now() + ms;
    accepted = false;
    close();
    return { outcome: 'paused' };
  };

  const idle = setInterval(() => {
    if (session && Date.now() - lastUsed > IDLE_CLOSE_MS) close();
  }, MINUTE);
  idle.unref();

  function close() {
    const s = session;
    session = null;
    if (s && !s.closed) s.close();
  }

  function connection() {
    if (session && !session.closed && !session.destroyed) return session;
    const s = http2.connect(APNS_ORIGIN);
    const drop = () => {
      if (session === s) session = null;
    };
    // Apple ends a connection with GOAWAY (its reason in the payload); the
    // next request opens a new one.
    s.on('goaway', () => {
      drop();
      s.close();
    });
    s.on('error', drop);
    s.on('close', drop);
    session = s;
    return s;
  }

  function providerToken(now, { fresh = false } = {}) {
    const age = now - tokenAt;
    if (!token || age >= TOKEN_REFRESH_MS || (fresh && age >= TOKEN_MIN_AGE_MS)) {
      token = apnsProviderToken(key, { keyId: APNS_KEY_ID, teamId: APPLE_TEAM_ID, now });
      tokenAt = now;
    }
    return token;
  }

  /**
   * One request: resolves { status, reason, timestamp }, or { status: 0 } on
   * a network failure or no answer within REQUEST_TIMEOUT_MS.
   */
  function request(deviceToken, payload, extraHeaders, now) {
    return new Promise((resolve) => {
      let s;
      try {
        s = connection();
      } catch {
        resolve({ status: 0 });
        return;
      }
      lastUsed = Date.now();
      const requestHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken(now)}`,
        'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...extraHeaders,
        'content-type': 'application/json',
        // Never indexed, as Apple asks for the path and token (HPACK), and
        // for values that change with every request.
        [http2.sensitiveHeaders]: [':path', 'authorization', 'apns-expiration', 'apns-collapse-id'],
      };
      let req;
      try {
        req = s.request(requestHeaders);
      } catch {
        resolve({ status: 0 });
        return;
      }
      let status = 0;
      let body = '';
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.setEncoding('utf8');
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        done({ status: 0 });
      });
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
      });
      req.on('data', (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      req.on('end', () => {
        let reason = null;
        let timestamp;
        try {
          const parsed = body ? JSON.parse(body) : null;
          reason = typeof parsed?.reason === 'string' ? parsed.reason : null;
          timestamp = typeof parsed?.timestamp === 'number' ? parsed.timestamp : undefined;
        } catch {
          reason = null;
        }
        done({ status, reason, timestamp });
      });
      req.on('error', () => done({ status: 0 }));
      req.end(payload);
    });
  }

  /** One request, tried once more on a new connection when Apple says to. */
  async function requestWithRetry(deviceToken, payload, headersFor) {
    let now = Date.now();
    let answer = await request(deviceToken, payload, headersFor(now), now);
    const staleToken = answer.status === 403 && answer.reason === 'ExpiredProviderToken';
    if (staleToken || (answer.status === 400 && answer.reason === 'IdleTimeout')) {
      close();
      now = Date.now();
      if (staleToken) providerToken(now, { fresh: true });
      answer = await request(deviceToken, payload, headersFor(now), now);
    }
    return answer;
  }

  function setAside(kind, status, reason, during) {
    if (kind === 'tokens') {
      console.log(
        '::warning::APNs: provider token changed too often; iPhone alerts wait 20 minutes.',
      );
      return pause(TOKEN_MIN_AGE_MS);
    }
    console.log(
      `::error::APNs refused the key or setup ${during} (HTTP ${status} ${reason ?? ''}). iPhone app alerts are off for an hour; Web Push carries them meanwhile.`,
    );
    return pause(SETUP_PAUSE_MS);
  }

  /**
   * Whether Apple takes the key, from one request to a made-up device:
   * BadDeviceToken means the key, Key ID and Team ID are right. Asked before
   * the first pass and after each pause, so the app is never asked to hold
   * web push back for a key nobody has seen work.
   */
  async function checkKey() {
    const answer = await requestWithRetry(
      CHECK_TOKEN,
      JSON.stringify({ aps: { alert: { title: 'Check', body: 'Check' } } }),
      () => ({ 'apns-expiration': '0' }),
    );
    // Apple ends a connection sooner after a refused device token.
    close();
    const kind = classify(answer.status, answer.reason);
    if (kind === 'delivered' || kind === 'gone') {
      accepted = true;
      console.log('APNs accepted the key: sending to the iPhone app.');
      return 'accepted';
    }
    if (kind === 'setup' || kind === 'tokens') {
      setAside(kind, answer.status, answer.reason, 'at the key check');
      return 'refused';
    }
    console.log(
      `apns key check: ${answer.status ? `HTTP ${answer.status}` : 'no answer'}; trying again next pass.`,
    );
    return 'unknown';
  }

  return {
    /**
     * At the start of each pass: checks the key when it has not been
     * accepted yet, and answers this pass's mode, and whether Apple refused
     * the key just now.
     */
    async startPass() {
      passBroken = false;
      let refused = false;
      if (Date.now() >= pausedUntil && !accepted) refused = (await checkKey()) === 'refused';
      const now = Date.now();
      const mode = now < pausedUntil || !accepted ? 'off' : now < fallbackUntil ? 'fallback' : 'on';
      return { mode, refused };
    },
    /** Whether to try the app now, in this pass. */
    canSend: () => Date.now() >= pausedUntil && !passBroken,
    close,
    /** Close for good, waiting until the connection has closed (2 seconds at most). */
    async stop() {
      clearInterval(idle);
      const s = session;
      session = null;
      if (!s || s.closed || s.destroyed) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          s.destroy();
          resolve();
        }, 2_000);
        s.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    /**
     * Send one alert to one iPhone. Answers 'delivered', 'gone' (with when
     * Apple stopped taking the token, for a 410), 'failed' (tried again on a
     * later pass) or 'paused' (a key or setup problem: APNs is set aside).
     */
    async send(device, alert) {
      if (!this.canSend()) return { outcome: 'paused' };
      const answer = await requestWithRetry(device.token, apnsPayload(alert), (now) => ({
        // A meeting alert is useless once the meeting has started.
        'apns-expiration': String(Math.floor(now / 1000) + (isMeeting(alert) ? 600 : 21_600)),
        'apns-collapse-id': collapseId(alert.tag),
      }));
      const { status, reason } = answer;
      const kind = classify(status, reason);
      if (kind === 'delivered') {
        accepted = true;
        fallbackUntil = 0;
        return { outcome: 'delivered' };
      }
      if (kind === 'gone') {
        accepted = true;
        if (reason === 'DeviceTokenNotForTopic') {
          console.log(
            `::warning::APNs: an iPhone's token is not for ${APNS_TOPIC}, so it is forgotten. If every iPhone gets this, the key's team or the topic is wrong.`,
          );
        }
        return { outcome: 'gone', at: status === 410 ? answer.timestamp : undefined };
      }
      if (kind === 'later') {
        console.log(`apns send failed: HTTP ${status} ${reason ?? ''}`.trim());
        return { outcome: 'failed' };
      }
      if (kind === 'outage') {
        // Nothing more this pass, a new connection next time, and until
        // Apple answers again the app holds back nobody's web push, so an
        // iPhone with the home-screen web app gets the alert that way.
        passBroken = true;
        close();
        fallbackUntil = Date.now() + OUTAGE_FALLBACK_MS;
        const detail = [status ? `HTTP ${status}` : 'no answer', reason].filter(Boolean).join(' ');
        console.log(
          `::warning::APNs is not answering (${detail}). iPhones' web push is no longer held back; the app is tried again next pass.`,
        );
        return { outcome: 'failed' };
      }
      return setAside(kind, status, reason, 'on a send');
    },
  };
}

/** apns-collapse-id may be at most 64 bytes. */
function collapseId(tag) {
  let id = String(tag);
  while (Buffer.byteLength(id) > 64) id = id.slice(0, -1);
  return id;
}

/** The notification as the iPhone shows it; `url` and `tag` ride along for the tap. */
function apnsPayload(alert) {
  const kind = isMeeting(alert) ? 'meeting' : String(alert.tag);
  const make = (body) =>
    JSON.stringify({
      aps: {
        alert: { title: alert.title, body },
        sound: 'default',
        'thread-id': kind,
        'interruption-level': isMeeting(alert) && APNS_TIME_SENSITIVE ? 'time-sensitive' : 'active',
      },
      url: alert.url,
      tag: alert.tag,
    });
  // Bodies are already clipped to 180 characters; Apple's limit is 4 KB.
  let body = String(alert.body);
  let payload = make(body);
  while (Buffer.byteLength(payload) > 4096 && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - 64));
    payload = make(body);
  }
  return payload;
}

const apns = createApns();

/* ------------------------------------------------------------- one pass */

/** One pass: fetch what is due for `scope`, send it, report back. Returns the failure count. */
async function runOnce(scope) {
  const { mode, refused } = apns ? await apns.startPass() : { mode: 'off', refused: false };
  const apnsNow = mode !== 'off';
  const ask = mode === 'on' ? '&apns=1' : mode === 'fallback' ? '&apns=1&fallback=1' : '';
  let res;
  try {
    res = await fetch(`${APP_URL}/api/cron/push?scope=${scope}${ask}`, {
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

  let failures = refused ? 1 : 0;
  for (const entry of outbox ?? []) {
    const sent = [];
    const gone = new Set();
    const goneApns = new Map();
    for (const alert of entry.alerts) {
      const payload = JSON.stringify({
        title: alert.title,
        body: alert.body,
        url: alert.url,
        tag: alert.tag,
      });
      let delivered = false;
      for (const subscription of webpush ? (entry.subscriptions ?? []) : []) {
        if (gone.has(subscription.endpoint)) continue;
        try {
          await webpush.sendNotification(subscription, payload, {
            // A meeting alert is useless once the meeting has started.
            TTL: isMeeting(alert) ? 10 * 60 : 6 * 60 * 60,
            urgency: isMeeting(alert) ? 'high' : 'normal',
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
      // Only to a sender that asked for them: the app listed these for apnsNow.
      // A problem with one iPhone never stops the others.
      for (const device of apnsNow && apns ? (entry.apns ?? []) : []) {
        if (goneApns.has(device.key) || !apns.canSend()) continue;
        const result = await apns.send(device, alert);
        if (result.outcome === 'delivered') delivered = true;
        else if (result.outcome === 'gone') goneApns.set(device.key, result.at);
        else failures++;
      }
      if (delivered) sent.push(...alert.keys);
      console.log(`${alert.tag}: ${delivered ? 'delivered' : 'not delivered'}`);
    }
    if (sent.length || gone.size || goneApns.size) {
      const report = await fetch(`${APP_URL}/api/cron/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organizationId: entry.organizationId,
          sent,
          gone: [...gone],
          goneApns: [...goneApns].map(([key, at]) =>
            typeof at === 'number' ? { key, at } : { key },
          ),
        }),
      });
      console.log(`report: HTTP ${report.status}`);
    }
  }
  return failures;
}

/** The day loop: meetings every minute, everything every half hour, until handover. */
async function loop() {
  const started = Date.now();
  let minute = 0;
  let idleNoted = false;
  for (;;) {
    if (Date.now() - started > LOOP_MAX_MINUTES * 60_000) {
      console.log('reached the run limit; handing over to the next run');
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'handover=true\n');
      return;
    }
    const hour = centralHour();
    // Overnight the run just waits (no calls to the app, so it can sleep), and
    // is already running when 6am comes: GitHub starts scheduled runs late.
    if (hour >= LOOP_UNTIL_HOUR || hour < LOOP_FROM_HOUR) {
      if (!idleNoted)
        console.log(`outside ${LOOP_FROM_HOUR}:00-${LOOP_UNTIL_HOUR}:00 Central; waiting`);
      idleNoted = true;
      await sleep(PASS_EVERY_MS);
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
    await sleep(Math.max(PASS_EVERY_MS / 60, PASS_EVERY_MS - (Date.now() - tickStart)));
  }
}

if (LOOP_MAX_MINUTES) {
  await loop();
  await apns?.stop();
} else {
  const failures = await runOnce('all');
  await apns?.stop();
  // Ends by itself once its connections are closed, rather than with
  // process.exit(): exiting while one is still closing can abort Node on
  // Windows.
  process.exitCode = failures ? 1 : 0;
}
