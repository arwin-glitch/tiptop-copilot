import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { CitationRegistry } from '@/lib/ai/citations';
import { executeTool, toolDefinitions } from '@/lib/ai/tools/registry';
import { APP_GUIDE_MODEL } from '@/lib/help/app-guide';
import { getAI } from '@/lib/runtime';
import { fireText } from '@/lib/services/ask-routine';
import { appGuideField, listPendingBridgeQuestions } from '@/lib/services/ask-bridge';
import { ask, getThread } from '@/lib/services/chat';
import type { AuditEvent } from '@/lib/types/domain';

/**
 * Ask Arwin answering questions about Kraken itself. A "where is…" question
 * is answered at once from the Help registry, stored like any answer, with no
 * routine fired and no model called. Anything else goes exactly where it went
 * before, carrying the best Help matches along for the routine or the model.
 */

const SAVED = { ...process.env };
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

function useBridge() {
  process.env.ASK_BRIDGE_TOKEN = 'ask-bridge-token-for-tests-0000000000';
  process.env.ASK_ROUTINE_FIRE_URL =
    'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
  process.env.ASK_ROUTINE_TOKEN = 'routine-token-for-tests';
  resetEnvCache();
}

describe('instant answers', () => {
  it('answers a where-is question at once, stored with Help links, with no model call', async () => {
    const model = vi.spyOn(getAI(), 'runToolConversation');
    const result = await ask(harness.auth, 'Where is the job board?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answer = result.value.assistantMessage;
    expect(answer.status).toBe('answered');
    expect(answer.model).toBe(APP_GUIDE_MODEL);
    expect(answer.content.split('\n')[0]).toBe("It's on Portfolio, in the Jobs tab.");
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]).toMatchObject({
      kind: 'help',
      url: '/portfolio?tab=jobs',
      section: 'Kraken Help',
    });
    expect(answer.citations[0]?.tour_url).toContain('tour=jobs');
    // Nothing ran, so no tool call is shown; the audit row says where it came from.
    expect(answer.tool_calls).toEqual([]);
    expect(model).not.toHaveBeenCalled();

    const thread = await getThread(harness.auth.organizationId, result.value.thread.id);
    expect(thread?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'chat.question_asked' },
    })) as AuditEvent[];
    expect(events[0]?.metadata).toMatchObject({ routed_to: 'app_guide', places: ['jobs'] });
    expect(
      await harness.store.count('ai_usage', harness.auth.organizationId, {
        eq: { operation: 'chat.answer' },
      }),
    ).toBe(0);
  });

  it('answers at once with the bridge on too: no pending row, no routine fired', async () => {
    useBridge();
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await ask(harness.auth, 'Where are my snoozed tasks?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistantMessage.status).toBe('answered');
    expect(result.value.assistantMessage.citations[0]?.url).toBe('/tasks?view=snoozed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listPendingBridgeQuestions(harness.store, harness.auth.organizationId)).toEqual(
      [],
    );
  });

  it('keeps the conversation going: the next question sees the answer in its history', async () => {
    useBridge();
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const first = await ask(harness.auth, 'Where is the job board?');
    if (!first.ok) throw new Error('first question failed');
    const second = await ask(harness.auth, 'Which roles are open right now?', {
      threadId: first.value.thread.id,
    });
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { text: string };
    expect(text).toContain("It's on Portfolio, in the Jobs tab.");
  });
});

