import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, revokeAndForget, storeTokens } from '@/lib/google/oauth';
import { deleteSyncedEmail, getPrimaryIntegration, syncMailbox } from '@/lib/services/inbox';
import { getCalendarProvider, getEmailProvider } from '@/lib/runtime';
import { resetEnvCache } from '@/lib/config/env';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, EncryptedProviderToken, Integration } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Disconnecting has to be trustworthy: the stored tokens are gone whether or
 * not Google's revoke endpoint answered, the app keeps working without the
 * integration, and deleting the synchronised data leaves nothing behind.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
  vi.unstubAllGlobals();
  resetEnvCache();
});

async function integration(): Promise<Integration> {
  const found = await getPrimaryIntegration(harness.store, harness.auth.organizationId);
  if (!found) throw new Error('no integration in fixtures');
  return found;
}

async function tokenCount(): Promise<number> {
  return harness.store.count('encrypted_provider_tokens', harness.auth.organizationId);
}

async function seedTokens(): Promise<Integration> {
  const record = await integration();
  const stored = await storeTokens(harness.store, record, {
    refreshToken: '1//fake-refresh-token',
    accessToken: 'ya29.fake-access-token',
    expiresInSeconds: 3600,
  });
  expect(stored.ok).toBe(true);
  return record;
}

describe('token storage', () => {
  it('stores tokens encrypted, never in plaintext', async () => {
    await seedTokens();

    const rows = (await harness.store.list(
      'encrypted_provider_tokens',
      harness.auth.organizationId,
    )) as EncryptedProviderToken[];
    expect(rows.length).toBe(2);

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('1//fake-refresh-token');
    expect(serialised).not.toContain('ya29.fake-access-token');
    for (const row of rows) {
      expect(row.ciphertext.length).toBeGreaterThan(0);
      expect(row.iv.length).toBeGreaterThan(0);
      expect(row.auth_tag.length).toBeGreaterThan(0);
    }
  });

  it('keeps one row per token type, so a refresh overwrites rather than accumulates', async () => {
    const record = await seedTokens();
    await storeTokens(harness.store, record, {
      accessToken: 'ya29.second-access-token',
      expiresInSeconds: 3600,
    });
    expect(await tokenCount()).toBe(2);
  });

  it('reads back a stored access token that has not expired', async () => {
    const record = await seedTokens();
    const token = await getAccessToken(harness.store, record);
    expect(token.ok).toBe(true);
    if (token.ok) expect(token.value).toBe('ya29.fake-access-token');
  });
});

describe('revokeAndForget', () => {
  it('deletes the local tokens and marks the integration disconnected', async () => {
    const record = await seedTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const result = await revokeAndForget(harness.store, record);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.revokedRemotely).toBe(true);

    expect(await tokenCount()).toBe(0);
    const after = await integration();
    expect(after.status).toBe('disconnected');
    expect(after.sync_cursor).toBeNull();
    expect(after.status_detail).toContain('revoked at Google');
  });

  it('still deletes the local tokens when Google refuses the revoke', async () => {
    const record = await seedTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad request', { status: 400 })),
    );

    const result = await revokeAndForget(harness.store, record);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.revokedRemotely).toBe(false);

    // The tokens are gone here regardless — that is the part we control.
    expect(await tokenCount()).toBe(0);
    const after = await integration();
    expect(after.status).toBe('disconnected');
    // And the user is told to finish the job at Google.
    expect(after.status_detail).toContain('myaccount.google.com');
  });

  it('still deletes the local tokens when the network call throws', async () => {
    const record = await seedTokens();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await revokeAndForget(harness.store, record);
    expect(result.ok).toBe(true);
    expect(await tokenCount()).toBe(0);
  });

  it('succeeds when there were no tokens to begin with', async () => {
    const record = await integration();
    const result = await revokeAndForget(harness.store, record);
    expect(result.ok).toBe(true);
    expect(await tokenCount()).toBe(0);
  });

  it('leaves the mailbox data alone — disconnecting is not deleting', async () => {
    await seedTokens();
    const before = await harness.store.count('email_messages', harness.auth.organizationId);
    expect(before).toBeGreaterThan(0);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await revokeAndForget(harness.store, await integration());

    expect(await harness.store.count('email_messages', harness.auth.organizationId)).toBe(before);
  });
});

describe('after disconnecting', () => {
  it('offers no live provider outside demo mode', async () => {
    const disconnected: Integration = { ...(await integration()), status: 'disconnected' };

    process.env.DEMO_MODE = 'false';
    resetEnvCache();

    expect(getEmailProvider(disconnected)).toBeNull();
    expect(getCalendarProvider(disconnected)).toBeNull();
    expect(getEmailProvider(null)).toBeNull();

    process.env.DEMO_MODE = 'true';
    resetEnvCache();
  });

  it('reports a typed not_configured failure from sync rather than throwing', async () => {
    process.env.DEMO_MODE = 'false';
    resetEnvCache();
    await harness.store.update(
      'integrations',
      harness.auth.organizationId,
      DEMO_IDS.integrationGoogle,
      {
        status: 'disconnected',
      },
    );

    const result = await syncMailbox(harness.auth, { force: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_configured');
      // And it names what still works without a mailbox.
      expect(result.error.stillUsable).toContain('Deals');
    }

    process.env.DEMO_MODE = 'true';
    resetEnvCache();
  });

  it('leaves deals, portfolio, knowledge and tasks fully usable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await revokeAndForget(harness.store, await integration());

    for (const table of ['deals', 'portfolio_companies', 'knowledge_documents', 'tasks'] as const) {
      expect(await harness.store.count(table, harness.auth.organizationId)).toBeGreaterThan(0);
    }
  });
});

describe('delete my data', () => {
  it('removes every synchronised record and audits it', async () => {
    await syncMailbox(harness.auth, { force: true });
    const result = await deleteSyncedEmail(harness.auth);
    expect(result.ok).toBe(true);

    for (const table of ['email_messages', 'email_threads', 'email_attachments'] as const) {
      expect(await harness.store.count(table, harness.auth.organizationId)).toBe(0);
    }

    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'integration.data_deleted' },
    })) as AuditEvent[];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.metadata?.scope).toBe('email');
  });

  it('does not touch another organization’s mailbox', async () => {
    const now = new Date().toISOString();
    await harness.store.insert('email_messages', {
      id: 'other-org-message',
      organization_id: 'other-org',
      thread_id: 'other-thread',
      provider: 'google',
      provider_message_id: 'other-pm',
      subject: 'Theirs',
      snippet: 'Theirs',
      from_name: null,
      from_address: 'x@other.demo',
      to_addresses: [],
      cc_addresses: [],
      labels: [],
      is_unread: false,
      sent_at: now,
      body_text: null,
      body_fetched_at: null,
      body_hash: null,
      has_attachments: false,
      category: 'unknown',
      category_confidence: null,
      category_source: null,
      importance: null,
      is_ignored: false,
      linked_deal_id: null,
      linked_portfolio_company_id: null,
      injection_flagged: false,
      created_at: now,
      updated_at: now,
    });

    await deleteSyncedEmail(harness.auth);
    expect(await harness.store.count('email_messages', 'other-org')).toBe(1);
  });
});
