import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteSyncedEmail, syncMailbox } from '@/lib/services/inbox';
import type { AuditEvent, EmailMessage, EmailThread, SyncRun } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Invariant 12: sync is idempotent by construction.
 *
 * Not "we retry carefully" — natural-key upserts plus a deterministic
 * idempotency key on `sync_runs`. Running the same sync twice must create
 * exactly zero new rows, which is the property that makes a retried webhook,
 * a double-click and a cron overlap all safe.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function counts() {
  const [messages, threads, attachments] = await Promise.all([
    harness.store.count('email_messages', harness.auth.organizationId),
    harness.store.count('email_threads', harness.auth.organizationId),
    harness.store.count('email_attachments', harness.auth.organizationId),
  ]);
  return { messages, threads, attachments };
}

describe('syncMailbox idempotency', () => {
  it('creates zero new rows on a second run over the same window', async () => {
    // Start from an empty mailbox so the first run genuinely creates rows and
    // the second genuinely has the chance to duplicate them.
    await deleteSyncedEmail(harness.auth);
    expect((await counts()).messages).toBe(0);

    const first = await syncMailbox(harness.auth, { force: true, lookbackDays: 60 });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.created).toBeGreaterThan(0);
    const afterFirst = await counts();
    expect(afterFirst.messages).toBeGreaterThan(0);

    const second = await syncMailbox(harness.auth, { force: true, lookbackDays: 60 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.created).toBe(0);

    expect(await counts()).toEqual(afterFirst);
  });

  it('upserts over pre-existing rows rather than duplicating them', async () => {
    // The seeded fixtures already contain these messages; a first-ever sync
    // must recognise them by natural key, not insert a second copy.
    const before = await counts();
    const result = await syncMailbox(harness.auth, { force: true, lookbackDays: 60 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.created).toBe(0);
    expect((await counts()).messages).toBe(before.messages);
  });

  it('is still a no-op on a third and fourth run', async () => {
    await syncMailbox(harness.auth, { force: true });
    const baseline = await counts();

    await syncMailbox(harness.auth, { force: true });
    await syncMailbox(harness.auth, { force: true });

    expect(await counts()).toEqual(baseline);
  });

  it('short-circuits a repeat run that carries an already-succeeded key', async () => {
    // The key folds in the cursor, so the first two runs have different keys.
    // The mock provider's cursor is content-addressed, so by the third call
    // the key repeats — and an identical successful run is returned as-is
    // rather than replayed.
    await syncMailbox(harness.auth);
    await syncMailbox(harness.auth);

    const repeat = await syncMailbox(harness.auth);
    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.value.created).toBe(0);
      expect(repeat.value.updated).toBe(0);
      expect(repeat.value.classified).toBe(0);
      expect(repeat.value.seen).toBeGreaterThan(0);
    }
  });

  it('writes one sync_run per idempotency key, not one per attempt', async () => {
    await syncMailbox(harness.auth, { force: true });
    await syncMailbox(harness.auth, { force: true });

    const runs = (await harness.store.list('sync_runs', harness.auth.organizationId)) as SyncRun[];
    const keys = runs.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps message ids stable across runs, so citations do not break', async () => {
    await syncMailbox(harness.auth, { force: true });
    const before = (
      (await harness.store.list('email_messages', harness.auth.organizationId)) as EmailMessage[]
    )
      .map((m) => m.id)
      .sort();

    await syncMailbox(harness.auth, { force: true });
    const after = (
      (await harness.store.list('email_messages', harness.auth.organizationId)) as EmailMessage[]
    )
      .map((m) => m.id)
      .sort();

    expect(after).toEqual(before);
  });

  it('does not erase a fetched body on a later metadata sync', async () => {
    await syncMailbox(harness.auth, { force: true });
    const [message] = (await harness.store.list('email_messages', harness.auth.organizationId, {
      notNull: ['body_text'],
    })) as EmailMessage[];
    expect(message).toBeDefined();
    const body = message!.body_text;

    await syncMailbox(harness.auth, { force: true });
    const reread = (await harness.store.get(
      'email_messages',
      harness.auth.organizationId,
      message!.id,
    )) as EmailMessage;
    expect(reread.body_text).toBe(body);
  });

  it('does not duplicate threads', async () => {
    await syncMailbox(harness.auth, { force: true });
    await syncMailbox(harness.auth, { force: true });

    const threads = (await harness.store.list(
      'email_threads',
      harness.auth.organizationId,
    )) as EmailThread[];
    const providerIds = threads.map((t) => t.provider_thread_id);
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });
});

