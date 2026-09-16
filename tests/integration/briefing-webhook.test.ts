import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/briefing/webhook/route';
import { getCurrentBrief, getCurrentDossier } from '@/lib/services/briefing';

/**
 * Two independent slots per organization: a *brief* (whichever of Daily
 * Overview's morning post or Daily Recap's afternoon post is current for
 * today) and a *dossier* (the Overview's meeting prep, which the afternoon
 * post never touches). Each (organization, kind) is its own row now — the
 * properties worth pinning are that a slot upserts onto itself rather than
 * accumulating, that the brief slot picks the right one of morning/afternoon,
 * that the dossier survives an afternoon post untouched, and the same token
 * discipline the Granola bridge already established.
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
