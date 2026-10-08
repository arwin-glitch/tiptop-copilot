'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Archive,
  Check,
  Clock,
  Copy,
  ExternalLink,
  MessageSquare,
  Send,
  SkipForward,
  Undo2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import type { SessionAnswerKind, SessionItem } from '@/lib/services/email-session';

type Signature = 'nick' | 'arwin';
type Budget = '10' | '25' | 'all';

interface LiveDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  draftId: string | null;
}

interface DraftResponse {
  draft: LiveDraft | null;
  draftError: string | null;
  canSend: boolean;
  signatures: { nick: string | null; arwin: string } | null;
}

const GROUP_LABEL: Record<SessionItem['group'], string> = {
  today: 'Today only',
  money: 'Money, legal and tax',
  deals: 'Deal waiting on you',
  owed: 'Promise you made',
  intros: 'Intro offer',
  waiting: 'Waiting on you',
  replies: 'Friendly reply',
  archive: 'To archive',
};

const UNDO_SECONDS = 8;
const BUDGET_KEY = 'email-session-budget';

const gmailUrl = (id: string, mailbox: string) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${id}`;

/** Swap the sign-off name on the last non-empty line ("Nick" <-> "Arwin"). */
export function swapSignOff(body: string, to: Signature): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (/^(Nick|Arwin)$/i.test(line)) lines[i] = to === 'nick' ? 'Nick' : 'Arwin';
    break;
  }
  return lines.join('\n');
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function EmailSessionClient({
  items,
  canSend,
  mailbox,
  isDemo,
}: {
  items: SessionItem[];
  canSend: boolean;
  mailbox: string;
  isDemo: boolean;
}) {
  // Local answers on top of the server's, so the queue moves instantly.
  const [local, setLocal] = React.useState<Record<string, SessionAnswerKind>>({});
  const [budget, setBudget] = React.useState<Budget>(() => {
    try {
      const v = typeof window === 'undefined' ? null : window.localStorage.getItem(BUDGET_KEY);
      return v === '10' || v === '25' || v === 'all' ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const answerOf = React.useCallback(
    (i: SessionItem): SessionAnswerKind | null => local[i.id] ?? i.answer?.answer ?? null,
    [local],
  );
  const settled = React.useCallback(
    (i: SessionItem) => {
      const a = answerOf(i);
      return Boolean(a && a !== 'later' && a !== 'stop');
    },
    [answerOf],
  );
  const forNick = (i: SessionItem) => i.needsNick || answerOf(i) === 'stop';

  const nickItems = items.filter(forNick);
  const open = nickItems.filter((i) => !settled(i));
  const ordered = [
    ...open.filter((i) => answerOf(i) !== 'later'),
    ...open.filter((i) => answerOf(i) === 'later'),
  ];
  const limit = budget === 'all' ? Infinity : Number(budget);
  let used = 0;
  const queue = ordered.filter((i) => {
    if (used >= limit) return false;
    used += i.minutes;
    return true;
  });
  const current = queue[0] ?? null;
  const minutesLeft = Math.round(open.reduce((t, i) => t + i.minutes, 0));
  const doneCount = nickItems.length - open.length;

  const answer = React.useCallback(
    async (id: string, kind: SessionAnswerKind, extra: Record<string, unknown> = {}) => {
      setLocal((s) => ({ ...s, [id]: kind }));
      const res = await postJson('/api/email-session/answer', { id, answer: kind, ...extra });
      if (!res.ok) {
        setLocal((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        });
        toast.error('That did not save. Try again.');
      }
    },
    [],
  );

  const chooseBudget = (b: Budget) => {
    setBudget(b);
    try {
      window.localStorage.setItem(BUDGET_KEY, b);
    } catch {
      // Private window: the choice just isn't remembered.
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
            <div
              className="h-full rounded-full bg-[var(--ok)] transition-all"
              style={{ width: `${nickItems.length ? (doneCount / nickItems.length) * 100 : 100}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            {doneCount} of {nickItems.length} done · about {minutesLeft} min left
          </p>
        </div>
        <div className="flex items-center gap-1 text-sm" role="group" aria-label="Time you have">
          <Clock className="size-4 text-[var(--fg-muted)]" aria-hidden />
          <span className="mr-1 text-[var(--fg-muted)]">I have</span>
          {(['10', '25', 'all'] as Budget[]).map((b) => (
            <Button
              key={b}
              size="sm"
              variant={budget === b ? 'primary' : 'secondary'}
              aria-pressed={budget === b}
              onClick={() => chooseBudget(b)}
            >
              {b === 'all' ? 'All' : `${b} min`}
            </Button>
          ))}
        </div>
      </div>

      {!canSend ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-sm text-[var(--fg-muted)]">
          {isDemo
            ? 'Demo: Send opens the email in Gmail instead of sending.'
            : 'Sending from the app is not turned on yet, so Send opens the email in Gmail. Nick can turn it on in Settings › Integrations.'}
        </p>
      ) : null}

      {current ? (
        <SessionCard
          key={current.id}
          item={current}
          position={doneCount + 1}
          total={nickItems.length}
          canSend={canSend}
          mailbox={mailbox}
          onAnswer={answer}
        />
      ) : (
        <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-6 text-center">
          <Check className="mx-auto size-8 text-[var(--ok)]" aria-hidden />
          <p className="mt-2 font-semibold">
            {open.length ? 'That fills your time.' : 'You are through everything that needs you.'}
          </p>
          <p className="text-sm text-[var(--fg-muted)]">
            {open.length
              ? `${open.length} left for next time. Pick “All” to keep going.`
              : 'Arwin takes it from here.'}
          </p>
        </div>
      )}

      <ArwinPile items={items.filter((i) => !forNick(i))} answerOf={answerOf} onAnswer={answer} />
      <ForArwin items={items} answerOf={answerOf} localAnswers={local} onAnswer={answer} />
    </div>
  );
}