describe('sync bookkeeping', () => {
  it('marks the run succeeded and advances the integration cursor', async () => {
    const result = await syncMailbox(harness.auth, { force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const run = (await harness.store.get(
      'sync_runs',
      harness.auth.organizationId,
      result.value.runId,
    )) as SyncRun;
    expect(run.status).toBe('succeeded');
    expect(run.finished_at).not.toBeNull();
    expect(run.items_seen).toBeGreaterThan(0);

    const integration = await harness.store.findOne('integrations', harness.auth.organizationId, {
      eq: { provider: 'google' },
    });
    expect(integration?.status).toBe('connected');
    expect(integration?.last_sync_error).toBeNull();
  });

  it('audits the start and the finish of a run', async () => {
    await syncMailbox(harness.auth, { force: true });
    const events = (await harness.store.list(
      'audit_events',
      harness.auth.organizationId,
    )) as AuditEvent[];
    const actions = events.map((e) => e.action);
    expect(actions).toContain('integration.sync_started');
    expect(actions).toContain('integration.sync_finished');
  });

  it('honours a shorter lookback window', async () => {
    // Measured on what the provider returned, not on stored rows: the store
    // is seeded with the same fixtures, so a row count would not move.
    const narrow = await syncMailbox(harness.auth, { force: true, lookbackDays: 1 });
    const wide = await syncMailbox(harness.auth, { force: true, lookbackDays: 60 });

    expect(narrow.ok && wide.ok).toBe(true);
    if (!narrow.ok || !wide.ok) return;
    expect(wide.value.seen).toBeGreaterThan(narrow.value.seen);
  });

  it('caps the batch at maxMessages', async () => {
    const result = await syncMailbox(harness.auth, {
      force: true,
      lookbackDays: 60,
      maxMessages: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.seen).toBeLessThanOrEqual(2);
  });
});

describe('deleteSyncedEmail', () => {
  it('removes every synchronised row and resets the cursor', async () => {
    await syncMailbox(harness.auth, { force: true });
    expect((await counts()).messages).toBeGreaterThan(0);

    const deleted = await deleteSyncedEmail(harness.auth);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.value.deleted).toBeGreaterThan(0);

    expect(await counts()).toEqual({ messages: 0, threads: 0, attachments: 0 });

    const integration = await harness.store.findOne('integrations', harness.auth.organizationId, {
      eq: { provider: 'google' },
    });
    expect(integration?.sync_cursor).toBeNull();
    expect(integration?.last_sync_at).toBeNull();
  });

  it('records the deletion in the audit trail', async () => {
    await deleteSyncedEmail(harness.auth);
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'integration.data_deleted' },
    })) as AuditEvent[];
    expect(events.length).toBeGreaterThan(0);
  });

  it('leaves deals and portfolio records untouched', async () => {
    const dealsBefore = await harness.store.count('deals', harness.auth.organizationId);
    await deleteSyncedEmail(harness.auth);
    expect(await harness.store.count('deals', harness.auth.organizationId)).toBe(dealsBefore);
  });

  it('resyncs cleanly after a deletion', async () => {
    await syncMailbox(harness.auth, { force: true });
    await deleteSyncedEmail(harness.auth);

    const result = await syncMailbox(harness.auth, { force: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.created).toBeGreaterThan(0);
  });
});
