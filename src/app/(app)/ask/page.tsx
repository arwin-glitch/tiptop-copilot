import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getThread, listThreads, SUGGESTED_QUESTIONS } from '@/lib/services/chat';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { AskClient } from '@/components/ask/ask-client';
import { Card, CardContent } from '@/components/ui/card';
import type { ChatMessage, Deal } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Ask TipTop' };
export const dynamic = 'force-dynamic';

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const threadId = single(params.thread) ?? null;
  const dealId = single(params.deal) ?? null;
  const initialQuestion = single(params.q) ?? '';

  const auth = await requireAuth();
  const store = getStore();

  const [threads, deal] = await Promise.all([
    listThreads(auth.organizationId, auth.userId, 15),
    dealId ? (store.get('deals', auth.organizationId, dealId) as Promise<Deal | null>) : null,
  ]);

  let messages: ChatMessage[] = [];
  if (threadId) {
    const loaded = await getThread(auth.organizationId, threadId);
    if (loaded) messages = loaded.messages;
  }

  return (
    <PageShell className="max-w-4xl">
      <PageHeader
        title="Ask TipTop"
        subtitle="One question, one direct answer, with the record it came from."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
        <AskClient
          initialMessages={messages}
          threadId={threadId}
          dealId={dealId}
          dealName={deal?.company_name ?? null}
          suggestions={SUGGESTED_QUESTIONS}
          initialQuestion={initialQuestion}
        />

        <aside className="order-first lg:order-last">
          <Card>
            <CardContent className="pt-4">
              <h2 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Recent
              </h2>
              {threads.length === 0 ? (
                <p className="mt-2 text-xs text-[var(--fg-subtle)]">No conversations yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {threads.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/ask?thread=${t.id}`}
                        className="block rounded px-1.5 py-1 text-[13px] text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                      >
                        <span className="line-clamp-2">{t.title}</span>
                        <span className="text-[10px] text-[var(--fg-subtle)]">
                          {relativeTime(t.updated_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {threadId ? (
                <Link
                  href={dealId ? `/ask?deal=${dealId}` : '/ask'}
                  className="mt-3 block text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  Start a new conversation
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
