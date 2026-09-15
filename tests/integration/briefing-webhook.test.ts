import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/briefing/webhook/route';
import { getCurrentBriefing } from '@/lib/services/briefing';

/**
 * The briefing card is a singleton per organization: whichever of Daily
 * Overview (morning) or Daily Recap (afternoon) posted most recently is what
 * Today shows. The properties worth pinning are the replacement behaviour —
 * a second post overwrites the first rather than accumulating — and the same
 * token discipline the Granola bridge already established.
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
  it('rejects an unknown kind rather than guessing which card it replaces', async () => {
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
});

describe('replacement', () => {
  it('creates the card on the first post', async () => {
    await webhook(post(TOKEN, MORNING));
    const briefing = await getCurrentBriefing(harness.store, harness.auth.organizationId);
    expect(briefing).toMatchObject({ kind: 'morning', title: MORNING.title });
  });

  it('an afternoon post the same day replaces the morning card, not adds to it', async () => {
    await webhook(post(TOKEN, MORNING));
    const first = await getCurrentBriefing(harness.store, harness.auth.organizationId);

    await webhook(post(TOKEN, AFTERNOON));
    const second = await getCurrentBriefing(harness.store, harness.auth.organizationId);

    expect(second).toMatchObject({ kind: 'afternoon', title: AFTERNOON.title });
    // Same row, not a second one: the id is preserved across the replacement.
    expect(second?.id).toBe(first?.id);

    const all = await harness.store.list('routine_briefings', harness.auth.organizationId, {});
    expect(all).toHaveLength(1);
  });

  it('a morning post the next day replaces the previous afternoon card too', async () => {
    await webhook(post(TOKEN, AFTERNOON));
    const nextMorning = {
      ...MORNING,
      date_key: '2026-09-16',
      title: 'Morning Brief — Wed, Sep 16',
    };
    await webhook(post(TOKEN, nextMorning));

    const briefing = await getCurrentBriefing(harness.store, harness.auth.organizationId);
    expect(briefing).toMatchObject({ kind: 'morning', date_key: '2026-09-16' });
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