describe('falling through', () => {
  it('leaves a deal-scoped chat to the full answer, where the notes mean that deal', async () => {
    useBridge();
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const deals = await harness.store.list('deals', harness.auth.organizationId, {}, { limit: 1 });
    const deal = deals[0];
    if (!deal) throw new Error('the demo fixtures have no deals');

    const result = await ask(harness.auth, 'Where are meeting notes?', { dealId: deal.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistantMessage.status).toBe('pending');
    expect(result.value.assistantMessage.model).not.toBe(APP_GUIDE_MODEL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A follow-up in that deal's thread too.
    const next = await ask(harness.auth, 'Where is the job board?', {
      threadId: result.value.thread.id,
    });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.value.assistantMessage.status).toBe('pending');
  });

  it('leaves a follow-up that leans on the conversation to the full answer', async () => {
    const model = vi.spyOn(getAI(), 'runToolConversation');
    const first = await ask(harness.auth, 'Where is the job board?');
    if (!first.ok) throw new Error('first question failed');
    expect(model).not.toHaveBeenCalled();
    const second = await ask(harness.auth, 'Where do I find it?', {
      threadId: first.value.thread.id,
    });
    expect(second.ok).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    // A fresh app question in the same thread still gets the instant answer.
    const third = await ask(harness.auth, 'Where are my snoozed tasks?', {
      threadId: first.value.thread.id,
    });
    if (third.ok) expect(third.value.assistantMessage.model).toBe(APP_GUIDE_MODEL);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each([
    'where is my email from bob',
    'where are we on the wire',
    'how should I reply to the invoice email',
    'where are my notes from yesterday',
  ])('sends a lowercase data question to the model: %s', async (q) => {
    const model = vi.spyOn(getAI(), 'runToolConversation');
    const result = await ask(harness.auth, q);
    expect(result.ok).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.value.assistantMessage.model).not.toBe(APP_GUIDE_MODEL);
  });

  it('sends a data question to the model as before', async () => {
    const model = vi.spyOn(getAI(), 'runToolConversation');
    const result = await ask(harness.auth, 'What follow-ups are overdue?');
    expect(result.ok).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.value.assistantMessage.model).not.toBe(APP_GUIDE_MODEL);
  });

  it('sends a where-is question with no good match on as before', async () => {
    useBridge();
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const result = await ask(harness.auth, 'Where is the quantum flux capacitor?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistantMessage.status).toBe('pending');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { text: string }).text).not.toContain('app_guide');
  });
});

describe('the bridge payload', () => {
  it('carries the best Help matches for a mixed question, links on the app origin', async () => {
    useBridge();
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    // A follow-up leaning on the conversation ("it") goes to the routine, but
    // it is still about the job board.
    const first = await ask(harness.auth, 'Where is the job board?');
    if (!first.ok) throw new Error('first question failed');
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await ask(harness.auth, 'How do I share it from the job board?', {
      threadId: first.value.thread.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assistantMessage.status).toBe('pending');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { text } = JSON.parse(init.body as string) as { text: string };
    const payload = JSON.parse(text.split('\n')[1]!.slice(1, -1)) as {
      app_guide?: { title: string; link: string }[];
    };
    expect(payload.app_guide?.[0]).toMatchObject({
      title: 'Portfolio › Jobs',
      link: 'http://localhost:3000/portfolio?tab=jobs',
    });

    const pending = await listPendingBridgeQuestions(harness.store, harness.auth.organizationId);
    expect(pending[0]?.app_guide?.[0]?.title).toBe('Portfolio › Jobs');
  });

  it('adds nothing when nothing in Kraken matches', () => {
    expect(appGuideField('What did Examplify say about the round?')).toEqual({});
    // A data question that shares words with pages carries nothing either,
    // so its payload is byte-identical to before.
    expect(appGuideField('what did the lp say about the wire')).toEqual({});
    expect(appGuideField('where is my email from bob')).toEqual({});
    const question = {
      message_id: '11111111-1111-4111-8111-111111111111',
      thread_id: '22222222-2222-4222-8222-222222222222',
      deal_id: null,
      question: 'Anything new?',
      created_at: '2026-09-21T15:00:00.000Z',
      history: [],
    };
    expect(fireText({ ...question, app_guide: [] })).toBe(fireText(question));
  });
});

describe('the app_guide_search tool', () => {
  it('is a read-only tool, offered even when writes are off', () => {
    const readOnly = toolDefinitions({ allowWrites: false }).map((t) => t.name);
    expect(readOnly).toContain('app_guide_search');
  });

  it('returns the places with Help citations the answer can cite', async () => {
    const registry = new CitationRegistry();
    const outcome = await executeTool(
      { name: 'app_guide_search', input: { question: 'where do I turn on phone alerts' } },
      { auth: harness.auth, registry, scopeDealId: null },
      { allowWrites: false },
    );
    expect(outcome.ok).toBe(true);
    const parsed = JSON.parse(outcome.content) as {
      places: { source_id: string; page: string; tab: string | null; link: string }[];
    };
    expect(parsed.places[0]).toMatchObject({
      source_id: 'help:settings:preferences',
      page: 'Settings',
      tab: 'Preferences',
      link: '/settings?tab=preferences',
    });
    const { citations, invalid } = registry.resolve([
      { source_id: 'help:settings:preferences', page: null, quote: null },
    ]);
    expect(invalid).toEqual([]);
    expect(citations[0]?.kind).toBe('help');
  });

  it('says so when nothing matches, rather than guessing', async () => {
    const outcome = await executeTool(
      { name: 'app_guide_search', input: { question: 'quantum flux capacitor' } },
      { auth: harness.auth, registry: new CitationRegistry(), scopeDealId: null },
    );
    const parsed = JSON.parse(outcome.content) as { places: unknown[]; note: string };
    expect(parsed.places).toEqual([]);
    expect(parsed.note).toContain('do not guess');
  });
});
