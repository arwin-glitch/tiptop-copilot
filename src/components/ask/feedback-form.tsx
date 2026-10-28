'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { CircleCheck, Send } from 'lucide-react';
import { sendFeedbackAction } from '@/app/actions/feedback';
import type { ActionResult } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import {
  FEEDBACK_HREF,
  FEEDBACK_TEXT_MAX,
  feedbackPageFrom,
  type FeedbackItem,
} from '@/lib/feedback/shared';
import { cn } from '@/lib/util/cn';

/**
 * The feedback box: what to change in Kraken, in a person's own words.
 *
 * Typed, or dictated with the keyboard's own microphone (a phone's, or the
 * computer's dictation): the page never records audio itself. (Only Kraken
 * Notes' meeting recorder asks for the microphone; see proxy.ts, D-076.)
 *
 * In the Ask Arwin panel (`fromPage`) a note carries the page under the panel
 * (its path and name, read when the panel opened, which it shows) so whoever
 * picks it up sees what it is about. The text is held by the caller, so a
 * half-written note survives switching tabs or closing the panel.
 */
export function FeedbackForm({
  value,
  onChange,
  fromPage = false,
  textareaRef,
  onSent,
  compact = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Send the page it was written on with the note. */
  fromPage?: boolean;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onSent?: (item: FeedbackItem) => void;
  /** The panel's denser setting. */
  compact?: boolean;
  className?: string;
}) {
  // Mounted only once the panel is open, in the browser: the page is the one
  // under the panel, which closes whenever the page changes.
  const [page] = React.useState(() =>
    fromPage && typeof window !== 'undefined'
      ? feedbackPageFrom(window.location.href, document.title)
      : null,
  );
  const [sending, startSending] = React.useTransition();
  const [sent, setSent] = React.useState(false);
  /** "Send more" was tapped: the box takes focus as it comes back. */
  const [again, setAgain] = React.useState(false);
  const hintId = React.useId();

  function send() {
    const text = value.trim();
    if (!text || sending) return;
    startSending(async () => {
      let result: ActionResult<FeedbackItem>;
      try {
        result = await sendFeedbackAction({
          text,
          path: page?.path ?? null,
          title: page?.title ?? null,
        });
      } catch {
        result = {
          ok: false,
          error: { code: 'internal', message: 'That feedback could not be sent. Try again.' },
        };
      }
      if (result.ok && result.data) {
        onChange('');
        setSent(true);
        onSent?.(result.data);
        return;
      }
      toast.error(result.error?.message ?? 'That feedback could not be sent. Try again.');
    });
  }

  if (sent) {
    return (
      <div className={cn('space-y-3', className)}>
        <p role="status" className="flex items-start gap-2 text-sm font-medium">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" aria-hidden="true" />
          Thanks. Your feedback is saved for the team.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Focus moves here from the Send button, which is gone: never
              to the page behind the panel. */}
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              setSent(false);
              setAgain(true);
            }}
          >
            Send more
          </Button>
          {fromPage ? (
            <Link
              href={FEEDBACK_HREF}
              // ASK_FULL_PAGE_ATTR: the click catcher leaves this link alone.
              data-ask-full-page=""
              className="text-sm text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-4 hover:text-[var(--accent-hover)]"
            >
              See all feedback
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const pageName = page ? (page.title ?? page.path) : null;
  const left = FEEDBACK_TEXT_MAX - value.length;

  return (
    <form
      className={cn('space-y-2.5', className)}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div>
        <p className={cn('font-serif font-semibold', compact ? 'text-base' : 'text-lg')}>
          What should change?
        </p>
        <p id={hintId} className="text-mini mt-0.5 text-[var(--fg-muted)]">
          Say what to fix or add in Kraken. Type it, or tap the microphone on your keyboard to
          dictate.
        </p>
      </div>
      {pageName ? (
        <p className="text-mini truncate text-[var(--fg-subtle)]" data-feedback-page="">
          About this page: <span className="font-medium text-[var(--fg-muted)]">{pageName}</span>
        </p>
      ) : null}
      <Textarea
        ref={textareaRef}
        autoFocus={again}
        aria-label="Your feedback"
        aria-describedby={hintId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter is a new line here (dictation ends sentences with it);
          // Ctrl or Cmd with Enter sends.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
          }
        }}
        maxLength={FEEDBACK_TEXT_MAX}
        rows={compact ? 5 : 4}
        placeholder="e.g. Put the due date first on these cards"
        className={compact ? 'text-sm' : undefined}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-micro text-[var(--fg-subtle)]" aria-live="polite">
          {left < 200 ? `${left} characters left` : ''}
        </span>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={sending}
          disabled={!value.trim() || sending}
        >
          {sending ? null : <Send aria-hidden="true" />}
          Send feedback
        </Button>
      </div>
    </form>
  );
}
