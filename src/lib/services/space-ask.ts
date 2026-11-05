import 'server-only';
import { SPACE_ASK_PROMPT } from '@/lib/ai/prompts';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { getAI } from '@/lib/runtime';
import {
  fenceUntrusted,
  UNTRUSTED_CONTENT_RULE,
  type UntrustedBlock,
} from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { spaceItems, type SpaceItems } from './space-content';
import type { SpaceAccess } from './spaces';

/**
 * Ask inside a Space, and its short summary: Kraken's own AI path (getAI,
 * the same as the Inbox's helpers and Ask's direct mode), with what the
 * model sees limited to this Space's emails and meeting notes, hidden items
 * left out. The daily budget and hourly limit are checked first and usage is
 * recorded; live mail with no API key gets a plain refusal. Signed-in members
 * only (the routes check), never the public bots. The demo answers from its
 * fictional items without calling a model: zero spend.
 *
 * Read-only: an answer never sends, drafts or changes anything.
 */

const MAX_SOURCES = 12;
const SOURCE_CHARS = 1_500;
const QUESTION_MAX = 500;
const SUMMARY_TTL_MS = 10 * 60_000;
export const SUMMARY_QUESTION =
  'Summarise where things stand in three or four short bullets: what is happening, what is open, and what is next.';

const cache = processWide('space-ask', () => ({
  summaries: new Map<string, { at: number; answer: SpaceAnswer }>(),
}));

/** Test hook. */
export function resetSpaceAskCache(): void {
  cache.summaries.clear();
}

export interface SpaceAnswer {
  answer: string;
  sources: { kind: 'email' | 'note' | 'meeting'; id: string; label: string; at: string }[];
  demo: boolean;
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

interface Candidate {
  block: UntrustedBlock;
  source: SpaceAnswer['sources'][number];
  score: number;
}

/** The Space's items most related to the question, newest first among equals. */
export function pickSources(items: SpaceItems, question: string): Candidate[] {
  const asked = words(question);
  const score = (text: string) => {
    let n = 0;
    for (const w of words(text)) if (asked.has(w)) n++;
    return n;
  };
  const all: Candidate[] = [
    ...items.notes.map((n) => ({
      block: {
        sourceId: `note:${n.id}`,
        sourceKind: 'meeting_note',
        label: n.title,
        text: n.preview.slice(0, SOURCE_CHARS),
        occurredAt: n.at,
      },
      source: { kind: 'note' as const, id: n.id, label: n.title, at: n.at },
      score: score(`${n.title} ${n.preview}`) + 1,
    })),
    ...items.threads.map((t) => ({
      block: {
        sourceId: `email:${t.id}`,
        sourceKind: 'email',
        label: t.subject,
        text: `From ${t.who}. ${t.snippet}`.slice(0, SOURCE_CHARS),
        occurredAt: t.at,
      },
      source: { kind: 'email' as const, id: t.id, label: t.subject, at: t.at },
      score: score(`${t.subject} ${t.snippet} ${t.who}`),
    })),
    ...items.meetings.map((m) => ({
      block: {
        sourceId: `meeting:${m.id}`,
        sourceKind: 'calendar_event',
        label: m.title,
        text: `${m.upcoming ? 'Upcoming meeting' : 'Meeting'}: ${m.title}, with ${m.people.join(', ') || 'the team'}.`,
        occurredAt: m.at,
      },
      source: { kind: 'meeting' as const, id: m.id, label: m.title, at: m.at },
      score: score(`${m.title} ${m.people.join(' ')}`),
    })),
  ];
  return all
    .sort((a, b) => b.score - a.score || b.source.at.localeCompare(a.source.at))
    .slice(0, MAX_SOURCES);
}

/** The demo's answer: what the Space holds that bears on the question, no model. */
function demoAnswer(spaceName: string, picked: Candidate[], summary: boolean): string {
  if (!picked.length) return `Nothing in ${spaceName} answers that yet.`;
  const top = picked.slice(0, 3);
  const lead = summary
    ? `[Demo summary] ${spaceName} at a glance:`
    : `[Demo answer] From what is in ${spaceName}:`;
  return [
    lead,
    ...top.map((c) => `- ${c.block.text.split('\n')[0]?.slice(0, 160)} [${c.source.label}]`),
  ].join('\n');
}

export async function askSpace(
  store: DataStore,
  auth: Pick<AuthContext, 'organizationId' | 'userId' | 'isDemo'>,
  access: SpaceAccess,
  rawQuestion: string,
  options: { summary?: boolean; now?: Date } = {},
): Promise<Result<SpaceAnswer>> {
  if (!access.canView) return err('forbidden', 'Accept the invite first.');
  const question = rawQuestion.replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);
  if (!question) return err('invalid_input', 'Type a question first.');
  const summary = Boolean(options.summary);
  const now = options.now ?? new Date();
  const items = await spaceItems(store, access, now);
  const picked = pickSources(items, question);
  const sources = picked.map((c) => c.source);

  const cacheKey = `${access.space.id}:${access.hidden.length}:${access.rules.length}`;
  if (summary) {
    const hit = cache.summaries.get(cacheKey);
    if (hit && now.getTime() - hit.at < SUMMARY_TTL_MS) return ok(hit.answer);
  }
  if (auth.isDemo) {
    return ok({ answer: demoAnswer(access.space.name, picked, summary), sources, demo: true });
  }
  if (!picked.length) {
    return ok({
      answer: `Nothing in ${access.space.name} answers that yet: no emails or meeting notes match its rules.`,
      sources: [],
      demo: false,
    });
  }

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId, now);
  if (!budget.ok) return budget;
  const operation = summary ? 'spaces.summary' : 'spaces.ask';
  const res = await getAI().generateText({
    tier: 'fast',
    operation,
    promptVersion: SPACE_ASK_PROMPT.version,
    system: SPACE_ASK_PROMPT.system,
    messages: [
      {
        role: 'user',
        content: `${UNTRUSTED_CONTENT_RULE}

Space: ${access.space.name}

<sources>
${fenceUntrusted(picked.map((c) => c.block))}
</sources>

Question: ${question}`,
      },
    ],
    maxTokens: 700,
  });
  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation,
    promptVersion: SPACE_ASK_PROMPT.version,
    usage: res.ok ? res.value.usage : null,
    ok: res.ok,
    errorCode: res.ok ? null : res.error.code,
  });
  if (!res.ok) return res;
  const answer: SpaceAnswer = { answer: res.value.text.trim(), sources, demo: false };
  if (summary) {
    cache.summaries.set(cacheKey, { at: now.getTime(), answer });
    if (cache.summaries.size > 200) cache.summaries.clear();
  }
  return ok(answer);
}
