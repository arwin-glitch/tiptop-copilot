import 'server-only';
import { CitationRegistry } from '@/lib/ai/citations';
import { PROMPTS } from '@/lib/ai/prompts';
import { chatAnswerSchema } from '@/lib/ai/schemas';
import { executeTool, toolDefinitions, type ToolContext } from '@/lib/ai/tools/registry';
import type { AuthContext } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import type { ChatMessage, ChatThread, Citation, Deal } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { getActiveThesis } from './thesis';

/**
 * Ask TipTop.
 *
 * The model reaches data only through the allowlisted tool layer, and its final
 * answer is a schema-validated object whose first field is the direct answer.
 * Anything the answer rests on has to resolve to a citation the tools actually
 * produced during this turn — a fabricated source id is dropped and reported,
 * not rendered.
 */

export interface AskResult {
  thread: ChatThread;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export async function listThreads(
  organizationId: string,
  userId: string,
  limit = 30,
): Promise<ChatThread[]> {
  const store = getStore();
  return (await store.list(
    'chat_threads',
    organizationId,
    { eq: { user_id: userId } },
    { orderBy: [{ field: 'updated_at', direction: 'desc' }], limit },
  )) as ChatThread[];
}

export async function getThread(
  organizationId: string,
  threadId: string,
): Promise<{ thread: ChatThread; messages: ChatMessage[] } | null> {
  const store = getStore();
  const thread = (await store.get('chat_threads', organizationId, threadId)) as ChatThread | null;
  if (!thread) return null;
  const messages = (await store.list(
    'chat_messages',
    organizationId,
    { eq: { thread_id: threadId } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as ChatMessage[];
  return { thread, messages };
}

export interface AskOptions {
  threadId?: string | null;
  /** Scopes every tool read to one deal. */
  dealId?: string | null;
  allowWrites?: boolean;
}

export async function ask(
  auth: AuthContext,
  question: string,
  options: AskOptions = {},
): Promise<Result<AskResult>> {
  const trimmed = question.trim();
  if (!trimmed) return err('invalid_input', 'Ask a question first.');
  if (trimmed.length > 4_000) {
    return err('invalid_input', 'That question is too long. Trim it to under 4,000 characters.');
  }

  const store = getStore();
  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  let thread: ChatThread | null = options.threadId
    ? ((await store.get(
        'chat_threads',
        auth.organizationId,
        options.threadId,
      )) as ChatThread | null)
    : null;

  if (options.threadId && !thread) {
    return err('not_found', 'That conversation does not exist.');
  }

  if (!thread) {
    const now = new Date().toISOString();
    thread = {
      id: newId(),
      organization_id: auth.organizationId,
      user_id: auth.userId,
      title: truncate(trimmed, 70),
      deal_id: options.dealId ?? null,
      created_at: now,
      updated_at: now,
    };
    await store.insert('chat_threads', thread);
  }

  const scopeDealId = thread.deal_id ?? options.dealId ?? null;
  if (scopeDealId) {
    const deal = (await store.get('deals', auth.organizationId, scopeDealId)) as Deal | null;
    if (!deal) return err('not_found', 'The deal this conversation is scoped to no longer exists.');
  }

  const history = (await store.list(
    'chat_messages',
    auth.organizationId,
    { eq: { thread_id: thread.id } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }], limit: 20 },
  )) as ChatMessage[];

  const userMessage: ChatMessage = {
    id: newId(),
    organization_id: auth.organizationId,
    thread_id: thread.id,
    role: 'user',
    content: trimmed,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    created_at: new Date().toISOString(),
  };
  await store.insert('chat_messages', userMessage);

  const registry = new CitationRegistry();
  const ctx: ToolContext = { auth, registry, scopeDealId };
  const allowWrites = options.allowWrites ?? true;

  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);

  const preamble = `<context>${JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    timezone: auth.profile.timezone,
    user: auth.profile.full_name ?? 'Nick',
    organization: auth.organization.name,
    scoped_to_deal_id: scopeDealId,
    thesis_summary: truncate(thesis.thesis_notes, 800),
    write_tools_enabled: allowWrites,
  })}</context>`;

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user' as const,
      content: `${preamble}\n\nQuestion: ${trimmed}`,
    },
  ];

  const ai = getAI();
  const response = await ai.runToolConversation({
    tier: 'deep',
    operation: 'chat.answer',
    promptVersion: PROMPTS.conversationalToolUse.version,
    system: PROMPTS.conversationalToolUse.system,
    messages,
    tools: toolDefinitions({ allowWrites }),
    execute: (invocation) => executeTool(invocation, ctx, { allowWrites }),
    finalSchema: chatAnswerSchema,
    maxIterations: 6,
    maxTokens: 12_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'chat.answer',
    promptVersion: PROMPTS.conversationalToolUse.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;

  const output = response.value.value;
  const refs = output.supporting_evidence.map((e) => e.citation);
  const { citations, invalid } = registry.resolve(refs);

  if (invalid.length > 0) {
    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'security.citation_rejected',
      entityType: 'chat_message',
      entityId: thread.id,
      metadata: { rejected: invalid.length, operation: 'chat.answer' },
    });
  }

  const body = renderAnswer(output, citations, invalid.length);

  const assistantMessage: ChatMessage = {
    id: newId(),
    organization_id: auth.organizationId,
    thread_id: thread.id,
    role: 'assistant',
    content: body,
    citations,
    tool_calls: response.value.toolOutcomes.map((o) => ({
      name: o.name,
      input: o.input,
      ok: o.ok,
      summary: o.summary,
    })),
    model: response.value.usage.model,
    prompt_version: PROMPTS.conversationalToolUse.version,
    created_at: new Date().toISOString(),
  };
  await store.insert('chat_messages', assistantMessage);
  await store.update('chat_threads', auth.organizationId, thread.id, {
    updated_at: new Date().toISOString(),
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'chat.question_asked',
    entityType: 'chat_thread',
    entityId: thread.id,
    metadata: {
      tools_used: response.value.toolOutcomes.map((o) => o.name),
      citations: citations.length,
      scoped_to_deal: Boolean(scopeDealId),
    },
  });

  return ok({ thread, userMessage, assistantMessage });
}

