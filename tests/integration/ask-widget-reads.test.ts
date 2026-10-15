import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { ask, listThreadSummaries, readThreadView } from '@/lib/services/chat';
import type { ChatMessage } from '@/lib/types/domain';

/**
 * The Ask Arwin widget's reads, on the demo store with the offline model:
 * the history lists only the reader's own conversations, newest first, each
 * with its standing; one conversation opens only for its owner.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('listThreadSummaries', () => {
  it('is empty before anything is asked', async () => {
    const result = await listThreadSummaries(harness.auth);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it('lists asked questions newest first, each answered with the answer quoted', async () => {
    const first = await ask(harness.auth, 'What follow-ups are overdue?');
    if (!first.ok) throw new Error('ask failed');
    // Distinct timestamps, so "newest first" has an order to keep.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await ask(harness.auth, 'Did any new deals arrive recently?');
    if (!second.ok) throw new Error('ask failed');

    const result = await listThreadSummaries(harness.auth);
    if (!result.ok) throw new Error('list failed');
    expect(result.value.map((t) => t.id)).toEqual([second.value.thread.id, first.value.thread.id]);
    for (const row of result.value) {
      expect(row.status).toBe('answered');
      expect(row.snippetFrom).toBe('arwin');
      expect(row.snippet.length).toBeGreaterThan(0);
    }
  });

  it('shows a pending answer as waiting', async () => {
    const asked = await ask(harness.auth, 'Anything from the portfolio?');
    if (!asked.ok) throw new Error('ask failed');
    const pending: ChatMessage = {
      ...asked.value.assistantMessage,
      id: '33333333-3333-4333-8333-333333333333',
      content: '',
      status: 'pending',
      created_at: new Date(Date.now() + 1_000).toISOString(),
    };
    await harness.store.insert('chat_messages', pending);

    const result = await listThreadSummaries(harness.auth);
    if (!result.ok) throw new Error('list failed');
    expect(result.value[0]).toMatchObject({ status: 'waiting', snippetFrom: 'you' });
  });

  it("never lists another organization's conversations", async () => {
    await ask(harness.auth, 'What follow-ups are overdue?');
    const other = await addSecondOrganization(harness);
    const result = await listThreadSummaries(other);
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe('readThreadView', () => {
  it("opens the reader's own conversation with its messages", async () => {
    const asked = await ask(harness.auth, 'What follow-ups are overdue?');
    if (!asked.ok) throw new Error('ask failed');
    const view = await readThreadView(harness.auth, { threadId: asked.value.thread.id });
    if (!view.ok) throw new Error('read failed');
    expect(view.value.thread?.id).toBe(asked.value.thread.id);
    expect(view.value.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it("refuses someone else's conversation as not found", async () => {
    const asked = await ask(harness.auth, 'What follow-ups are overdue?');
    if (!asked.ok) throw new Error('ask failed');
    const view = await readThreadView(
      {
        organizationId: harness.auth.organizationId,
        userId: '44444444-4444-4444-8444-444444444444',
      },
      { threadId: asked.value.thread.id },
    );
    expect(view).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('names the deal a new conversation would be scoped to', async () => {
    const deals = await harness.store.list('deals', harness.auth.organizationId, {}, { limit: 1 });
    const deal = deals[0];
    if (!deal) throw new Error('the demo fixtures have no deals');
    const view = await readThreadView(harness.auth, { dealId: deal.id });
    expect(view).toEqual({
      ok: true,
      value: { thread: null, messages: [], deal: { id: deal.id, name: deal.company_name } },
    });
    const missing = await readThreadView(harness.auth, {
      dealId: '55555555-5555-4555-8555-555555555555',
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
