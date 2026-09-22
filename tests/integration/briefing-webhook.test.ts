import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/briefing/webhook/route';
import {
  getCurrentBrief,
  getCurrentDossier,
  ingestRoutineBriefing,
  parseBriefingRelayMessage,
  pullBriefingsFromSlack,
  readBriefingVersion,
  resetBriefingPullThrottle,
} from '@/lib/services/briefing';

/**
 * Two independent slots per organization: a *brief* (whichever of Daily
 * Overview's morning post or Daily Recap's afternoon post is current for
 * today) and a *dossier* (the Overview's meeting prep, which the afternoon
 * post never touches). Each (organization, kind) is its own row now — the
 * properties worth pinning are that a slot upserts onto itself rather than
 * accumulating and never moves backwards, that the brief slot picks the right
 * one of morning/afternoon, that the dossier survives an afternoon post
 * untouched, and the same token discipline the Granola bridge already
 * established.
 */

const TOKEN = 'briefing-token-for-tests-0000000000';

let harness: Harness;
const SAVED = { ...process.env };

beforeEach(async () => {
  harness = await createHarness();
  process.env.BRIEFING_BRIDGE_TOKEN = TOKEN;
  resetEnvCache();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

function post(token: string, body?: unknown) {
  return new NextRequest(
    `https://tiptop-copilot.onrender.com/api/integrations/briefing/webhook?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

const MORNING = {
  kind: 'morning' as const,
  date_key: '2026-09-15',
  title: 'Morning Brief — Tue, Sep 15',
  summary: '3 items need Nick before EOD. Two meetings this afternoon.',
  source_url: 'https://claude.ai/code/artifact/morning-brief-0915',
};

const AFTERNOON = {
  kind: 'afternoon' as const,
  date_key: '2026-09-15',
  title: 'Afternoon Checkpoint — Tue, Sep 15',
  summary: 'Nothing new since this morning; the two open items are unchanged.',
  source_url: 'https://claude.ai/code/artifact/afternoon-checkpoint-0915',
};

const DOSSIER = {
  kind: 'dossier' as const,
  date_key: '2026-09-15',
  title: "Nick's Tuesday Dossier",
  summary: 'One meeting: Tom Deane, ProjectMark. No open promises.',
  source_url: 'https://claude.ai/code/artifact/dossier-0915',
};

describe('authentication', () => {
  it('accepts the configured bridge token', async () => {
    const response = await webhook(post(TOKEN, MORNING));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, kind: 'morning' });
  });

  it('refuses a token that does not match', async () => {
    const response = await webhook(post('not-the-token', MORNING));
    expect(response.status).toBe(401);
  });

  it('refuses a token that is a prefix of the real one', async () => {
    const response = await webhook(post(TOKEN.slice(0, 10), MORNING));
    expect(response.status).toBe(401);
  });

  it('says so, not "invalid token", when no token is configured', async () => {
    delete process.env.BRIEFING_BRIDGE_TOKEN;
    resetEnvCache();
    const response = await webhook(post('anything', MORNING));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_configured' } });
  });
});

describe('validation', () => {
  it('rejects an unknown kind rather than guessing which slot it replaces', async () => {
    const response = await webhook(post(TOKEN, { ...MORNING, kind: 'midday' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });

  it('rejects a date_key that is not YYYY-MM-DD', async () => {
    const response = await webhook(post(TOKEN, { ...MORNING, date_key: 'Sep 15' }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });

  it('rejects an impossible or future date_key, which would otherwise pin its slot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-09-22T15:00:00Z'));
      for (const date_key of ['2026-02-30', '9999-99-99', '2026-09-24', '2027-09-22']) {
        const response = await webhook(post(TOKEN, { ...MORNING, date_key }));
        await expect(response.json()).resolves.toMatchObject({
          skipped: 'payload failed validation',
        });
      }
      // Tomorrow is already today somewhere, so it still lands.
      const response = await webhook(post(TOKEN, { ...MORNING, date_key: '2026-09-23' }));
      await expect(response.json()).resolves.toMatchObject({ ok: true, written: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the brief slot', () => {
  it('creates the brief on the first post', async () => {
    await webhook(post(TOKEN, MORNING));
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ kind: 'morning', title: MORNING.title });
  });

  it('posting the same kind twice overwrites that row rather than adding a second one', async () => {
    await webhook(post(TOKEN, MORNING));
    const first = await getCurrentBrief(harness.store, harness.auth.organizationId);

    await webhook(post(TOKEN, { ...MORNING, title: 'Morning Brief — corrected' }));
    const second = await getCurrentBrief(harness.store, harness.auth.organizationId);

    expect(second).toMatchObject({ kind: 'morning', title: 'Morning Brief — corrected' });
    expect(second?.id).toBe(first?.id);

    const all = await harness.store.list('routine_briefings', harness.auth.organizationId, {});
    expect(all).toHaveLength(1);
  });

  it('an afternoon post the same day becomes current over the morning brief', async () => {
    await webhook(post(TOKEN, MORNING));
    await webhook(post(TOKEN, AFTERNOON));

    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ kind: 'afternoon', title: AFTERNOON.title });

    // Two independent rows now — morning and afternoon are different kinds,
    // not one row being overwritten.
    const all = await harness.store.list('routine_briefings', harness.auth.organizationId, {});
    expect(all).toHaveLength(2);
  });

  it('a morning post the next day supersedes the previous afternoon brief', async () => {
    await webhook(post(TOKEN, AFTERNOON));
    const nextMorning = {
      ...MORNING,
      date_key: '2026-09-16',
      title: 'Morning Brief — Wed, Sep 16',
    };
    await webhook(post(TOKEN, nextMorning));

    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ kind: 'morning', date_key: '2026-09-16' });
  });
});

describe('the dossier slot', () => {
  it('is independent of the brief — posting it alone leaves no brief current', async () => {
    await webhook(post(TOKEN, DOSSIER));

    const dossier = await getCurrentDossier(harness.store, harness.auth.organizationId);
    expect(dossier).toMatchObject({ kind: 'dossier', title: DOSSIER.title });

    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toBeNull();
  });

  it('survives an afternoon post untouched', async () => {
    await webhook(post(TOKEN, MORNING));
    await webhook(post(TOKEN, DOSSIER));
    await webhook(post(TOKEN, AFTERNOON));

    const dossier = await getCurrentDossier(harness.store, harness.auth.organizationId);
    expect(dossier).toMatchObject({ kind: 'dossier', title: DOSSIER.title });

    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ kind: 'afternoon' });
  });
});

describe('a slot only moves forward', () => {
  const T1 = new Date('2026-09-15T20:00:00Z');
  const T2 = new Date('2026-09-15T20:05:00Z');

  it('reports a write on a fresh post', async () => {
    const response = await webhook(post(TOKEN, AFTERNOON));
    await expect(response.json()).resolves.toMatchObject({ ok: true, written: true });
  });

  it('keeps a later day over a replayed earlier one', async () => {
    const sep16 = { ...AFTERNOON, date_key: '2026-09-16', title: 'Afternoon — Wed, Sep 16' };
    await webhook(post(TOKEN, sep16));
    const response = await webhook(post(TOKEN, AFTERNOON));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'afternoon',
      date_key: '2026-09-16',
      written: false,
    });

    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ date_key: '2026-09-16', title: sep16.title });
  });

  it('leaves posted_at alone when the same post arrives again', async () => {
    const org = harness.auth.organizationId;
    await ingestRoutineBriefing(harness.store, org, AFTERNOON, { postedAt: T1 });
    const again = await ingestRoutineBriefing(harness.store, org, AFTERNOON, { postedAt: T2 });
    expect(again.written).toBe(false);

    const brief = await getCurrentBrief(harness.store, org);
    expect(brief?.posted_at).toBe(T1.toISOString());
  });
});

describe('ambiguous tenancy', () => {
  it('skips rather than guessing which organization a post belongs to', async () => {
    await addSecondOrganization(harness);
    const response = await webhook(post(TOKEN, MORNING));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'no unambiguous organization',
    });
  });
});

describe('pulling briefings from the Slack relay on view', () => {
  const fakeSlack = (messages: Array<{ text: string; ts?: string }>, ok = true) =>
    (async () =>
      new Response(
        JSON.stringify(ok ? { ok: true, messages } : { ok: false, error: 'not_in_channel' }),
      )) as unknown as typeof fetch;
  const TICK = String.fromCharCode(96);
  const relayText = (payload: unknown) =>
    ['BRIEFING_PAYLOAD_V1', TICK + JSON.stringify(payload) + TICK].join('\n');
  /** Slack's message ts: seconds since the epoch, as a decimal string. */
  const tsOf = (iso: string) => (Date.parse(iso) / 1000).toFixed(6);
  const relay = (payload: unknown, ts = tsOf('2026-09-15T20:00:00Z')) => ({
    text: relayText(payload),
    ts,
  });
  const ASK_MESSAGE = ['ASK_ANSWER_V1', TICK + '{"message_id":"x"}' + TICK].join('\n');
  const BAD_KIND_MESSAGE = relayText({ kind: 'midday' });
  const pull = (slack: typeof fetch) =>
    pullBriefingsFromSlack(harness.store, harness.auth.organizationId, slack);

  beforeEach(() => {
    process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
    resetEnvCache();
    resetBriefingPullThrottle();
  });

  it('parses only the exact marker plus backticked JSON', () => {
    expect(parseBriefingRelayMessage(relay(AFTERNOON).text)?.kind).toBe('afternoon');
    expect(parseBriefingRelayMessage(ASK_MESSAGE)).toBeNull();
    expect(parseBriefingRelayMessage(BAD_KIND_MESSAGE)).toBeNull();
  });

  it('unescapes Slack entities without misreading the backticked JSON', () => {
    const text = relayText({ ...AFTERNOON, title: 'Q1 & Q2 review' }).replace('&', '&amp;');
    expect(parseBriefingRelayMessage(text)?.title).toBe('Q1 & Q2 review');
  });

  it('ingests only the newest post of each kind, stamped with its Slack time', async () => {
    const older = { ...AFTERNOON, title: 'Afternoon - earlier' };
    // Slack returns newest first.
    const changed = await pull(
      fakeSlack([
        relay(AFTERNOON, tsOf('2026-09-15T20:05:00Z')),
        relay(older, tsOf('2026-09-15T20:00:00Z')),
      ]),
    );
    expect(changed).toBe(1);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ kind: 'afternoon', title: AFTERNOON.title });
    expect(brief?.posted_at).toBe('2026-09-15T20:05:00.000Z');
  });

  it('ignores an older same-kind post without a Slack time behind the newest one', async () => {
    // Stamped "now", the older post would outrank the newest if it were
    // ingested at all.
    const older = { ...AFTERNOON, title: 'Afternoon - earlier' };
    const changed = await pull(
      fakeSlack([relay(AFTERNOON, tsOf('2026-09-15T20:05:00Z')), { text: relayText(older) }]),
    );
    expect(changed).toBe(1);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ title: AFTERNOON.title, posted_at: '2026-09-15T20:05:00.000Z' });
  });

  it('prefers a later date_key over a later-posted re-run of an earlier day', async () => {
    const org = harness.auth.organizationId;
    await ingestRoutineBriefing(harness.store, org, AFTERNOON, {
      postedAt: new Date('2026-09-15T20:00:00Z'),
    });
    const sep16 = { ...AFTERNOON, date_key: '2026-09-16', title: 'Afternoon — Wed, Sep 16' };
    const rerun = { ...AFTERNOON, summary: 'Sep 15 recap, re-run the next day.' };
    const slack = fakeSlack([
      relay(rerun, tsOf('2026-09-16T20:30:00Z')),
      relay(sep16, tsOf('2026-09-16T20:10:00Z')),
      relay(AFTERNOON, tsOf('2026-09-15T20:00:00Z')),
    ]);

    expect(await pull(slack)).toBe(1);
    resetBriefingPullThrottle();
    expect(await pull(slack)).toBe(0);
    const brief = await getCurrentBrief(harness.store, org);
    expect(brief).toMatchObject({ title: sep16.title, posted_at: '2026-09-16T20:10:00.000Z' });
  });

  it('skips a far-future payload rather than letting it hide the real one', async () => {
    const future = { ...MORNING, date_key: '2099-09-15', title: 'Mistyped year' };
    const changed = await pull(
      fakeSlack([relay(future, tsOf('2026-09-15T14:05:00Z')), relay(MORNING)]),
    );
    expect(changed).toBe(1);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ title: MORNING.title });
  });

  it('puts the newest Slack post back over a same-day row stamped at ingest time', async () => {
    // A webhook post, and every row written before pulls stamped Slack
    // times, carries its ingest time as posted_at — later than the Slack
    // time of the post that should win.
    const replay = { ...AFTERNOON, summary: 'An older same-day draft, replayed via webhook.' };
    await webhook(post(TOKEN, replay));

    const changed = await pull(fakeSlack([relay(AFTERNOON, tsOf('2026-09-15T20:05:00Z'))]));
    expect(changed).toBe(1);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({
      summary: AFTERNOON.summary,
      posted_at: '2026-09-15T20:05:00.000Z',
    });
  });

  it('does not churn when older payloads of the same kind are still in the window', async () => {
    // The Sep 22 bug: every pull re-applied the whole window, so the card
    // flipped between posts and each relay run ended on the oldest one.
    const sep22 = { ...AFTERNOON, date_key: '2026-09-22', title: 'Afternoon — Tue, Sep 22' };
    const sep21b = { ...AFTERNOON, date_key: '2026-09-21', title: 'Afternoon — Sep 21 (b)' };
    const sep21a = { ...AFTERNOON, date_key: '2026-09-21', title: 'Afternoon — Sep 21 (a)' };
    const posted = new Date('2026-09-22T20:00:00Z');
    await ingestRoutineBriefing(harness.store, harness.auth.organizationId, sep22, {
      postedAt: posted,
    });
    const slack = fakeSlack([
      relay(sep22, tsOf(posted.toISOString())),
      relay(sep21b, tsOf('2026-09-21T20:10:00Z')),
      relay(sep21a, tsOf('2026-09-21T20:00:00Z')),
    ]);

    for (let i = 0; i < 2; i++) {
      resetBriefingPullThrottle();
      expect(await pull(slack)).toBe(0);
      const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
      expect(brief).toMatchObject({ title: sep22.title, posted_at: posted.toISOString() });
    }
  });

  it('falls back to the next-newest post when the newest one is malformed', async () => {
    const malformed = relay({ ...MORNING, date_key: 'Sep 15' }, tsOf('2026-09-15T14:05:00Z'));
    const changed = await pull(
      fakeSlack([malformed, relay(MORNING, tsOf('2026-09-15T14:00:00Z'))]),
    );
    expect(changed).toBe(1);
    const brief = await getCurrentBrief(harness.store, harness.auth.organizationId);
    expect(brief).toMatchObject({ title: MORNING.title, posted_at: '2026-09-15T14:00:00.000Z' });
  });

  it('leaves an unchanged payload alone on the next pull', async () => {
    const slack = fakeSlack([relay(MORNING)]);
    await pull(slack);
    resetBriefingPullThrottle();
    expect(await pull(slack)).toBe(0);
  });

  it('is throttled, and never throws when Slack refuses', async () => {
    expect(await pull(fakeSlack([], false))).toBe(0);
    expect(await pull(fakeSlack([relay(MORNING)]))).toBe(0);
    expect(await getCurrentBrief(harness.store, harness.auth.organizationId)).toBeNull();
  });

  it('retries a network failure after ten seconds, but waits a minute after a good pull', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-09-22T15:00:00Z');
      vi.setSystemTime(t0);
      expect(await pull(offline)).toBe(0);

      vi.setSystemTime(t0 + 5_000);
      expect(await pull(fakeSlack([relay(MORNING)]))).toBe(0);
      expect(await getCurrentBrief(harness.store, harness.auth.organizationId)).toBeNull();

      vi.setSystemTime(t0 + 11_000);
      expect(await pull(fakeSlack([relay(MORNING)]))).toBe(1);

      vi.setSystemTime(t0 + 11_000 + 50_000);
      expect(await pull(fakeSlack([relay(AFTERNOON)]))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits a full minute after a Slack refusal, and as long as a rate limit asks', async () => {
    const rateLimited = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
        status: 429,
        headers: { 'retry-after': '120' },
      })) as unknown as typeof fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-09-22T15:00:00Z');
      vi.setSystemTime(t0);
      expect(await pull(fakeSlack([], false))).toBe(0);
      vi.setSystemTime(t0 + 11_000);
      expect(await pull(fakeSlack([relay(MORNING)]))).toBe(0);
      vi.setSystemTime(t0 + 61_000);
      expect(await pull(rateLimited)).toBe(0);

      vi.setSystemTime(t0 + 61_000 + 61_000);
      expect(await pull(fakeSlack([relay(MORNING)]))).toBe(0);
      vi.setSystemTime(t0 + 61_000 + 121_000);
      expect(await pull(fakeSlack([relay(MORNING)]))).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an open Today tab a version that changes only when a card does', async () => {
    const org = harness.auth.organizationId;
    const v1 = await readBriefingVersion(harness.store, org, fakeSlack([]));

    resetBriefingPullThrottle();
    const v2 = await readBriefingVersion(harness.store, org, fakeSlack([relay(MORNING)]));
    expect(v2).not.toBe(v1);

    resetBriefingPullThrottle();
    expect(await readBriefingVersion(harness.store, org, fakeSlack([relay(MORNING)]))).toBe(v2);

    resetBriefingPullThrottle();
    const olderDay = { ...MORNING, date_key: '2026-09-14', title: 'Morning Brief — Mon, Sep 14' };
    const replay = relay(olderDay, tsOf('2026-09-15T21:00:00Z'));
    expect(await readBriefingVersion(harness.store, org, fakeSlack([replay]))).toBe(v2);
  });
});
