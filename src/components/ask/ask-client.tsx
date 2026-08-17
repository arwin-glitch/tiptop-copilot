'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CornerDownLeft, Wrench } from 'lucide-react';
import { askAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PlainText } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { Textarea } from '@/components/ui/form';
import { CitationChip, SourceDrawer } from '@/components/evidence/source-drawer';
import type { ChatMessage, Citation } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/**
 * Ask TipTop.
 *
 * Chat lives here and only here — the rest of the product is structured, so
 * this screen is the one place where an open-ended question is genuinely the
 * right interface.
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
          setActiveThread(result.data.threadId);
          router.refresh();
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          setQuestion(trimmed);
          toast.error(result.error?.message ?? 'That question could not be answered', {
            description: result.error?.stillUsable,
          });
        }
      });
    },
    [activeThread, dealId, pending, router],
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

  return (
    <div className="flex flex-col">
      {dealName ? (
        <div className="mb-4">
          <Badge tone="info">Scoped to {dealName}</Badge>
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
            {message.role === 'user' ? (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-[var(--radius-card)] rounded-br-sm bg-[var(--accent-soft)] px-3.5 py-2.5">
                  <PlainText text={message.content} />
                </div>
              </div>
            ) : (
              <AssistantMessage message={message} />
            )}
          </li>
        ))}
        {pending ? (
          <li>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
                  <span className="skeleton size-3 rounded-full" />
                  Searching your records…
                </div>
              </CardContent>
            </Card>
          </li>
        ) : null}
      </ol>
      <div ref={endRef} />

      {aiAvailable ? (
        <form
          className="sticky bottom-16 mt-5 lg:bottom-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit(question);
          }}
        >
          <div className="shadow-lifted rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-2">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit(question);
                }
              }}
              rows={2}
              placeholder={dealName ? `Ask about ${dealName}…` : 'Ask about anything in TipTop…'}
              aria-label="Your question"
              className="min-h-0 resize-none border-0 bg-transparent px-2 py-1.5 focus-visible:outline-none"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span className="text-micro text-[var(--fg-subtle)]">
                Answers cite their sources. Unknowns are stated, not filled in.
              </span>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={pending}
                disabled={!question.trim()}
              >
                Ask
                <CornerDownLeft aria-hidden="true" />
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const citations: Citation[] = message.citations;
  const [answer, ...rest] = splitAnswer(message.content);

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="outline">
            <span aria-hidden="true">✦</span> AI-generated
          </Badge>
          {citations.length > 0 ? (
            <SourceDrawer citations={citations}>
              <Button variant="ghost" size="sm">
                Sources
                <span className="tabular ml-1 text-[var(--fg-subtle)]">{citations.length}</span>
              </Button>
            </SourceDrawer>
          ) : null}
        </div>

        <p className="mt-2.5 text-[15px] leading-relaxed font-medium">{answer}</p>

        {rest.length > 0 ? (
          <PlainText text={rest.join('\n')} className="mt-3 text-[var(--fg-muted)]" />
        ) : null}

        {citations.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {citations.map((c) => (
              <CitationChip key={c.id} citation={c} citations={citations} />
            ))}
          </div>
        ) : null}

        {message.tool_calls.length > 0 ? (
          <details className="mt-3">
            <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--fg-subtle)]">
              <Wrench className="size-3" aria-hidden="true" />
              {message.tool_calls.length} tool call{message.tool_calls.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1.5 space-y-1">
              {message.tool_calls.map((t, i) => (
                <li
                  key={i}
                  className={cn(
                    'text-[11px]',
                    t.ok ? 'text-[var(--fg-muted)]' : 'text-[var(--danger)]',
                  )}
                >
                  <span className="font-mono">{t.name}</span> — {t.summary}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The first paragraph is the direct answer; everything after is support. */
function splitAnswer(content: string): string[] {
  const blocks = content.split('\n');
  const first = blocks[0] ?? '';
  return [first, ...blocks.slice(1)];
}
