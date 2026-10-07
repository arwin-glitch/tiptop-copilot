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
 * Needs the `web-push` package; the workflow installs it without touching
 * package.json, because the app itself never sends.
 */
import webpush from 'web-push';

const APP_URL = (process.env.APP_URL || 'https://tiptop-copilot.onrender.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET;
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!CRON_SECRET) {
  console.log('::error::CRON_SECRET is not set.');
  process.exit(1);
}
if (!PRIVATE_KEY) {
  console.log('::notice::VAPID_PRIVATE_KEY is not set yet, so phone alerts are off. Nothing sent.');
  process.exit(0);
}

const headers = { Authorization: `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' };

const res = await fetch(`${APP_URL}/api/cron/push`, { headers });
if (!res.ok) {
  console.log(`::error::Outbox request failed: HTTP ${res.status}`);
  process.exit(1);
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
    });
    let delivered = false;
    for (const subscription of entry.subscriptions) {
      if (gone.has(subscription.endpoint)) continue;
      try {
        await webpush.sendNotification(subscription, payload, {
          TTL: 6 * 60 * 60,
          urgency: 'normal',
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
    console.log(
      `${alert.tag}: ${delivered ? 'delivered' : 'not delivered'} (${alert.keys.length} item(s))`,
    );
  }
  if (sent.length || gone.size) {
    const report = await fetch(`${APP_URL}/api/cron/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ organizationId: entry.organizationId, sent, gone: [...gone] }),
    });
    console.log(`report: HTTP ${report.status} ${await report.text()}`);
  }
  if (!entry.alerts.length) console.log('nothing due');
}
if (!outbox?.length) console.log('no subscribed devices yet');
if (failures) process.exit(1);
