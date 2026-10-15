'use client';

import * as React from 'react';
import { CornerDownLeft, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PlainText } from '@/components/ui/feedback';
import { Textarea } from '@/components/ui/form';
import { LinkedText } from '@/components/ask/linked-text';
import { CitationChip, SourceDrawer } from '@/components/evidence/source-drawer';
import type { ChatMessage, Citation } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/**
 * The pieces of an Ask conversation, shared by the full Ask page and the Ask
 * Arwin widget so the two never drift: the same answer layout, the same
 * waiting state for an answer still on its way, the same composer keys.
 * `compact` is the widget's denser setting.
 */

export function UserMessage({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'max-w-[85%] rounded-[var(--radius-card)] rounded-br-sm bg-[var(--accent-soft)]',
          compact ? 'px-3 py-2 text-sm' : 'px-3.5 py-2.5',
        )}
      >
        <PlainText text={text} />
      </div>
    </div>
  );
}

/** An answer being worked on: either the request in flight or a pending answer. */
export function WorkingMessage({
  label,
  hint,
  compact = false,
}: {
  label: string;
  /** A second line, for a wait long enough to explain. */
  hint?: string;
  compact?: boolean;
}) {
  return (
    <Card className={compact ? 'shadow-none' : undefined}>
      <CardContent className={compact ? 'px-3 pt-3 pb-3 sm:px-3' : 'pt-4'}>
        <div role="status" className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
          <span className="skeleton size-3 shrink-0 rounded-full" />
          {label}
        </div>
        {hint ? <p className="text-mini mt-1.5 text-[var(--fg-subtle)]">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function AssistantMessage({
  message,
  compact = false,
}: {
  message: ChatMessage;
  compact?: boolean;
}) {
  const citations: Citation[] = message.citations;
  const [answer, ...rest] = splitAnswer(message.content);

  return (
    <Card className={compact ? 'shadow-none' : undefined}>
      <CardContent className={compact ? 'px-3 pt-3 pb-3 sm:px-3' : 'pt-4'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="outline">
            <span aria-hidden="true">✦</span> AI-generated
          </Badge>
          {citations.length > 0 ? (
            <SourceDrawer citations={citations}>
              <Button variant="ghost" size="sm" className={compact ? 'h-7 px-2' : undefined}>
                Sources
                <span className="tabular ml-1 text-[var(--fg-subtle)]">{citations.length}</span>
              </Button>
            </SourceDrawer>
          ) : null}
        </div>

        <p
          className={cn(
            'leading-relaxed font-medium',
            compact ? 'mt-2 text-sm' : 'mt-2.5 text-[15px]',
          )}
        >
          <LinkedText text={answer ?? ''} />
        </p>

        {rest.length > 0 ? (
          <div
            className={cn(
              'plain-text leading-relaxed text-[var(--fg-muted)]',
              compact ? 'text-note mt-2' : 'mt-3 text-sm',
            )}
          >
            <LinkedText text={rest.join('\n')} />
          </div>
        ) : null}

        {citations.length > 0 ? (
          <div className={cn('flex flex-wrap gap-1.5', compact ? 'mt-2' : 'mt-3')}>
            {citations.map((c) => (
              <CitationChip key={c.id} citation={c} citations={citations} />
            ))}
          </div>
        ) : null}

        {/* The tool trail is a full-page detail; the widget stays short. */}
        {!compact && message.tool_calls.length > 0 ? (
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

/** One message of a conversation, whichever kind it is. */
export function ConversationMessage({
  message,
  compact = false,
  pendingHint,
}: {
  message: ChatMessage;
  compact?: boolean;
  pendingHint?: string;
}) {
  if (message.role === 'user') return <UserMessage text={message.content} compact={compact} />;
  if (message.status === 'pending') {
    return (
      <WorkingMessage
        label="Checking your inbox, calendar and Slack…"
        hint={pendingHint}
        compact={compact}
      />
    );
  }
  return <AssistantMessage message={message} compact={compact} />;
}

/**
 * The question box. Plain Enter sends; Shift+Enter still inserts a newline.
 */
export function AskComposer({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  hint,
  className,
  textareaRef,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  pending: boolean;
  placeholder: string;
  hint?: React.ReactNode;
  className?: string;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  compact?: boolean;
}) {
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div
        className={cn(
          'rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-2',
          compact ? 'shadow-raised' : 'shadow-lifted',
        )}
      >
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(value);
            }
          }}
          rows={2}
          placeholder={placeholder}
          aria-label="Your question"
          className={cn(
            'min-h-0 resize-none border-0 bg-transparent px-2 py-1.5 focus-visible:outline-none',
            compact && 'text-sm',
          )}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-1">
          <span className="text-micro text-[var(--fg-subtle)]">{hint}</span>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={pending}
            disabled={!value.trim()}
          >
            Ask
            <CornerDownLeft aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The first paragraph is the direct answer; everything after is support. */
function splitAnswer(content: string): string[] {
  const blocks = content.split('\n');
  const first = blocks[0] ?? '';
  return [first, ...blocks.slice(1)];
}
