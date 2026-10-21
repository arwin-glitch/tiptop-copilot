'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Paperclip, Send, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/form';
import { Notice } from '@/components/ui/feedback';
import { swapSignOff } from '@/components/followups/email-session-client';
import { parseAddresses } from '@/lib/email/addresses';
import { lineWithLinksToHtml, textWithLinks } from '@/lib/email/name-links';

type Signature = 'nick' | 'arwin';

export interface ComposeDraft {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Message whose attachments go along (a forward). */
  forwardOf?: string | null;
  attachmentNames?: string[];
  /** Names written [Full Name](LinkedIn URL) go out as links (the intro draft). */
  links?: boolean;
  /** Plain sentences to read before sending: a missing address, an unlinked name. */
  hints?: string[];
}

const UNDO_SECONDS = 8;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The email as Gmail-pasteable HTML: headers, then the body with its LinkedIn names linked. */
function copyHtml(head: string, body: string): string {
  const lines = [
    ...head.split('\n').map(escapeHtml),
    '',
    ...body.split('\n').map(lineWithLinksToHtml),
  ];
  return lines.map((l) => (l.trim() ? `<div>${l}</div>` : '<div><br></div>')).join('');
}

/**
 * A Gmail-style compose window: new email, forward, or a prefilled follow-up.
 * Send goes from Nick's inbox through /api/inbox/compose, with 8 seconds to
 * undo. Without the sending grant it offers Copy instead, never a hidden send.
 */
export function Composer({
  title,
  initial,
  canSend,
  onClose,
  onSent,
}: {
  title: string;
  initial: ComposeDraft;
  canSend: boolean;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [to, setTo] = React.useState(initial.to);
  const [cc, setCc] = React.useState(initial.cc ?? '');
  const [showCc, setShowCc] = React.useState(Boolean(initial.cc));
  const [subject, setSubject] = React.useState(initial.subject);
  const [body, setBody] = React.useState(initial.body);
  const [signature, setSignature] = React.useState<Signature>('nick');
  const [countdown, setCountdown] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const uid = React.useId();

  const send = React.useCallback(async () => {
    setSending(true);
    const res = await fetch('/api/inbox/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        cc,
        subject,
        body,
        signature,
        forwardOf: initial.forwardOf,
        links: Boolean(initial.links),
      }),
    });
    setSending(false);
    if (res.ok) {
      toast.success('Sent');
      onSent?.();
      onClose();
    } else {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      toast.error(j?.error?.message ?? 'It did not send. Try again.');
    }
  }, [to, cc, subject, body, signature, initial.forwardOf, initial.links, onSent, onClose]);

  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);
  React.useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const startSend = () => {
    const toList = parseAddresses(to);
    if (!toList || toList.length === 0) {
      toast.error('Check the To addresses.');
      return;
    }
    if (!parseAddresses(cc)) {
      toast.error('Check the Cc addresses.');
      return;
    }
    if (!body.trim()) {
      toast.error('Write the email first.');
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

  const copy = async () => {
    const head = `To: ${to}\n${cc ? `Cc: ${cc}\n` : ''}Subject: ${subject}`;
    try {
      if (initial.links) {
        // Plain text names the links; the HTML copy pastes into Gmail with them.
        const text = `${head}\n\n${textWithLinks(body)}`;
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([copyHtml(head, body)], { type: 'text/html' }),
            }),
          ]);
        } else {
          await navigator.clipboard.writeText(text);
        }
      } else {
        await navigator.clipboard.writeText(`${head}\n\n${body}`);
      }
      toast.success('Copied. Paste it into Gmail.');
    } catch {
      toast.error('Could not copy. Select the text and copy it.');
    }
  };

  const busy = pending || sending;

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-x-0 bottom-0 z-[var(--z-header)] flex max-h-[92dvh] flex-col rounded-t-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] shadow-2xl sm:right-6 sm:left-auto sm:w-[560px]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          disabled={busy}
          className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="space-y-2 overflow-y-auto p-3">
        {initial.hints?.length ? (
          <Notice tone="warn">
            <ul aria-label="Before you send" className="space-y-1 text-xs">
              {initial.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div className="flex items-center gap-2">
          <label htmlFor={`${uid}-to`} className="w-12 text-sm text-[var(--fg-muted)]">
            To
          </label>
          <Input
            id={`${uid}-to`}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={busy}
            placeholder="name@company.com, another@company.com"
            className="flex-1"
          />
          {!showCc ? (
            <Button size="sm" variant="ghost" onClick={() => setShowCc(true)}>
              Cc
            </Button>
          ) : null}
        </div>
        {showCc ? (
          <div className="flex items-center gap-2">
            <label htmlFor={`${uid}-cc`} className="w-12 text-sm text-[var(--fg-muted)]">
              Cc
            </label>
            <Input
              id={`${uid}-cc`}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              disabled={busy}
              className="flex-1"
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <label htmlFor={`${uid}-subject`} className="w-12 text-sm text-[var(--fg-muted)]">
            Subject
          </label>
          <Input
            id={`${uid}-subject`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={busy}
            className="flex-1"
          />
        </div>
        <label htmlFor={`${uid}-body`} className="sr-only">
          Message
        </label>
        <Textarea
          id={`${uid}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          disabled={busy}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSend) {
              e.preventDefault();
              startSend();
            }
          }}
        />
        {initial.links ? (
          <p className="text-xs text-[var(--fg-subtle)]">
            A name written [Full Name](LinkedIn link) goes out linked to that profile.
          </p>
        ) : null}
        {initial.attachmentNames?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {initial.attachmentNames.map((a) => (
              <span
                key={a}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs"
              >
                <Paperclip className="size-3" aria-hidden /> {a}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--fg-muted)]">Sign as</span>
          {(['nick', 'arwin'] as Signature[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={signature === s ? 'primary' : 'secondary'}
              aria-pressed={signature === s}
              disabled={busy}
              onClick={() => {
                setSignature(s);
                setBody((b) => swapSignOff(b, s));
              }}
            >
              {s === 'nick' ? 'Nick' : 'Arwin'}
            </Button>
          ))}
          <span className="text-xs text-[var(--fg-subtle)]">
            Their real Gmail signature is added.
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        {!canSend ? (
          <>
            <Button size="sm" onClick={copy}>
              <Copy className="size-4" aria-hidden /> Copy for Gmail
            </Button>
            <span className="text-xs text-[var(--fg-muted)]">
              Sending from the app isn&apos;t turned on.
            </span>
          </>
        ) : pending ? (
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
              Send
            </Button>
            <span className="text-xs text-[var(--fg-subtle)]">Ctrl+Enter sends · 8s to undo</span>
          </>
        )}
      </div>
    </div>
  );
}
