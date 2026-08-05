import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CitationRegistry } from '@/lib/ai/citations';
import { executeTool, type ToolContext } from '@/lib/ai/tools/registry';
import { analyzeDeal } from '@/lib/services/deal-analysis';
import {
  addNote,
  compareDeals,
  createDealFromEmail,
  getDealDetail,
  listDeals,
  recordDecision,
} from '@/lib/services/deals';
import { createDraft, listDrafts } from '@/lib/services/drafts';
import { ask, getThread, listThreads } from '@/lib/services/chat';
import { listInbox, getMessageDetail } from '@/lib/services/inbox';
import { getPortfolioDetail, listPortfolio } from '@/lib/services/portfolio';
import { searchKnowledge } from '@/lib/services/knowledge';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuthContext } from '@/lib/auth/session';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * Organization isolation.
 *
 * Both organizations live in the same store, so every one of these would pass
 * trivially if scoping were merely a convention. Scoping is a parameter that
 * both store implementations enforce; in Supabase, RLS is the second gate.
 */

let harness: Harness;
let other: AuthContext;

beforeEach(async () => {
  harness = await createHarness();
  other = await addSecondOrganization(harness);
});

afterEach(async () => {
  await harness.dispose();
});

describe('reads are scoped to the caller’s organization', () => {
  it('shows the other organization an empty pipeline', async () => {
    expect((await listDeals(harness.auth.organizationId)).length).toBeGreaterThan(0);
    expect(await listDeals(other.organizationId)).toEqual([]);
  });

  it('shows the other organization an empty inbox, portfolio and knowledge base', async () => {
    expect((await listInbox(harness.auth.organizationId)).length).toBeGreaterThan(0);
    expect(await listInbox(other.organizationId)).toEqual([]);

    expect((await listPortfolio(harness.auth.organizationId)).length).toBeGreaterThan(0);
    expect(await listPortfolio(other.organizationId)).toEqual([]);

    expect((await searchKnowledge(other.organizationId, 'thesis')).length).toBe(0);
  });

  it('returns null for a deal that belongs to another organization', async () => {
    expect(await getDealDetail(harness.auth.organizationId, DEMO_IDS.dealVetrix)).not.toBeNull();
    expect(await getDealDetail(other.organizationId, DEMO_IDS.dealVetrix)).toBeNull();
  });

  it('returns null for another organization’s email, by id', async () => {
    expect(
      await getMessageDetail(harness.auth.organizationId, DEMO_IDS.msgVetrixIntro),
    ).not.toBeNull();
    expect(await getMessageDetail(other.organizationId, DEMO_IDS.msgVetrixIntro)).toBeNull();
  });

  it('returns null for another organization’s portfolio company, by id', async () => {
    expect(
      await getPortfolioDetail(harness.auth.organizationId, DEMO_IDS.pcLedgerly),
    ).not.toBeNull();
    expect(await getPortfolioDetail(other.organizationId, DEMO_IDS.pcLedgerly)).toBeNull();
  });

  it('does not leak drafts or chat threads across the boundary', async () => {
    await createDraft(harness.auth, { kind: 'pass', dealId: DEMO_IDS.dealVetrix });
    await ask(harness.auth, 'What follow-ups are overdue?');

    expect((await listDrafts(harness.auth.organizationId)).length).toBeGreaterThan(0);
    expect(await listDrafts(other.organizationId)).toEqual([]);

    expect((await listThreads(harness.auth.organizationId, harness.auth.userId)).length).toBe(1);
    expect(await listThreads(other.organizationId, other.userId)).toEqual([]);
  });

  it('will not open another organization’s chat thread by id', async () => {
    const asked = await ask(harness.auth, 'What needs my attention today?');
    if (!asked.ok) return;

    expect(await getThread(harness.auth.organizationId, asked.value.thread.id)).not.toBeNull();
    expect(await getThread(other.organizationId, asked.value.thread.id)).toBeNull();
  });
});

