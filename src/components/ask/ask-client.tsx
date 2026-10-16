'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { askAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { NotConfigured } from '@/components/ui/not-configured';
import { watchAskReply, type AskWatchDetail } from '@/components/ask/ask-events';
import { AskComposer, ConversationMessage, WorkingMessage } from '@/components/ask/message-parts';
import type { ChatMessage } from '@/lib/types/domain';

/**
 * Ask Arwin, as a full page.
 *
 * The full-page form of Ask. Day to day, questions go through the Ask Arwin
 * widget (components/ask/ask-widget.tsx) on every page; this page stays for
 * deep links, long answers and citations, and shares its message parts with
 * the widget.
 */
export function AskClient({
  initialMessages,
  threadId,
  dealId,
  dealName,
  suggestions,
  initialQuestion,
  aiAvailable,
}: {
  initialMessages: ChatMessage[];
  threadId: string | null;
  dealId: string | null;
  dealName: string | null;
  suggestions: readonly string[];
  initialQuestion: string;
  /**
   * Decided on the server. When false the composer is not rendered at all
   * rather than rendered and disabled: an input that cannot accept input is
   * worse than an honest explanation of why it is missing.
   */
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages);
  const [syncedFrom, setSyncedFrom] = React.useState<ChatMessage[]>(initialMessages);
  const [activeThread, setActiveThread] = React.useState<string | null>(threadId);
  const [question, setQuestion] = React.useState(initialQuestion);
  const [pending, startTransition] = React.useTransition();
  const endRef = React.useRef<HTMLDivElement>(null);
  const askedInitial = React.useRef(false);

  const submit = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        organization_id: '',
        thread_id: activeThread ?? '',
        role: 'user',
        content: trimmed,
        citations: [],
        tool_calls: [],
        model: null,
        prompt_version: null,
        status: 'answered',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setQuestion('');

      startTransition(async () => {
        const result = await askAction(trimmed, {
          threadId: activeThread ?? undefined,
          dealId: dealId ?? undefined,
        });
        if (result.ok && result.data) {
          const newThreadId = result.data.threadId;
          setActiveThread(newThreadId);
          if (newThreadId !== threadId) {
            // The URL is the only thing the server component reads to decide
            // which thread's messages to load. Without this, the next
            // refresh (including the poll for a pending bridge answer) would
            // fetch this same, still-thread-less URL and wipe the
            // conversation back to empty — it would only reappear once the
            // user navigated in via the "Recent" list, which does carry
            // `?thread=`.
            const qs = new URLSearchParams();
            qs.set('thread', newThreadId);
            if (dealId) qs.set('deal', dealId);
            router.replace(`/ask?${qs.toString()}`, { scroll: false });
          } else {
            router.refresh();
          }
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          setQuestion(trimmed);
          toast.error(result.error?.message ?? 'That question could not be answered', {
            description: result.error?.stillUsable,
          });
        }
      });
    },
    [activeThread, dealId, pending, router, threadId],
  );

  // The server is authoritative once a turn has been persisted: a
  // `router.refresh()` hands us a fresh array, and it replaces the optimistic
  // local copy. Adjusting during render rather than in an effect avoids a
  // second render pass showing the pre-refresh transcript.
  if (initialMessages !== syncedFrom) {
    setSyncedFrom(initialMessages);
    setMessages(initialMessages);
  }

  React.useEffect(() => {
    // A `?q=` deep link from elsewhere in the app would otherwise auto-fire a
    // question that is guaranteed to fail, producing an error toast on arrival.
    if (!aiAvailable) return;
    if (initialQuestion && !askedInitial.current && initialMessages.length === 0) {
      askedInitial.current = true;
      submit(initialQuestion);
    }
  }, [aiAvailable, initialQuestion, initialMessages.length, submit]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending]);

  // A bridge answer arrives asynchronously — some other Claude session picks
  // the question up and posts an answer back, typically within a couple of
  // minutes. Poll for it rather than leaving the page looking finished with a
  // blank answer sitting in it.
  const hasOutstandingBridgeAnswer = messages.some(
    (m) => m.role === 'assistant' && m.status === 'pending',
  );
  React.useEffect(() => {
    if (!hasOutstandingBridgeAnswer) return;
    const interval = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(interval);
  }, [hasOutstandingBridgeAnswer, router]);

  // The Ask Arwin widget keeps checking once Nick leaves this page, so an
  // answer that lands later still pops up wherever he is. One that lands
  // here was seen here.
  const watchedThread = React.useRef<string | null>(null);
  React.useEffect(() => {
    let detail: AskWatchDetail | null = null;
    if (hasOutstandingBridgeAnswer && activeThread) {
      watchedThread.current = activeThread;
      detail = { threadId: activeThread, watching: true };
    } else if (!hasOutstandingBridgeAnswer && watchedThread.current) {
      detail = { threadId: watchedThread.current, watching: false };
      watchedThread.current = null;
    }
    if (!detail) return;
    // Sent a tick later. On a hard load (a bookmarked /ask?thread=) this page
    // and the widget hydrate together, and this page's effects run first: the
    // widget, later in the layout, would not be listening yet. Never
    // cancelled, so a hand-over decided here is not lost to a quick unmount;
    // the widget ignores a repeat.
    const send = detail;
    window.setTimeout(() => watchAskReply(send), 0);
  }, [hasOutstandingBridgeAnswer, activeThread]);

  return (
    <div className="flex flex-col">
      {dealName ? (
        <div className="mb-4">
          <Badge tone="accent">Scoped to {dealName}</Badge>
          <p className="mt-1.5 text-xs text-[var(--fg-subtle)]">
            Every tool read is restricted to this deal. Ask about anything else from the main Ask
            screen.
          </p>
        </div>
      ) : null}

      {!aiAvailable ? (
        <NotConfigured
          className="mb-5"
          title="Ask is unavailable"
          description="Answering a question means running a model over your records, and no AI provider is connected. Nothing is guessed from memory, so the question is not attempted at all."
          stillWorks="Every record Ask would have searched is browsable directly — email in the Inbox, pipeline in Deals, companies in Portfolio, and extracted facts on each deal page."
        />
      ) : messages.length === 0 ? (
        <div className="mb-5">
          <p className="mb-3 text-sm text-[var(--fg-muted)]">
            Ask about email, deals, documents, prior decisions, portfolio, tasks and calendar.
            Answers come from your records, with the source attached.
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="text-note rounded-full border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <ol className="space-y-4">
        {messages.map((message) => (
          <li key={message.id}>
            <ConversationMessage message={message} />
          </li>
        ))}
        {pending ? (
          <li>
            <WorkingMessage label="Searching your records…" />
          </li>
        ) : null}
      </ol>
      <div ref={endRef} />

      {aiAvailable ? (
        <AskComposer
          className="sticky bottom-16 mt-5 lg:bottom-4"
          value={question}
          onChange={setQuestion}
          onSubmit={submit}
          pending={pending}
          placeholder={dealName ? `Ask about ${dealName}…` : 'Ask Arwin anything…'}
          hint="Answers cite their sources. Unknowns are stated, not filled in."
        />
      ) : null}
    </div>
  );
}
