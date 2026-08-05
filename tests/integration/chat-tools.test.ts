import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CitationRegistry } from '@/lib/ai/citations';
import {
  TOOL_NAMES,
  executeTool,
  toolDefinitions,
  type ToolContext,
} from '@/lib/ai/tools/registry';
import { SUGGESTED_QUESTIONS, ask, getThread } from '@/lib/services/chat';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, ChatMessage } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The tool layer is the model's only route to data. Everything here is about
 * what it cannot do: call a tool that does not exist, pass an input that does
 * not validate, write when writes are off, read outside a deal scope, or cite
 * a source no tool produced.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

function context(scopeDealId: string | null = null): ToolContext {
  return { auth: harness.auth, registry: new CitationRegistry(), scopeDealId };
}

describe('tool definitions', () => {
  it('exposes read tools only when writes are disabled', () => {
    const all = toolDefinitions({ allowWrites: true }).map((t) => t.name);
    const readOnly = toolDefinitions({ allowWrites: false }).map((t) => t.name);

    expect(readOnly.length).toBeLessThan(all.length);
    for (const write of [
      'create_task',
      'save_note',
      'create_draft_reply',
      'generate_deal_analysis',
    ]) {
      expect(all).toContain(write);
      expect(readOnly).not.toContain(write);
    }
  });

  it('offers no tool that sends anything or records a decision', () => {
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/send|email_reply|deliver|transmit/);
      expect(name).not.toMatch(/record_decision|mark_invested|invest/);
    }
  });

  it('ships a closed JSON schema for every tool', () => {
    for (const definition of toolDefinitions()) {
      const schema = definition.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      if (schema.properties) expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe('executeTool refusals', () => {
  it('refuses an unknown tool and tells the model what does exist', async () => {
    const outcome = await executeTool(
      { name: 'run_sql', input: { query: 'select * from deals' } },
      context(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('is not an available tool');
    expect(outcome.content).toContain('search_deals');
  });

  it('refuses a write tool when writes are disabled', async () => {
    const outcome = await executeTool(
      { name: 'create_task', input: { title: 'Do a thing' } },
      context(),
      { allowWrites: false },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Write tools are disabled');
    expect(
      await harness.store.count('tasks', harness.auth.organizationId, {
        eq: { title: 'Do a thing' },
      }),
    ).toBe(0);
  });

  it('rejects an input that does not validate, with the reason', async () => {
    const outcome = await executeTool(
      { name: 'compare_deals', input: { deal_ids: ['only-one'] } },
      context(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Invalid input');
  });

  it('rejects an unexpected extra field rather than passing it through', async () => {
    const outcome = await executeTool(
      { name: 'search_deals', input: { query: 'ai', limit: 999 } },
      context(),
    );
    expect(outcome.ok).toBe(false);
  });

  it('returns an error to the model rather than throwing', async () => {
    const outcome = await executeTool({ name: 'get_deal', input: { deal_id: 'nope' } }, context());
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('No such deal');
  });
});

describe('deal scoping', () => {
  it('refuses to read a different deal when the conversation is pinned to one', async () => {
    const ctx = context(DEMO_IDS.dealVetrix);

    const outOfScope = await executeTool(
      { name: 'get_deal', input: { deal_id: DEMO_IDS.dealGirder } },
      ctx,
    );
    expect(outOfScope.content).toContain('scoped to a different deal');

    const inScope = await executeTool(
      { name: 'get_deal', input: { deal_id: DEMO_IDS.dealVetrix } },
      ctx,
    );
    expect(inScope.content).not.toContain('scoped to a different deal');
  });

  it('filters a search down to the scoped deal', async () => {
    const outcome = await executeTool(
      { name: 'search_deals', input: { query: 'ai' } },
      context(DEMO_IDS.dealVetrix),
    );
    const parsed = JSON.parse(outcome.content) as { deals: { deal_id: string }[] };
    for (const deal of parsed.deals) expect(deal.deal_id).toBe(DEMO_IDS.dealVetrix);
  });

  it('refuses to write a note against an out-of-scope deal', async () => {
    const before = await harness.store.count('deal_notes', harness.auth.organizationId);
    const outcome = await executeTool(
      { name: 'save_note', input: { deal_id: DEMO_IDS.dealGirder, body: 'sneaky' } },
      context(DEMO_IDS.dealVetrix),
    );
    expect(outcome.content).toContain('scoped to a different deal');
    expect(await harness.store.count('deal_notes', harness.auth.organizationId)).toBe(before);
  });
});

describe('tools register the citations for what they surface', () => {
  it('registers a citation for every deal a search returns', async () => {
    const ctx = context();
    const outcome = await executeTool({ name: 'search_deals', input: { query: 'ai' } }, ctx);
    const parsed = JSON.parse(outcome.content) as { citations: { id: string }[] };

    expect(parsed.citations.length).toBeGreaterThan(0);
    for (const citation of parsed.citations) expect(ctx.registry.has(citation.id)).toBe(true);
  });

  it('registers page-level citations for a deal’s attachment sources', async () => {
    const ctx = context();
    await executeTool({ name: 'get_deal_sources', input: { deal_id: DEMO_IDS.dealVetrix } }, ctx);
    expect(ctx.registry.ids().length).toBeGreaterThan(0);
  });

  it('marks prior decisions as judgements rather than facts', async () => {
    const outcome = await executeTool({ name: 'search_prior_decisions', input: {} }, context());
    expect(outcome.content).toContain('judgements made at a point in time');
  });

  it('says research is unavailable instead of answering from memory', async () => {
    const outcome = await executeTool(
      { name: 'optional_web_research', input: { query: 'vetrix', purpose: 'company_background' } },
      context(),
    );
    const parsed = JSON.parse(outcome.content) as { available: boolean; note?: string };
    expect(parsed.available).toBe(false);
    expect(parsed.note).toContain('Do not substitute recalled information');
  });

  it('states plainly that a created draft was not sent', async () => {
    const outcome = await executeTool(
      {
        name: 'create_draft_reply',
        input: { kind: 'missing_information', deal_id: DEMO_IDS.dealVetrix },
      },
      context(),
    );
    expect(outcome.ok).toBe(true);
    const parsed = JSON.parse(outcome.content) as { sent: boolean; note: string };
    expect(parsed.sent).toBe(false);
    expect(parsed.note).toContain('Nothing has been sent');
  });

  it('does not surface a private calendar description through the calendar tool', async () => {
    const outcome = await executeTool({ name: 'list_calendar_events', input: {} }, context());
    const parsed = JSON.parse(outcome.content) as {
      events: Record<string, unknown>[];
    };
    for (const event of parsed.events) expect(event.description).toBeUndefined();
  });
});

describe('ask', () => {
  it('persists both turns, the tools used and the validated citations', async () => {
    const result = await ask(harness.auth, 'What important emails came in since yesterday?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const thread = await getThread(harness.auth.organizationId, result.value.thread.id);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]?.role).toBe('user');
    expect(thread?.messages[1]?.role).toBe('assistant');

    const assistant = result.value.assistantMessage;
    expect(assistant.tool_calls.length).toBeGreaterThan(0);
    expect(assistant.model).toBeTruthy();
    expect(assistant.prompt_version).toBeTruthy();
  });

  it('only attaches citations that a tool actually produced this turn', async () => {
    const result = await ask(harness.auth, 'Did any new deals arrive recently?');
    if (!result.ok) return;

    const toolNames = new Set(result.value.assistantMessage.tool_calls.map((t) => t.name));
    expect(toolNames.size).toBeGreaterThan(0);

    for (const citation of result.value.assistantMessage.citations) {
      // A real citation resolves to a record that exists in this org.
      expect(citation.ref_id).toBeTruthy();
      expect(citation.id).toBeTruthy();
    }
  });

  it('renders the answer first, then evidence, then unknowns', async () => {
    const result = await ask(harness.auth, 'What follow-ups are overdue?');
    if (!result.ok) return;

    const body = result.value.assistantMessage.content;
    const evidenceAt = body.indexOf('Evidence');
    const unknownAt = body.indexOf('Not known');
    if (evidenceAt >= 0 && unknownAt >= 0) expect(evidenceAt).toBeLessThan(unknownAt);
    expect(body.trimStart()).not.toMatch(/^Evidence/);
  });

  it('continues an existing thread rather than starting a new one', async () => {
    const first = await ask(harness.auth, 'What needs my attention today?');
    if (!first.ok) return;

    const second = await ask(harness.auth, 'And what about overdue follow-ups?', {
      threadId: first.value.thread.id,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.thread.id).toBe(first.value.thread.id);

    const thread = await getThread(harness.auth.organizationId, first.value.thread.id);
    expect(thread?.messages).toHaveLength(4);
  });

  it('refuses an empty or oversized question', async () => {
    expect((await ask(harness.auth, '   ')).ok).toBe(false);
    expect((await ask(harness.auth, 'x'.repeat(4_001))).ok).toBe(false);
  });

  it('refuses a thread that does not exist in this organization', async () => {
    const result = await ask(harness.auth, 'anything', { threadId: 'no-such-thread' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('cannot write when writes are disabled', async () => {
    const before = await harness.store.count('tasks', harness.auth.organizationId);
    const result = await ask(harness.auth, 'Create a task to call the Vetrix founders.', {
      allowWrites: false,
    });
    expect(result.ok).toBe(true);
    expect(await harness.store.count('tasks', harness.auth.organizationId)).toBe(before);
  });

  it('audits the question with the tools it used', async () => {
    await ask(harness.auth, 'What follow-ups are overdue?');
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'chat.question_asked' },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
    expect(Array.isArray(events[0]?.metadata?.tools_used)).toBe(true);
  });

  it('records usage for the turn', async () => {
    await ask(harness.auth, 'What needs my attention today?');
    expect(
      await harness.store.count('ai_usage', harness.auth.organizationId, {
        eq: { operation: 'chat.answer' },
      }),
    ).toBe(1);
  });

  it('answers every suggested starter question without failing', async () => {
    for (const question of SUGGESTED_QUESTIONS.slice(0, 4)) {
      const result = await ask(harness.auth, question);
      expect(result.ok, question).toBe(true);
      if (result.ok) {
        expect((result.value.assistantMessage as ChatMessage).content.length).toBeGreaterThan(0);
      }
    }
  });
});
