import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/portfolio/webhook/route';
import type { PortfolioCompany, PortfolioContact } from '@/lib/types/domain';

/**
 * The properties worth pinning: the same token discipline the other bridges
 * have, and that ingest is strictly add-only — re-posting the whole list, or
 * posting a company someone archived, changes nothing.
 */

const TOKEN = 'portfolio-token-for-tests-0000000000';

let harness: Harness;
const SAVED = { ...process.env };

beforeEach(async () => {
  harness = await createHarness();
  process.env.PORTFOLIO_BRIDGE_TOKEN = TOKEN;
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
    `https://tiptop-copilot.onrender.com/api/integrations/portfolio/webhook?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

async function companies(): Promise<PortfolioCompany[]> {
  return (await harness.store.list(
    'portfolio_companies',
    harness.auth.organizationId,
    {},
  )) as PortfolioCompany[];
}

const HABU = {
  source: 'test',
  companies: [
    {
      name: 'ZZ Test Co',
      stage: 'Seed',
      founder: 'Jane Founder',
      founder_email: 'jane@zztest.example',
    },
  ],
};

describe('authentication', () => {
  it('accepts the configured token', async () => {
    const response = await webhook(post(TOKEN, HABU));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: ['ZZ Test Co'] });
  });

  it('refuses a token that does not match, and adds nothing', async () => {
    const before = (await companies()).length;
    const response = await webhook(post('not-the-token', HABU));
    expect(response.status).toBe(401);
    expect(await companies()).toHaveLength(before);
  });

  it('refuses a token that is a prefix of the real one', async () => {
    const response = await webhook(post(TOKEN.slice(0, 10), HABU));
    expect(response.status).toBe(401);
  });

  it('says so, not "invalid token", when no token is configured', async () => {
    delete process.env.PORTFOLIO_BRIDGE_TOKEN;
    resetEnvCache();
    const response = await webhook(post('anything', HABU));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_configured' } });
  });
});

describe('validation', () => {
  it('skips a payload with no companies', async () => {
    const response = await webhook(post(TOKEN, { source: 'test', companies: [] }));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'payload failed validation',
    });
  });

  it('strips fund-level fields rather than storing them', async () => {
    await webhook(
      post(TOKEN, {
        source: 'test',
        companies: [{ name: 'ZZ Strip Co', ownership: '1.5%', invested_cost: '$300,000', moic: '1.0' }],
      }),
    );
    const row = (await companies()).find((c) => c.name === 'ZZ Strip Co');
    expect(row?.ownership).toBeNull();
    expect(JSON.stringify(row)).not.toContain('300,000');
  });
});

describe('add-only ingest', () => {
  it('creates the company and its founder contact', async () => {
    await webhook(post(TOKEN, HABU));
    const row = (await companies()).find((c) => c.name === 'ZZ Test Co');
    expect(row).toMatchObject({ current_stage: 'Seed', is_archived: false });
    const contacts = (await harness.store.list('portfolio_contacts', harness.auth.organizationId, {
      eq: { portfolio_company_id: row!.id },
    })) as PortfolioContact[];
    expect(contacts).toMatchObject([{ name: 'Jane Founder', is_founder: true }]);
  });

  it('re-posting the same company adds nothing and reports it as existing', async () => {
    await webhook(post(TOKEN, HABU));
    const before = (await companies()).length;
    const response = await webhook(post(TOKEN, HABU));
    await expect(response.json()).resolves.toMatchObject({
      created: [],
      existing: ['ZZ Test Co'],
    });
    expect(await companies()).toHaveLength(before);
  });

  it('matches on the normalized name, so spelling variants do not duplicate', async () => {
    await webhook(post(TOKEN, { source: 'test', companies: [{ name: 'Build HABU, Inc.' }] }));
    const before = (await companies()).length;
    await webhook(post(TOKEN, { source: 'test', companies: [{ name: 'build habu inc' }] }));
    expect(await companies()).toHaveLength(before);
  });

  it('does not resurrect or edit an archived company', async () => {
    await webhook(post(TOKEN, HABU));
    const row = (await companies()).find((c) => c.name === 'ZZ Test Co')!;
    await harness.store.update('portfolio_companies', harness.auth.organizationId, row.id, {
      is_archived: true,
      current_stage: 'Series A',
    });
    await webhook(post(TOKEN, { source: 'test', companies: [{ name: 'ZZ Test Co', stage: 'Seed' }] }));
    const after = (await companies()).find((c) => c.id === row.id)!;
    expect(after).toMatchObject({ is_archived: true, current_stage: 'Series A' });
    expect((await companies()).filter((c) => c.name === 'ZZ Test Co')).toHaveLength(1);
  });

  it('a duplicate inside one payload is added once', async () => {
    await webhook(
      post(TOKEN, { source: 'test', companies: [{ name: 'ZZ Twin' }, { name: 'zz twin' }] }),
    );
    expect((await companies()).filter((c) => /zz twin/i.test(c.name))).toHaveLength(1);
  });
});

describe('ambiguous tenancy', () => {
  it('skips rather than guessing which organization a post belongs to', async () => {
    await addSecondOrganization(harness);
    const response = await webhook(post(TOKEN, HABU));
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      skipped: 'no unambiguous organization',
    });
  });
});
