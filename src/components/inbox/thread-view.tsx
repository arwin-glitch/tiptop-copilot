'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  ExternalLink,
  Forward,
  Inbox as InboxIcon,
  Loader2,
  Mail,
  Reply,
  Send,
  Star,
  Tag,
  Undo2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { swapSignOff } from '@/components/followups/email-session-client';
import type { ComposeDraft } from '@/components/inbox/composer';
import { LabelMenu } from '@/components/inbox/label-menu';
import { MessageItem, longTime } from '@/components/inbox/message-view';
import { readerZone, SnoozeMenu } from '@/components/inbox/snooze-menu';
import type { LabelChange, MailLabel } from '@/lib/email/inbox-actions';
import type { SystemAction } from '@/lib/email/inbox-modify';
import { formatWake } from '@/lib/email/snooze';
import { cn } from '@/lib/util/cn';
import type { LiveThread, LiveThreadRow } from '@/lib/services/inbox-live';

type Signature = 'nick' | 'arwin';
type Action = SystemAction;

const UNDO_SECONDS = 8;

export const gmailUrl = (id: string, mailbox: string | null) =>
  mailbox
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${id}`
    : `https://mail.google.com/mail/#all/${id}`;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

export function ThreadView({
  row,
  timeZone,
  initialThread,
  canAct,
  mailbox,
  replyOpen,
  setReplyOpen,
  onBack,
  onAct,
  labelChoices,
  onLabel,
  labelMenuOpen,
  setLabelMenuOpen,
  onSnooze,
  snoozeMenuOpen,
  setSnoozeMenuOpen,
  snoozedUntil,
  onUnsnooze,
  onSent,
  onForward,
}: {
  row: LiveThreadRow;
  timeZone: string;
  /** The conversation already read on the server (a link opened it): shown without a second read. */
  initialThread?: LiveThread;
  canAct: boolean;
  mailbox: string | null;
  replyOpen: boolean;
  setReplyOpen: (open: boolean) => void;
  onBack: () => void;
  onAct: (action: Action) => Promise<boolean>;
  labelChoices: readonly MailLabel[];
  onLabel: ((change: LabelChange) => void) | null;
  labelMenuOpen: boolean;
  setLabelMenuOpen: (open: boolean) => void;
  onSnooze: ((wakeAt: Date) => void) | null;
  snoozeMenuOpen: boolean;
  setSnoozeMenuOpen: (open: boolean) => void;
  /** Opened from the Snoozed tab: when it comes back; Unsnooze replaces Move to inbox. */
  snoozedUntil: string | null;
  onUnsnooze: () => void;
  onSent: () => void;
  onForward: (draft: ComposeDraft) => void;
}) {
  const [thread, setThread] = React.useState<LiveThread | null>(initialThread ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  // Read once on the server already: the first look needs no second read of Gmail.
  const seeded = React.useRef(Boolean(initialThread));

  React.useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    let cancelled = false;
    fetch(`/api/inbox/thread?id=${row.id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorMessage(r, 'Could not open this conversation.'));
        return ((await r.json()) as { thread: LiveThread }).thread;
      })
      .then((t) => {
        if (!cancelled) {
          setThread(t);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, reloadKey]);

  return (
    <article className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      <header className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] p-2">
        <Button size="sm" variant="ghost" onClick={onBack} aria-label="Back to the list">
          <ArrowLeft className="size-4" aria-hidden />
          <span className="lg:hidden">Back</span>
        </Button>
        <div className="flex-1" />
        {snoozedUntil ? (
          <Button size="sm" variant="secondary" onClick={onUnsnooze}>
            <InboxIcon className="size-4" aria-hidden /> Unsnooze
          </Button>
        ) : row.inInbox ? (
          <Button size="sm" variant="secondary" onClick={() => void onAct('archive')}>
            <Archive className="size-4" aria-hidden /> Archive
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void onAct('inbox')}>
            <InboxIcon className="size-4" aria-hidden /> Move to inbox
          </Button>
        )}
        {onSnooze ? (
          <SnoozeMenu
            timeZone={timeZone}
            onSnooze={onSnooze}
            open={snoozeMenuOpen}
            onOpenChange={setSnoozeMenuOpen}
          >
            <Button size="sm" variant="secondary">
              <AlarmClock className="size-4" aria-hidden /> Snooze
            </Button>
          </SnoozeMenu>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onAct('unread').then((ok) => ok && onBack())}
          aria-label="Mark unread"
        >
          <Mail className="size-4" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onAct(row.starred ? 'unstar' : 'star')}
          aria-label={row.starred ? 'Unstar' : 'Star'}
          aria-pressed={row.starred}
        >
          <Star
            className={cn('size-4', row.starred && 'fill-[var(--gold)] text-[var(--gold)]')}
            aria-hidden
          />
        </Button>
        {onLabel ? (
          <LabelMenu
            choices={labelChoices}
            current={[row.labelIds]}
            onChange={onLabel}
            open={labelMenuOpen}
            onOpenChange={setLabelMenuOpen}
          >
            <Button size="sm" variant="ghost" aria-label="Label">
              <Tag className="size-4" aria-hidden />
            </Button>
          </LabelMenu>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Forward"
          disabled={!thread}
          onClick={() => thread && onForward(forwardDraft(thread, timeZone))}
        >
          <Forward className="size-4" aria-hidden />
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a
            href={gmailUrl(row.id, mailbox)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in Gmail"
          >
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </Button>
      </header>

      <div className="space-y-3 p-4">
        <h2 className="text-lg font-semibold text-balance">{thread?.subject ?? row.subject}</h2>
        {snoozedUntil ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--fg-muted)]">
            <AlarmClock className="size-4 text-[var(--accent)]" aria-hidden />
            Snoozed until {formatWake(snoozedUntil, readerZone(timeZone))}
          </p>
        ) : null}
        {/* The row's labels, so a change made here shows at once. */}
        {row.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.labels.map((l) => (
              <Badge key={l} tone="neutral">
                {l}
              </Badge>
            ))}
          </div>
        ) : null}
        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
        {!thread && !error ? (
          <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Opening…
          </p>
        ) : null}
        {thread ? (
          <ol className="space-y-2">
            {thread.messages.map((m, i) => (
              <MessageItem
                key={m.id}
                message={m}
                timeZone={timeZone}
                startOpen={i === thread.messages.length - 1}
              />
            ))}
          </ol>
        ) : null}
        {thread ? (
          <ReplyBox
            threadId={row.id}
            canSend={canAct}
            mailbox={mailbox}
            open={replyOpen}
            setOpen={setReplyOpen}
            onSent={() => {
              setReloadKey((k) => k + 1);
              onSent();
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

interface DraftResponse {
  draft: { body: string } | null;
  draftError: string | null;
  canSend: boolean;
  signatures: { nick: string | null; arwin: string } | null;
}

function ReplyBox({
  threadId,
  canSend,
  mailbox,
  open,
  setOpen,
  onSent,
}: {
  threadId: string;
  canSend: boolean;
  mailbox: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onSent: () => void;
}) {
  const [loaded, setLoaded] = React.useState<DraftResponse | null>(null);
  const [body, setBody] = React.useState('');
  const [signature, setSignature] = React.useState<Signature>('nick');
  const [countdown, setCountdown] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const quietOpen = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/email-session/draft?id=${threadId}`)
      .then(async (r) => (r.ok ? ((await r.json()) as DraftResponse) : null))
      .then((d) => {
        if (cancelled || !d) return;
        setLoaded(d);
        if (d.draft?.body) {
          setBody(d.draft.body);
          // Shown, not focused: opening an email must not jump the page to the reply.
          quietOpen.current = true;
          setOpen(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [threadId, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    if (quietOpen.current) {
      quietOpen.current = false;
      return;
    }
    document.getElementById(`reply-${threadId}`)?.focus();
  }, [open, threadId]);

  const send = React.useCallback(async () => {
    setSending(true);
    const res = await postJson('/api/email-session/send', { id: threadId, body, signature });
    setSending(false);
    if (res.ok) {
      toast.success('Sent');
      setBody('');
      setOpen(false);
      onSent();
    } else {
      toast.error(await errorMessage(res, 'It did not send. Try again.'));
    }
  }, [threadId, body, signature, setOpen, onSent]);

  // The send fires from the last tick itself; the ref always holds the newest send.
  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const startSend = () => {
    if (!body.trim()) {
      toast.error('Write a reply first.');
      return;
    }
    if (!canSend) {
      window.open(gmailUrl(threadId, mailbox), '_blank', 'noopener');
      return;
    }
    if (signature === 'nick' && loaded && !loaded.signatures?.nick) {
      toast.error("Nick's signature couldn't be read from Gmail. Try again, or sign as Arwin.");
      return;
    }
    let left = UNDO_SECONDS;
    setCountdown(left);
    setPending(true);
    timer.current = window.setInterval(() => {
      left -= 1;
      setCountdown(left);
      if (left <= 0) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setPending(false);
        void sendRef.current();
      }
    }, 1000);
  };

  const undo = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setPending(false);
    setCountdown(0);
  };

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Reply className="size-4" aria-hidden /> Reply
      </Button>
    );
  }

  const waiting = pending;
  const sigText = loaded?.signatures?.[signature] ?? null;

  return (
    <div className="space-y-2 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Reply all</span>
        {loaded?.draft ? <Badge tone="ok">Draft from Gmail</Badge> : null}
        <div className="flex-1" />
        <span className="text-[var(--fg-muted)]">Sign as</span>
        {(['nick', 'arwin'] as Signature[]).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={signature === s ? 'primary' : 'secondary'}
            aria-pressed={signature === s}
            onClick={() => {
              setSignature(s);
              setBody((b) => swapSignOff(b, s));
            }}
          >
            {s === 'nick' ? 'Nick' : 'Arwin'}
          </Button>
        ))}
      </div>
      <label htmlFor={`reply-${threadId}`} className="sr-only">
        Reply
      </label>
      <Textarea
        id={`reply-${threadId}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        disabled={waiting || sending}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            startSend();
          }
        }}
      />
      {sigText ? (
        <p className="text-xs whitespace-pre-line text-[var(--fg-subtle)]">{sigText}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {waiting ? (
          <>
            <span className="text-sm text-[var(--fg-muted)]">Sending in {countdown}s…</span>
            <Button size="sm" variant="secondary" onClick={undo}>
              <Undo2 className="size-4" aria-hidden /> Undo
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={startSend} disabled={sending}>
              {sending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              {canSend ? 'Send' : 'Send in Gmail'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <span className="text-xs text-[var(--fg-subtle)]">Ctrl+Enter sends</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Gmail's forward: the newest message quoted under a header, its attachments carried along. */
export function forwardDraft(thread: LiveThread, timeZone: string): ComposeDraft {
  const last = thread.messages.at(-1)!;
  const header = [
    '---------- Forwarded message ---------',
    `From: ${last.from}`,
    `Date: ${longTime(last.at, timeZone)}`,
    `Subject: ${thread.subject}`,
    `To: ${last.to}`,
    last.cc ? `Cc: ${last.cc}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    to: '',
    subject: /^fwd?:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`,
    body: `\n\nNick\n\n${header}\n\n${last.text}`,
    forwardOf: last.attachments.length ? last.id : null,
    attachmentNames: last.attachments.map((a) => a.name),
  };
}