describe('writes are scoped to the caller’s organization', () => {
  it('refuses to analyse another organization’s deal', async () => {
    const result = await analyzeDeal(other, DEMO_IDS.dealVetrix);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('refuses to record a decision on another organization’s deal', async () => {
    const result = await recordDecision(other, DEMO_IDS.dealVetrix, 'pass', 'Not ours to decide.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');

    expect(
      await harness.store.count('deal_decisions', harness.auth.organizationId, {
        eq: { deal_id: DEMO_IDS.dealVetrix, decision: 'pass' },
      }),
    ).toBe(0);
  });

  it('refuses to note against another organization’s deal', async () => {
    const before = await harness.store.count('deal_notes', harness.auth.organizationId);
    const result = await addNote(other, DEMO_IDS.dealVetrix, 'Injected note.');
    expect(result.ok).toBe(false);
    expect(await harness.store.count('deal_notes', harness.auth.organizationId)).toBe(before);
  });

  it('refuses to draft against another organization’s deal', async () => {
    const result = await createDraft(other, { kind: 'pass', dealId: DEMO_IDS.dealVetrix });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('refuses to build a deal from another organization’s email', async () => {
    const result = await createDealFromEmail(other, DEMO_IDS.msgVetrixIntro);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('refuses to compare deals that are not the caller’s', async () => {
    const result = await compareDeals(other, [DEMO_IDS.dealVetrix, DEMO_IDS.dealGirder]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('writes a new record into the caller’s organization, not the other one', async () => {
    const note = await addNote(harness.auth, DEMO_IDS.dealVetrix, 'A real note.');
    expect(note.ok).toBe(true);
    if (!note.ok) return;

    expect(note.value.organization_id).toBe(harness.auth.organizationId);
    expect(await harness.store.count('deal_notes', other.organizationId)).toBe(0);
  });
});

describe('the tool layer re-derives scope from the AuthContext', () => {
  function context(auth: AuthContext): ToolContext {
    return { auth, registry: new CitationRegistry(), scopeDealId: null };
  }

  it('returns nothing to a caller from the other organization', async () => {
    const outcome = await executeTool(
      { name: 'search_deals', input: { query: 'ai' } },
      context(other),
    );
    const parsed = JSON.parse(outcome.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  it('will not fetch a deal by id across the boundary', async () => {
    const outcome = await executeTool(
      { name: 'get_deal', input: { deal_id: DEMO_IDS.dealVetrix } },
      context(other),
    );
    expect(outcome.content).toContain('No such deal');
  });

  it('will not fetch an email thread by id across the boundary', async () => {
    const outcome = await executeTool(
      { name: 'get_email_thread', input: { message_id: DEMO_IDS.msgVetrixIntro } },
      context(other),
    );
    expect(outcome.content).toContain('No such message');
  });

  it('will not search the other organization’s email', async () => {
    const outcome = await executeTool(
      { name: 'search_recent_email', input: { query: 'vetrix' } },
      context(other),
    );
    const parsed = JSON.parse(outcome.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  it('will not surface the other organization’s prior decisions', async () => {
    const outcome = await executeTool(
      { name: 'search_prior_decisions', input: {} },
      context(other),
    );
    const parsed = JSON.parse(outcome.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  it('will not surface the other organization’s portfolio requests', async () => {
    const outcome = await executeTool(
      { name: 'search_portfolio_updates', input: { open_only: true } },
      context(other),
    );
    const parsed = JSON.parse(outcome.content) as { count: number };
    expect(parsed.count).toBe(0);
  });

  it('answers an ask from the other organization without any of the first org’s data', async () => {
    const result = await ask(other, 'Give me a 30-second overview of the newest deal.');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const body = result.value.assistantMessage.content;
    for (const name of ['Vetrix', 'Girder', 'Plumbline', 'LoomStack', 'Ledgerly']) {
      expect(body).not.toContain(name);
    }
    expect(result.value.assistantMessage.citations).toHaveLength(0);
  });
});
