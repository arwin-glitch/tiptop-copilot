'use client';

import * as React from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { opensInline } from '@/lib/email/attachment-types';
import { cn } from '@/lib/util/cn';
import type { LiveMessage } from '@/lib/services/inbox-live';

/**
 * One email message as plain text, for the Inbox's reading pane and the full
 * email on Follow-ups. The text arrives already flattened (text/plain, or the
 * HTML part stripped of script, style and tags) and renders as React text
 * nodes; links are http(s) only and open in a new tab without an opener; no
 * image ever loads.
 */

/** A message as Follow-ups shows it: `truncated` when its text was cut (follow-up-email.ts). */
export type ShownMessage = LiveMessage & { truncated?: boolean };

export const QUOTE_START = /^(On .+wrote:|-{2,} ?Forwarded message|From: .+)$/;

export function splitQuoted(text: string): { main: string; quoted: string } {
  const lines = text.split('\n');
  const at = lines.findIndex(
    (l, i) =>
      i > 0 && (QUOTE_START.test(l.trim()) || (l.startsWith('>') && lines[i + 1]?.startsWith('>'))),
  );
  if (at < 0) return { main: text, quoted: '' };
  return { main: lines.slice(0, at).join('\n').trimEnd(), quoted: lines.slice(at).join('\n') };
}

/**
 * Plain-text mail is often hard-wrapped at ~72 characters. Rejoin a long line
 * with the next one when the next starts mid-sentence (lowercase), so text
 * reads as paragraphs; blank lines and lists are left alone.
 */
export function reflow(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    if (prev !== undefined && prev.length >= 60 && /^[a-z(]/.test(line) && !/[.!?:]$/.test(prev)) {
      out[out.length - 1] = `${prev.trimEnd()} ${line}`;
    } else out.push(line);
  }
  return out.join('\n');
}

const URL_RE = /(https?:\/\/[^\s<>()"]+)/g;

export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-[var(--accent)] underline"
          >
            {part.length > 60 ? `${part.slice(0, 57)}…` : part}
          </a>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

const LONG_TIME: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * "Mon, Oct 19, 9:40 AM". In `timeZone` when one is given (Follow-ups passes
 * the profile's, so one thread never mixes two zones); without one, the
 * browser's own, as the Inbox has always shown it.
 */
export function longTime(iso: string | null, timeZone?: string): string {
  if (!iso) return '';
  if (!timeZone) return new Date(iso).toLocaleString([], LONG_TIME);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone, ...LONG_TIME }).format(d);
}

export function fileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Same rule as the Today briefing: only long text is clamped. */
export const isLongText = (text: string) => text.length > 320 || text.split('\n').length > 6;

export function MessageItem({
  message: m,
  startOpen,
  timeZone,
  clampLines,
}: {
  message: ShownMessage;
  startOpen: boolean;
  timeZone?: string;
  clampLines?: number;
}) {
  const [open, setOpen] = React.useState(startOpen);
  // Here, not in MessageBody: folding the message keeps the quoted text open.
  const [showQuoted, setShowQuoted] = React.useState(false);
  const { main } = React.useMemo(() => splitQuoted(reflow(m.text)), [m.text]);
  return (
    <li className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 px-3 py-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {m.fromName}
          {m.fromUs ? <span className="ml-1 text-xs text-[var(--fg-subtle)]">(you)</span> : null}
        </span>
        <span className="shrink-0 text-xs text-[var(--fg-muted)]">{longTime(m.at, timeZone)}</span>
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3">
          <MessageBody
            message={m}
            clampLines={clampLines}
            sender={clampLines ? m.fromName : undefined}
            showQuoted={showQuoted}
            onToggleQuoted={() => setShowQuoted((q) => !q)}
          />
        </div>
      ) : (
        <p className="truncate px-3 pb-2 text-xs text-[var(--fg-muted)]">{main.slice(0, 160)}</p>
      )}
    </li>
  );
}

/** Blank lines between paragraphs dropped, so a clamped preview is all text. */
export const compactLines = (text: string) => text.replace(/\n\s*\n/g, '\n');

/**
 * An open message: who it went to, the flagged notice, the text, its quoted
 * part behind a toggle, and its attachments. With `clampLines`, long text
 * shows that many lines behind "Show full email": a preview without the
 * blank lines between paragraphs (four lines of "Hi Priya," and gaps tell
 * nothing), its words all still in the DOM, only clamped, as on the Today
 * briefing. Long text whose preview fits anyway is shown whole, as written.
 * The To/Cc line is one line until then too (a long Cc list is a wall of
 * addresses), and the same button shows the rest of it.
 */
