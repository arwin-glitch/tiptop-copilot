import 'server-only';
import { z } from 'zod';
import { PROMPTS } from '@/lib/ai/prompts';
import type { AuthContext } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { fenceUntrusted, UNTRUSTED_CONTENT_RULE } from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { processWide } from '@/lib/util/process-state';
import { ok, type Result } from '@/lib/util/result';
import { readLiveThread, type LiveMessage } from './inbox-live';

/**
 * The Inbox's two Kraken AI helpers, each on demand from a person:
 *
 * - Suggested replies: three short replies under a conversation's last
 *   message, read when the conversation opens (once per newest message,
 *   then from this process's cache). A chip only fills the reply box;
 *   nothing here sends, drafts or saves.
 * - Translate message: one message into English, from its ⋮ menu.
 *
 * Both use Kraken's one AI path (getAI, the same as drafts and Ask's direct
 * mode): the daily budget and hourly limit are checked first, usage is
 * recorded, and live mail with no API key gets a refusal, never the mock.
 * Only the conversation itself is sent, fenced as untrusted data; no Brain,
 * CRM or other record goes along. The demo answers with canned text and
 * never calls a model: zero spend.
 */

const MAX_CHARS = 6_000;
const CACHE_MAX = 300;

const cache = processWide('inbox-ai', () => ({
  replies: new Map<string, string[]>(),
}));

/** Test hook. */
export function resetInboxAiCache(): void {
  cache.replies.clear();
}

function remember<V>(map: Map<string, V>, key: string, value: V): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value!);
  return value;
}

const repliesSchema = z.object({ replies: z.array(z.string().min(1).max(200)).min(1).max(3) });

export const DEMO_REPLIES = [
  'Thanks, this is helpful.',
  'Sounds good, let’s do it.',
  'Can we find time next week?',
];

const block = (m: LiveMessage, subject: string) => ({
  sourceId: `email:${m.id}`,
  sourceKind: 'email',
  label: subject || '(no subject)',
  text: m.text.slice(0, MAX_CHARS),
  occurredAt: m.at,
});

export async function suggestReplies(
  auth: AuthContext,
  threadId: string,
): Promise<Result<{ replies: string[] }>> {
  const store = getStore();
  const thread = await readLiveThread(store, auth.organizationId, threadId);
  if (!thread.ok) return thread;
  const last = thread.value.messages.at(-1);
  if (!last || last.fromUs) return ok({ replies: [] });
  if (auth.isDemo) return ok({ replies: DEMO_REPLIES });
  const key = `${threadId}:${last.id}`;
  const hit = cache.replies.get(key);
  if (hit) return ok({ replies: hit });

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;
  const prompt = PROMPTS.inboxSuggestReplies;
  const res = await getAI().generateStructured({
    tier: 'fast',
    operation: 'inbox.suggest_replies',
    promptVersion: prompt.version,
    system: prompt.system,
    messages: [
      {
        role: 'user',
        content: `${UNTRUSTED_CONTENT_RULE}

<sources>
${fenceUntrusted([block(last, thread.value.subject)])}
</sources>

Suggest three short replies to this email.`,
      },
    ],
    schema: repliesSchema,
    maxTokens: 400,
  });
  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'inbox.suggest_replies',
    promptVersion: prompt.version,
    usage: res.ok ? res.value.usage : null,
    ok: res.ok,
    errorCode: res.ok ? null : res.error.code,
  });
  if (!res.ok) return res;
  const replies = res.value.value.replies
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 3);
  return ok({ replies: remember(cache.replies, key, replies) });
}