function SessionCard({
  item,
  position,
  total,
  canSend,
  mailbox,
  onAnswer,
}: {
  item: SessionItem;
  position: number;
  total: number;
  canSend: boolean;
  mailbox: string;
  onAnswer: (id: string, kind: SessionAnswerKind, extra?: Record<string, unknown>) => Promise<void>;
}) {
  const [loaded, setLoaded] = React.useState<DraftResponse | null>(null);
  const [body, setBody] = React.useState('');
  const [signature, setSignature] = React.useState<Signature>('nick');
  const [mode, setMode] = React.useState<'idle' | 'note' | 'gmail' | 'sending'>('idle');
  const [note, setNote] = React.useState('');
  const [countdown, setCountdown] = React.useState(0);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/email-session/draft?id=${item.id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as DraftResponse;
      })
      .then((d) => {
        if (cancelled) return;
        setLoaded(d);
        if (d.draft?.body) setBody(d.draft.body);
      })
      .catch(() => {
        if (!cancelled)
          setLoaded({
            draft: null,
            draftError: 'Could not load the draft here. Open it in Gmail, or tell Arwin.',
            canSend,
            signatures: null,
          });
      });
    return () => {
      cancelled = true;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [item.id, canSend]);

  const pickSignature = (s: Signature) => {
    setSignature(s);
    setBody((b) => swapSignOff(b, s));
  };

  const reallySend = React.useCallback(async () => {
    const res = await postJson('/api/email-session/send', { id: item.id, body, signature });
    if (res.ok) {
      toast.success(`Sent to ${item.who}`);
      await onAnswer(item.id, 'sent', { signature, viaApp: true }).catch(() => undefined);
    } else {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      toast.error(j?.error?.message ?? 'It did not send. Try again.');
      setMode('idle');
    }
  }, [item.id, item.who, body, signature, onAnswer]);

  const startSend = React.useCallback(() => {
    if (!body.trim()) {
      toast.error('Write a reply first, or tell Arwin what to say.');
      return;
    }
    if (!canSend) {
      window.open(gmailUrl(item.id, mailbox), '_blank', 'noopener');
      setMode('gmail');
      return;
    }
    setMode('sending');
    setCountdown(UNDO_SECONDS);
    timer.current = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          if (timer.current) window.clearInterval(timer.current);
          timer.current = null;
          void reallySend();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, [body, canSend, item.id, mailbox, reallySend]);

  const undo = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setMode('idle');
    setCountdown(0);
  };

  const archive = async () => {
    const res = await postJson('/api/email-session/archive', { ids: [item.id] });
    if (!res.ok) {
      toast.error('Could not archive. Try again.');
      return;
    }
    toast.success(canSend ? 'Archived' : 'Marked for Arwin to archive');
    // The archive route records the answer itself; mirror it locally.
    await onAnswer(item.id, 'archive').catch(() => undefined);
  };

  // Keyboard on a computer: Ctrl/Cmd+Enter send, E archive, L later, P pass.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('textarea, input');
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'idle') startSend();
        return;
      }
      if (typing || mode !== 'idle' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'e') void archive();
      if (e.key === 'l') void onAnswer(item.id, 'later');
      if (e.key === 'p') void onAnswer(item.id, 'pass');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const draft = loaded?.draft ?? null;
  const signatureText = loaded?.signatures?.[signature] ?? null;

  return (
    <article
      aria-label={`Email from ${item.who}`}
      className="space-y-4 rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.group === 'today' || item.group === 'money' ? 'danger' : 'info'}>
          {GROUP_LABEL[item.group]}
        </Badge>
        {item.flags.map((f) => (
          <Badge key={f} tone="outline">
            {f}
          </Badge>
        ))}
        {item.context.map((c) => (
          <Link key={c.href + c.label} href={c.href} className="text-xs">
            <Badge tone={c.kind === 'risk' ? 'warn' : 'ok'}>{c.label}</Badge>
          </Link>
        ))}
        <span className="ml-auto text-xs text-[var(--fg-subtle)]">
          {position} of {total}
        </span>
      </div>

      <div>
        <h2 className="text-lg font-semibold">{item.who}</h2>
        <p className="text-[var(--fg-muted)]">{item.about}</p>
        {item.why ? <p className="mt-1 text-sm">{item.why}</p> : null}
        {item.waitingDays !== null ? (
          <p className="mt-1 text-xs text-[var(--fg-subtle)]">Waiting {item.waitingDays} days</p>
        ) : null}
      </div>

      <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-muted)]">
          <span className="min-w-0 flex-1 truncate">
            {draft
              ? `To ${draft.to}${draft.cc ? ` · Cc ${draft.cc}` : ''}`
              : loaded
                ? ''
                : 'Loading the draft…'}
          </span>
          <span role="group" aria-label="Signature" className="flex items-center gap-1">
            <span>Sign as</span>
            {(['nick', 'arwin'] as Signature[]).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={signature === s}
                onClick={() => pickSignature(s)}
                className={cn(
                  'rounded-md border px-2 py-0.5',
                  signature === s
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'border-[var(--border)]',
                )}
              >
                {s === 'nick' ? 'Nick' : 'Arwin'}
              </button>
            ))}
          </span>
        </div>
        <Textarea
          aria-label="Reply"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={Math.min(14, Math.max(6, body.split('\n').length + 1))}
          placeholder={
            loaded && !draft?.body
              ? item.draft === 'yours'
                ? 'This one needs your words. Write a reply, or tell Arwin what to say.'
                : 'No draft on this thread. Write a reply, or tell Arwin what to say.'
              : ''
          }
        />
        {signatureText ? (
          <p className="border-t border-[var(--border)] pt-2 text-xs whitespace-pre-line text-[var(--fg-muted)]">
            {signatureText}
          </p>
        ) : signature === 'nick' && loaded ? (
          <p className="border-t border-[var(--border)] pt-2 text-xs text-[var(--fg-subtle)]">
            Nick&apos;s Gmail signature is added when it sends.
          </p>
        ) : null}
        {loaded?.draftError ? (
          <p className="text-xs text-[var(--warn)]">{loaded.draftError}</p>
        ) : null}
      </div>

      {mode === 'sending' ? (
        <div className="flex items-center gap-3 rounded-md bg-[var(--bg-hover)] px-3 py-2 text-sm">
          <Send className="size-4" aria-hidden /> Sending in {countdown}s
          <Button size="sm" className="ml-auto" onClick={undo}>
            <Undo2 aria-hidden /> Undo
          </Button>
        </div>
      ) : mode === 'gmail' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-[var(--bg-hover)] px-3 py-2 text-sm">
          <span className="flex-1">
            Gmail opened on this thread. Send it there, then come back.
          </span>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(body).catch(() => undefined);
              toast.success('Reply copied');
            }}
          >
            <Copy aria-hidden /> Copy my edits
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void onAnswer(item.id, 'sent', { signature })}
          >
            <Check aria-hidden /> I sent it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
            Back
          </Button>
        </div>
      ) : mode === 'note' ? (
        <div className="space-y-2">
          <Textarea
            aria-label="Note for Arwin"
            autoFocus
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tell Arwin what to say, e.g. “Say yes, Tuesday works”"
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                if (!note.trim()) {
                  toast.error('Write a note for Arwin first.');
                  return;
                }
                void onAnswer(item.id, 'note', { note: note.trim() });
              }}
            >
              <MessageSquare aria-hidden /> Send to Arwin
            </Button>
            <Button variant="ghost" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={startSend}>
            {canSend ? <Send aria-hidden /> : <ExternalLink aria-hidden />}
            {canSend ? 'Send' : 'Send in Gmail'}
          </Button>
          <Button onClick={() => setMode('note')}>
            <MessageSquare aria-hidden /> Tell Arwin
          </Button>
          <Button onClick={() => void onAnswer(item.id, 'pass')}>
            <X aria-hidden /> No reply needed
          </Button>
          <Button onClick={() => void archive()}>
            <Archive aria-hidden /> Archive
          </Button>
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => void onAnswer(item.id, 'later')}
          >
            <SkipForward aria-hidden /> Later
          </Button>
        </div>
      )}
      <p className="hidden text-xs text-[var(--fg-subtle)] sm:block">
        Keys: Ctrl+Enter send · E archive · P no reply needed · L later
      </p>
    </article>
  );
}