export function MessageBody({
  message: m,
  clampLines,
  showQuoted: quotedShown,
  onToggleQuoted,
  sender,
}: {
  message: ShownMessage;
  clampLines?: number;
  showQuoted?: boolean;
  onToggleQuoted?: () => void;
  /** An earlier message's sender: its button is then "Show full message", named for them. */
  sender?: string;
}) {
  const [ownQuoted, setOwnQuoted] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [fits, setFits] = React.useState(false);
  const [toOverflows, setToOverflows] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const toRef = React.useRef<HTMLParagraphElement>(null);
  const collapsing = React.useRef(false);
  const bodyId = React.useId();
  const toId = React.useId();
  const { main, quoted } = React.useMemo(() => splitQuoted(reflow(m.text)), [m.text]);
  const showQuoted = quotedShown ?? ownQuoted;
  const toggleQuoted = onToggleQuoted ?? (() => setOwnQuoted((q) => !q));
  // Long text that still fits in the lines (one long paragraph on a wide
  // screen) gets no clamp and no button that does nothing.
  const clampable = Boolean(clampLines) && isLongText(main) && !fits;
  const clamped = clampable && !expanded;
  const foldTo = Boolean(clampLines) && !expanded;
  const recipients = `To ${m.to || '(hidden)'}${m.cc ? ` · Cc ${m.cc}` : ''}`;
  const toggle = clampable || toOverflows;

  React.useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!clamped || !el) return;
    const measure = () => {
      if (el.scrollHeight <= el.clientHeight + 1) setFits(true);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamped, main]);

  // A To/Cc line cut short needs the button even when the text is short.
  React.useLayoutEffect(() => {
    const el = toRef.current;
    if (!foldTo || !el) return;
    const measure = () => setToOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [foldTo, recipients]);

  // "Show less" from far down a long email: bring its start back into view.
  React.useLayoutEffect(() => {
    if (expanded || !collapsing.current) return;
    collapsing.current = false;
    (clampable ? bodyRef : toRef).current?.scrollIntoView({ block: 'nearest' });
  }, [expanded, clampable]);

  const more = sender ? 'Show full message' : 'Show full email';
  return (
    <>
      <p
        ref={toRef}
        id={toggle && !clampable ? toId : undefined}
        title={foldTo && toOverflows ? recipients : undefined}
        className={cn('text-xs text-[var(--fg-subtle)]', foldTo ? 'truncate' : 'break-words')}
      >
        {recipients}
      </p>
      {m.flagged ? (
        <Notice tone="warn">
          <p className="font-medium">This message contains text aimed at an AI assistant.</p>
          <p className="mt-1 text-[var(--fg-muted)]">
            It was treated as data, not instructions. Nothing in it was acted on. The full text is
            shown below so you can see exactly what was attempted.
          </p>
        </Notice>
      ) : null}
      <div
        ref={bodyRef}
        id={clampable ? bodyId : undefined}
        className="text-sm leading-relaxed break-words whitespace-pre-wrap"
        style={
          clamped
            ? {
                display: '-webkit-box',
                WebkitLineClamp: clampLines,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
            : undefined
        }
      >
        <Linkified text={(clamped ? compactLines(main) : main) || '(no text)'} />
      </div>
      {quoted && !clamped ? (
        <div>
          {clampLines ? (
            // Follow-ups: the same kind of control as the others around it.
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2.5"
              aria-expanded={showQuoted}
              onClick={toggleQuoted}
            >
              {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
            </Button>
          ) : (
            <button
              type="button"
              onClick={toggleQuoted}
              className="text-xs text-[var(--fg-muted)] underline"
            >
              {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
            </button>
          )}
          {showQuoted ? (
            <div className="mt-1 border-l-2 border-[var(--border)] pl-3 text-xs break-words whitespace-pre-wrap text-[var(--fg-muted)]">
              <Linkified text={quoted} />
            </div>
          ) : null}
        </div>
      ) : null}
      {m.truncated && !clamped ? (
        <p className="text-xs text-[var(--fg-subtle)]">
          This email is long; the rest of it is in Gmail.
        </p>
      ) : null}
      {toggle ? (
        // After the quoted text, so all of the message it opens sits above it.
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          aria-expanded={expanded}
          aria-controls={clampable ? bodyId : toId}
          aria-label={
            sender ? `${expanded ? 'Show less of the message' : more} from ${sender}` : undefined
          }
          onClick={() => {
            collapsing.current = expanded;
            setExpanded((v) => !v);
          }}
        >
          {expanded ? 'Show less' : more}
        </Button>
      ) : null}
      {m.attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {m.attachments.map((a, i) =>
            a.id ? (
              <a
                key={`${a.id}|${a.name}|${i}`}
                href={`/api/inbox/attachment?${new URLSearchParams({
                  m: m.id,
                  a: a.id,
                  name: a.name,
                  type: a.mimeType,
                }).toString()}`}
                // A file the browser can show opens in a new tab; anything
                // else downloads in place, so a half-written reply stays put
                // and the desktop app leaves no blank window behind.
                {...(opensInline(a.mimeType)
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : { download: a.name })}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
              >
                <Paperclip className="size-3" aria-hidden /> {a.name}
                <span className="text-[var(--fg-subtle)]">{fileSize(a.size)}</span>
              </a>
            ) : (
              // The demo's attachments have no id: nothing to fetch.
              <span
                key={`${a.name}|${i}`}
                title="Attachments open only on the real mailbox."
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs"
              >
                <Paperclip className="size-3" aria-hidden /> {a.name}
                <span className="text-[var(--fg-subtle)]">{fileSize(a.size)}</span>
              </span>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