/**
 * Render the structured answer into the text the UI shows.
 *
 * Answer first, then evidence with provenance, then unknowns, then next
 * actions. The ordering is fixed here rather than left to the model so it
 * cannot drift.
 */
function renderAnswer(
  output: {
    answer: string;
    supporting_evidence: { point: string; kind: string; citation: { source_id: string } | null }[];
    unknowns: string[];
    next_actions: string[];
  },
  citations: Citation[],
  rejectedCount: number,
): string {
  const lines: string[] = [output.answer.trim()];

  const cited = output.supporting_evidence.filter(
    (e) => !e.citation || citations.some((c) => c.id === e.citation?.source_id),
  );

  if (cited.length > 0) {
    lines.push('');
    lines.push('Evidence');
    for (const e of cited) {
      const marker = e.citation
        ? citations.find((c) => c.id === e.citation?.source_id)?.label
        : null;
      lines.push(`• ${e.point}${marker ? ` [${marker}]` : ' [uncited]'}`);
    }
  }

  if (output.unknowns.length > 0) {
    lines.push('');
    lines.push('Not known');
    for (const u of output.unknowns) lines.push(`• ${u}`);
  }

  if (output.next_actions.length > 0) {
    lines.push('');
    lines.push('Next');
    for (const a of output.next_actions) lines.push(`• ${a}`);
  }

  if (rejectedCount > 0) {
    lines.push('');
    lines.push(
      `Note: ${rejectedCount} citation${rejectedCount === 1 ? '' : 's'} referenced a source that does not exist and ${rejectedCount === 1 ? 'was' : 'were'} removed.`,
    );
  }

  return lines.join('\n');
}

/** Starter questions shown on an empty Ask screen. */
export const SUGGESTED_QUESTIONS = [
  'What actually needs my attention today?',
  'What important emails came in since yesterday?',
  'Did any new deals arrive recently?',
  'Give me a 30-second overview of the newest deal.',
  'What follow-ups are overdue?',
  'Which portfolio companies need help?',
  'What patterns are appearing in the deals I have reviewed recently?',
  'Have I seen something similar to this before?',
] as const;