function ArwinPile({
  items,
  answerOf,
  onAnswer,
}: {
  items: SessionItem[];
  answerOf: (i: SessionItem) => SessionAnswerKind | null;
  onAnswer: (id: string, kind: SessionAnswerKind, extra?: Record<string, unknown>) => Promise<void>;
}) {
  const open = items.filter((i) => !answerOf(i) || answerOf(i) === 'later');
  if (!items.length) return null;
  const replies = open.filter((i) => i.group === 'replies');
  const archive = open.filter((i) => i.group === 'archive');
  const archiveAll = async () => {
    if (!archive.length) return;
    const res = await postJson('/api/email-session/archive', { ids: archive.map((i) => i.id) });
    if (!res.ok) {
      toast.error('Could not archive. Try again.');
      return;
    }
    const j = (await res.json()) as { archived: number; markedForArwin: number };
    toast.success(
      j.archived ? `Archived ${j.archived}` : `${j.markedForArwin} marked for Arwin to archive`,
    );
    for (const i of archive) await onAnswer(i.id, 'archive').catch(() => undefined);
  };
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      <summary className="cursor-pointer list-none p-4">
        <span className="font-semibold">Arwin handles these</span>
        <span className="ml-2 text-sm text-[var(--fg-muted)]">
          {replies.length} friendly {replies.length === 1 ? 'reply' : 'replies'} · {archive.length}{' '}
          to archive · unless you say otherwise
        </span>
      </summary>
      <div className="space-y-3 border-t border-[var(--border)] p-4">
        {archive.length ? (
          <Button size="sm" onClick={() => void archiveAll()}>
            <Archive aria-hidden /> Archive all {archive.length}
          </Button>
        ) : null}
        <ul className="divide-y divide-[var(--border)]">
          {[...replies, ...archive].map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{i.who}</span>{' '}
                <span className="text-[var(--fg-muted)]">· {i.about}</span>
              </span>
              <Badge tone="outline">{i.group === 'archive' ? 'Archive' : 'Reply'}</Badge>
              <Button size="sm" variant="ghost" onClick={() => void onAnswer(i.id, 'stop')}>
                I&apos;ll handle it
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** What Arwin has to do because of Nick's answers: notes to act on and archives to do in Gmail. */
function ForArwin({
  items,
  answerOf,
  localAnswers,
  onAnswer,
}: {
  items: SessionItem[];
  answerOf: (i: SessionItem) => SessionAnswerKind | null;
  localAnswers: Record<string, SessionAnswerKind>;
  onAnswer: (id: string, kind: SessionAnswerKind, extra?: Record<string, unknown>) => Promise<void>;
}) {
  const todo = items.filter((i) => {
    const a = answerOf(i);
    if (a === 'note') return true;
    // An archive Nick asked for that the app could not do itself.
    return (
      a === 'archive' && !localAnswers[i.id] && i.answer?.answer === 'archive' && !i.answer.viaApp
    );
  });
  if (!todo.length) return null;
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-4">
      <h2 className="font-semibold">For Arwin</h2>
      <p className="text-sm text-[var(--fg-muted)]">
        From the answers so far. Tick each one off when it is done.
      </p>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {todo.map((i) => (
          <li key={i.id} className="flex items-start gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{i.who}</span>{' '}
              <span className="text-[var(--fg-muted)]">· {i.about}</span>
              <span className="block">
                {answerOf(i) === 'note'
                  ? `${i.answer?.by ?? 'Nick'}: “${i.answer?.note ?? 'see the note'}”`
                  : 'Archive in Gmail'}
              </span>
            </span>
            <Button size="sm" onClick={() => void onAnswer(i.id, 'done')}>
              <Check aria-hidden /> Done
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
