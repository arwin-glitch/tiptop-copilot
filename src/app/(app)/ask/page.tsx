import type { Metadata } from 'next';
import Link from 'next/link';
import { hasRole, requireAuth, type AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { feedbackCounts, type FeedbackItem } from '@/lib/feedback/shared';
import { ASK_TABS, resolvePageTab } from '@/lib/records-tabs';
import { getAI, getStore } from '@/lib/runtime';
import { settleAnswersFromSlack } from '@/lib/services/ask-routine';
import { getThread, listThreads, SUGGESTED_QUESTIONS } from '@/lib/services/chat';
import { feedbackAlertsOn, listFeedback } from '@/lib/services/feedback';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { AiTag } from '@/components/ask/ai-tag';
import { AskClient } from '@/components/ask/ask-client';
import {
  FeedbackAlertsToggle,
  FeedbackList,
  FeedbackPageComposer,
} from '@/components/ask/feedback-list';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import type { ChatMessage, Deal } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Ask Arwin' };
export const dynamic = 'force-dynamic';

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = resolvePageTab(ASK_TABS, params);
  const threadId = single(params.thread) ?? null;
  const dealId = single(params.deal) ?? null;
  const initialQuestion = single(params.q) ?? '';

  const auth = await requireAuth();
  const store = getStore();

  // Asked on the server, before anything is drawn. Previously this screen
  // offered a composer and eight suggested questions with no key configured,
  // and only said so as a toast *after* the user had typed and pressed Ask.
  //
  // The Ask bridge counts as "available" too: `ask()` routes every question
  // to it instead of the in-app Anthropic call whenever it is configured, so
  // the composer should show up even with no ANTHROPIC_API_KEY set.
  const aiAvailable = getAI().available() || Boolean(env().askBridgeToken);

  // The Feedback tab's notes, and its count of open ones on the tab bar. A
  // store fault only costs the count (or shows the tab as unavailable), never
  // the conversation.
  const feedbackRead = listFeedback(store, auth.organizationId).catch(() => null);

  if (tab === 'feedback') {
    const feedback = await feedbackRead;
    return (
      <PageShell className="max-w-4xl">
        <AskHeader tab={tab} aiAvailable={aiAvailable} feedback={feedback} />
        <FeedbackTab auth={auth} items={feedback} />
      </PageShell>
    );
  }

  const [threads, deal, feedback] = await Promise.all([
    listThreads(auth.organizationId, auth.userId, 15),
    dealId ? (store.get('deals', auth.organizationId, dealId) as Promise<Deal | null>) : null,
    feedbackRead,
  ]);

  // The Ask page re-renders every few seconds while an answer is pending. Each
  // pass is the moment to check whether the routine has posted it to Slack.
  if (threadId) await settleAnswersFromSlack(store, auth.organizationId);

  let messages: ChatMessage[] = [];
  if (threadId) {
    const loaded = await getThread(auth.organizationId, threadId);
    if (loaded) messages = loaded.messages;
  }

  return (
    <PageShell className="max-w-4xl">
      <AskHeader tab={tab} aiAvailable={aiAvailable} feedback={feedback} />

      <div className="grid gap-6 lg:grid-cols-[1fr_220px]">
        <AskClient
          initialMessages={messages}
          threadId={threadId}
          dealId={dealId}
          dealName={deal?.company_name ?? null}
          suggestions={SUGGESTED_QUESTIONS}
          initialQuestion={initialQuestion}
          aiAvailable={aiAvailable}
        />

        {/* After the composer on a phone, beside it from lg. It used to come
            first on a phone, and fifteen conversations put the composer a
            screen below the top: it was on screen only once the scroll to the
            end of the conversation finished, and not at all before. */}
        <aside>
          <Card>
            <CardContent className="pt-4">
              <FieldLabel as="h2">Recent</FieldLabel>
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

/** The title with its "AI" tag, and the bar between the conversation and the feedback. */
function AskHeader({
  tab,
  aiAvailable,
  feedback,
}: {
  tab: 'conversations' | 'feedback';
  aiAvailable: boolean;
  feedback: FeedbackItem[] | null;
}) {
  const open = feedback ? feedbackCounts(feedback).open : 0;
  return (
    <>
      <PageHeader
        title="Ask Arwin"
        titleTag={<AiTag className="ml-2.5" />}
        subtitle={
          tab === 'feedback'
            ? 'What to change in Kraken, sent from the Feedback tab of the chat, with the page it was about.'
            : aiAvailable
              ? 'One question, one direct answer, with the record it came from.'
              : 'Answering questions needs an AI provider, which is not connected. Past conversations are still here to read.'
        }
      />
      <PageTabs
        label={ASK_TABS.navLabel}
        path={ASK_TABS.path}
        tabs={ASK_TABS.tabs.map((t) => ({
          key: t.key,
          label: t.label,
          ...(t.key === 'feedback' && open > 0 ? { count: open } : {}),
        }))}
        active={tab}
        defaultKey={ASK_TABS.defaultKey}
      />
    </>
  );
}

/**
 * Every feedback note, newest first, to read and mark done; beside it, a box
 * to add one (this page has no Ask Arwin panel) and the switch for desktop
 * alerts when someone else sends one.
 */
async function FeedbackTab({ auth, items }: { auth: AuthContext; items: FeedbackItem[] | null }) {
  const alertsOn = await feedbackAlertsOn(getStore(), auth.organizationId, auth.userId).catch(
    () => null,
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
      {items ? (
        <FeedbackList
          items={items}
          timeZone={auth.profile.timezone}
          canClose={hasRole(auth, 'member')}
        />
      ) : (
        <Notice tone="warn">Feedback could not be loaded just now. Reload to try again.</Notice>
      )}
      <aside className="space-y-4">
        <Card>
          <CardContent className="pt-4">
            <FeedbackPageComposer />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <FeedbackAlertsToggle initialOn={alertsOn} />
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
