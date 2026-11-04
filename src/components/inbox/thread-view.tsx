'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  Ban,
  Bookmark,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FileCode,
  FileImage,
  FileText,
  Filter,
  FolderInput,
  Forward,
  Inbox as InboxIcon,
  Loader2,
  ListTodo,
  Languages,
  Mail,
  MoreVertical,
  OctagonAlert,
  Paperclip,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { ComposeForm, type ComposeEnv, type ComposeSeed } from '@/components/inbox/compose-window';
import type { ComposeDraft } from '@/components/inbox/composer';
import { LabelMenu } from '@/components/inbox/label-menu';
import { originalHref, ShowOriginalDialog } from '@/components/inbox/show-original';
import { SuggestedReplies } from '@/components/inbox/suggested-replies';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { PdfPreview } from '@/components/inbox/pdf-preview';
import { MenuButton, MoveMenu, type MenuItem } from '@/components/inbox/inbox-menus';
import {
  MessageBody,
  fileSize,
  longTime,
  reflow,
  splitQuoted,
} from '@/components/inbox/message-view';
import { readerZone, SnoozeMenu } from '@/components/inbox/snooze-menu';
import { opensInline } from '@/lib/email/attachment-types';
import { textToComposeHtml } from '@/lib/email/compose-html';
import { emlFileName } from '@/lib/email/raw-message';
import { looksEnglish } from '@/lib/email/language';
import {
  eventPrefill,
  PREFILL_PARAM,
  PREFILL_VALUE,
  storePrefill,
} from '@/lib/calendar/inbox-prefill';
import { unsubscribeHow } from '@/lib/email/unsubscribe';
import type { LabelChange, MailLabel } from '@/lib/email/inbox-actions';
import { initialOf, type FolderId } from '@/lib/email/inbox-folders';
import type { SystemAction } from '@/lib/email/inbox-modify';
import { formatWake } from '@/lib/email/snooze';
import { cn } from '@/lib/util/cn';
import { colorsByName } from '@/lib/email/label-tree';
import { LabelChip } from '@/components/inbox/label-chip';
import type { LiveMessage, LiveThread, LiveThreadRow } from '@/lib/services/inbox-live';

export type WriteKind = 'reply' | 'replyAll' | 'forward';

/**
 * What the conversation offers about a message's sender, each only from a
 * person's click (Block and Report phishing ask once more first). Null when
 * not offered here.
 */
export interface SenderActions {
  /** "Filter messages like these": Create filter, from that sender. */
  onFilterLike: ((message: LiveMessage) => void) | null;
  /** Gmail's "Block": a filter (skip inbox, mark read, "Blocked" label), after a confirm. */
  onBlock: ((message: LiveMessage) => void) | null;
  /** "Report phishing": Gmail's API has none, so it is reported as spam, after a confirm. */
  onPhishing: (() => void) | null;
  /** Gmail's "Unsubscribe" by the sender: one-click or a prefilled email, after a confirm. */
  onUnsubscribe: ((message: LiveMessage) => void) | null;
}

export const NO_SENDER_ACTIONS: SenderActions = {
  onFilterLike: null,
  onBlock: null,
  onPhishing: null,
  onUnsubscribe: null,
};

export const gmailUrl = (id: string, mailbox: string | null) =>
  mailbox
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${id}`
    : `https://mail.google.com/mail/#all/${id}`;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

const ICON_BTN =
  'inline-grid size-9 place-items-center rounded-full text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:opacity-40';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Jane Doe <jane@x.com>" -> "jane@x.com". */
function addressOf(value: string): string {
  return (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function nameOf(value: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(value)?.[1]?.trim();
  if (named) return named;
  return addressOf(value).split('@')[0] ?? value;
}

/** Gmail's "to me, Sam" line: the mailbox reads as "me". */
function toLine(m: LiveMessage, mailbox: string | null): string {
  const own = (mailbox ?? '').toLowerCase();
  const names = [...splitList(m.to), ...splitList(m.cc)].map((r) =>
    own && addressOf(r) === own ? 'me' : nameOf(r),
  );
  return names.length ? names.join(', ') : 'undisclosed recipients';
}

/** "(2 hours ago)" for the message header, like Gmail's. */
function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '(just now)';
  if (m < 60) return `(${m} minute${m === 1 ? '' : 's'} ago)`;
  const h = Math.round(m / 60);
  if (h < 24) return `(${h} hour${h === 1 ? '' : 's'} ago)`;
  const d = Math.round(h / 24);
  return d <= 30 ? `(${d} day${d === 1 ? '' : 's'} ago)` : '';
}

/** Gmail's reply headers and recipients for one message. */
export function replySeed(
  kind: WriteKind,
  thread: LiveThread,
  message: LiveMessage,
  mailbox: string | null,
  timeZone: string,
): ComposeSeed {
  const own = (mailbox ?? '').toLowerCase();
  const isOwn = (r: string) => Boolean(own) && addressOf(r) === own;
  const subject = thread.subject;
  if (kind === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${message.from}`,
      `Date: ${longTime(message.at, timeZone)}`,
      `Subject: ${subject}`,
      `To: ${message.to}`,
      message.cc ? `Cc: ${message.cc}` : '',
    ].filter(Boolean);
    return {
      key: `fwd-${message.id}-${Date.now()}`,
      mode: 'forward',
      to: '',
      cc: '',
      bcc: '',
      subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
      html: `<div><br></div>${textToComposeHtml([...header, '', message.text].join('\n'))}`,
      forwardOf: message.attachments.length ? message.id : null,
      forwardNames: message.attachments.map((a) => a.name),
    };
  }
  // Answering our own message goes to whoever it went to, as in Gmail.
  const to = message.fromUs ? splitList(message.to) : [message.from];
  const cc =
    kind === 'replyAll'
      ? [...(message.fromUs ? [] : splitList(message.to)), ...splitList(message.cc)].filter(
          (r) => !isOwn(r) && !to.some((t) => addressOf(t) === addressOf(r)),
        )
      : [];
  return {
    key: `${kind}-${message.id}-${Date.now()}`,
    mode: kind,
    to: to.join(', '),
    cc: [...new Set(cc)].join(', '),
    bcc: '',
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    html: '',
    threadId: thread.id,
  };
}

/**
 * Gmail's "Add to Tasks", as a Kraken task linked to the conversation: from
 * the person's click only, and it changes nothing in Gmail.
 */
async function addToTasks(threadId: string, onView: () => void): Promise<void> {
  try {
    const res = await fetch('/api/inbox/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId }),
    });
    if (!res.ok) {
      toast.error(await errorMessage(res, 'Could not add it to Tasks. Try again.'));
      return;
    }
    toast.success('Added to Tasks', {
      action: { label: 'View', onClick: onView },
    });
  } catch {
    toast.error('Could not reach Kraken. Try again.');
  }
}

/** Gmail's "Forward as attachment": a new email with the message attached whole. */
export function attachedSeed(thread: LiveThread, message: LiveMessage): ComposeSeed {
  const subject = thread.subject;
  return {
    key: `fwda-${message.id}-${Date.now()}`,
    mode: 'forward',
    to: '',
    cc: '',
    bcc: '',
    subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
    html: '',
    attachMessage: { threadId: thread.id, messageId: message.id, name: emlFileName(subject) },
  };
}

/** The conversation (or one message of it) in a new window, ready to print. Text only. */
function printMessages(subject: string, messages: LiveMessage[], timeZone: string): void {
  const w = window.open('', '_blank', 'noopener=no,width=800,height=900');
  if (!w) return;
  const body = messages
    .map(
      (m) =>
        `<section><p class="h"><b>${escapeHtml(m.fromName)}</b> &lt;${escapeHtml(
          addressOf(m.from),
        )}&gt;<span>${escapeHtml(longTime(m.at, timeZone))}</span></p><p class="t">To: ${escapeHtml(
          m.to,
        )}${m.cc ? `<br>Cc: ${escapeHtml(m.cc)}` : ''}</p><pre>${escapeHtml(m.text)}</pre></section>`,
    )
    .join('');
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px}section{border-top:1px solid #ccc;padding:12px 0}.h{display:flex;justify-content:space-between;margin:0}.h span{color:#555}.t{color:#555;margin:4px 0 8px}pre{white-space:pre-wrap;font:inherit}</style></head><body><h1>${escapeHtml(subject)}</h1>${body}</body></html>`,
  );
  w.document.close();
  w.focus();
  w.print();
}

/** Attachments Gmail previews in its overlay: images and PDFs. */
const previewable = (mimeType: string) =>
  opensInline(mimeType) && (mimeType.startsWith('image/') || mimeType === 'application/pdf');

/**
 * Gmail's attachment preview: the image, or the PDF drawn by pdf.js (no
 * plugin, no frame, no script from the file), over the conversation, with
 * Download kept. The file comes from the same attachment route as the
 * download (inline types only), so no mail-borne script runs here.
 */
function AttachmentPreview({
  file,
  onClose,
}: {
  file: { name: string; mimeType: string; href: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={file !== null} onOpenChange={(o) => !o && onClose()}>
      {file ? (
        <DialogContent
          title={file.name}
          description="Preview"
          className="h-[min(90dvh,60rem)] max-w-5xl"
        >
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex justify-end gap-1">
              <a
                href={file.href}
                download={file.name}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
              >
                <Download className="size-4" aria-hidden /> Download
              </a>
              <a
                href={file.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
              >
                <ExternalLink className="size-4" aria-hidden /> Open in a new tab
              </a>
            </div>
            {file.mimeType.startsWith('image/') ? (
              <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-md bg-[var(--bg-sunken)] p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a mail attachment, not a site asset */}
                <img
                  src={file.href}
                  alt={file.name}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : (
              <PdfPreview href={file.href} name={file.name} />
            )}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function AttachmentCards({ message }: { message: LiveMessage }) {
  const [preview, setPreview] = React.useState<{
    name: string;
    mimeType: string;
    href: string;
  } | null>(null);
  if (message.attachments.length === 0) return null;
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <p className="mb-2 text-xs font-medium text-[var(--fg-muted)]">
        {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}
      </p>
      <ul className="flex flex-wrap gap-2">
        {message.attachments.map((a, i) => {
          const Icon = a.mimeType.startsWith('image/')
            ? FileImage
            : /pdf|text|document|sheet|presentation/.test(a.mimeType)
              ? FileText
              : FileIcon;
          const href = a.id
            ? `/api/inbox/attachment?${new URLSearchParams({
                m: message.id,
                a: a.id,
                name: a.name,
                type: a.mimeType,
              }).toString()}`
            : null;
          return (
            <li
              key={`${a.id}|${a.name}|${i}`}
              className="group/att relative flex w-44 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-sunken)]"
            >
              {href && previewable(a.mimeType) ? (
                <button
                  type="button"
                  onClick={() => setPreview({ name: a.name, mimeType: a.mimeType, href })}
                  aria-label={`Preview ${a.name}`}
                  title="Preview"
                  className="grid h-20 place-items-center overflow-hidden text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
                >
                  {a.mimeType.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a mail attachment thumbnail
                    <img src={href} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <Icon className="size-8" aria-hidden />
                  )}
                </button>
              ) : (
                <div className="grid h-20 place-items-center text-[var(--fg-subtle)]">
                  <Icon className="size-8" aria-hidden />
                </div>
              )}
              <div className="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium" title={a.name}>
                    {a.name}
                  </span>
                  <span className="block text-[11px] text-[var(--fg-subtle)]">
                    {fileSize(a.size)}
                  </span>
                </span>
                {href ? (
                  <a
                    href={href}
                    {...(opensInline(a.mimeType)
                      ? { target: '_blank', rel: 'noopener noreferrer' }
                      : { download: a.name })}
                    aria-label={`Download ${a.name}`}
                    title="Download"
                    className="rounded-full p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                  >
                    <Download className="size-4" aria-hidden />
                  </a>
                ) : (
                  <span
                    title="Attachments open only on the real mailbox."
                    className="text-[11px] text-[var(--fg-subtle)]"
                  >
                    demo
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <AttachmentPreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function MessageCard({
  message: m,
  open,
  onToggle,
  timeZone,
  mailbox,
  starred,
  onStar,
  onWrite,
  onPrint,
  onUnreadFromHere,
  sender,
  onShowOriginal,
  onDownload,
  onForwardAttached,
  threadId,
}: {
  /** The conversation, for Translate message. */
  threadId: string;
  /** Gmail's "Forward as attachment": a new compose window with this email attached. */
  onForwardAttached: (() => void) | null;
  sender: SenderActions;
  /** Gmail's "Show original": the source, read-only. */
  onShowOriginal: () => void;
  /** Gmail's "Download message": the original as an .eml file. */
  onDownload: () => void;
  message: LiveMessage;
  open: boolean;
  onToggle: () => void;
  timeZone: string;
  mailbox: string | null;
  starred: boolean;
  onStar: (() => void) | null;
  onWrite: (kind: WriteKind) => void;
  onPrint: () => void;
  onUnreadFromHere: (() => void) | null;
}) {
  const [details, setDetails] = React.useState(false);
  const [showQuoted, setShowQuoted] = React.useState(false);
  // Gmail's Translate message, by Kraken AI: on demand only, toggled back with See original.
  const [translation, setTranslation] = React.useState<{ language: string; text: string } | null>(
    null,
  );
  const [translated, setTranslated] = React.useState(false);
  const [translating, setTranslating] = React.useState(false);
  const foreign = React.useMemo(() => !looksEnglish(m.text), [m.text]);
  const translate = async () => {
    if (translation) {
      setTranslated(true);
      return;
    }
    setTranslating(true);
    try {
      const res = await fetch('/api/inbox/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'translate', threadId, messageId: m.id }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, 'Kraken could not translate it. Try again.'));
        return;
      }
      setTranslation((await res.json()) as { language: string; text: string });
      setTranslated(true);
    } catch {
      toast.error('Could not reach Kraken. Try again.');
    } finally {
      setTranslating(false);
    }
  };
  const preview = React.useMemo(() => splitQuoted(reflow(m.text)).main.slice(0, 200), [m.text]);
  const avatar = (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--nav-active)] text-sm font-semibold text-[var(--accent)]"
    >
      {initialOf(m.fromName)}
    </span>
  );
  if (!open) {
    return (
      <li className="border-b border-[var(--border)]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-hover)]"
        >
          {avatar}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {m.fromName}
              {m.fromUs ? <span className="ml-1 text-xs font-normal">(me)</span> : null}
            </span>
            <span className="block truncate text-sm text-[var(--fg-muted)]">{preview}</span>
          </span>
          <span className="shrink-0 text-xs text-[var(--fg-muted)]">
            {longTime(m.at, timeZone)}
          </span>
        </button>
      </li>
    );
  }
  const items: MenuItem[] = [
    { id: 'reply', label: 'Reply', icon: Reply, onSelect: () => onWrite('reply') },
    { id: 'replyAll', label: 'Reply all', icon: ReplyAll, onSelect: () => onWrite('replyAll') },
    { id: 'forward', label: 'Forward', icon: Forward, onSelect: () => onWrite('forward') },
    ...(onForwardAttached
      ? [
          {
            id: 'forwardAttached',
            label: 'Forward as attachment',
            icon: Paperclip,
            onSelect: onForwardAttached,
          },
        ]
      : []),
    { id: 'print', label: 'Print', icon: Printer, divider: true, onSelect: onPrint },
    ...(foreign
      ? [
          {
            id: 'translate',
            label: translated ? 'See original language' : 'Translate message',
            icon: Languages,
            onSelect: () => (translated ? setTranslated(false) : void translate()),
          },
        ]
      : []),
    { id: 'original', label: 'Show original', icon: FileCode, onSelect: onShowOriginal },
    { id: 'download', label: 'Download message', icon: Download, onSelect: onDownload },
    ...(onUnreadFromHere
      ? [{ id: 'unread', label: 'Mark unread from here', icon: Mail, onSelect: onUnreadFromHere }]
      : []),
    ...(!m.fromUs && sender.onFilterLike
      ? [
          {
            id: 'filterLike',
            label: 'Filter messages like this',
            icon: Filter,
            divider: true,
            onSelect: () => sender.onFilterLike?.(m),
          },
        ]
      : []),
    ...(!m.fromUs && sender.onBlock
      ? [
          {
            id: 'block',
            label: `Block “${m.fromName}”`,
            icon: Ban,
            onSelect: () => sender.onBlock?.(m),
          },
        ]
      : []),
    ...(!m.fromUs && sender.onPhishing
      ? [
          {
            id: 'phishing',
            label: 'Report phishing',
            icon: ShieldAlert,
            onSelect: () => sender.onPhishing?.(),
          },
        ]
      : []),
  ];
  return (
    <li className="border-b border-[var(--border)] px-4 py-3">
      <div className="flex items-start gap-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{m.fromName}</span>
            <span className="truncate text-xs text-[var(--fg-muted)]">
              &lt;{addressOf(m.from)}&gt;
            </span>
            {!m.fromUs && m.unsubscribe && sender.onUnsubscribe ? (
              unsubscribeHow(m.unsubscribe) === 'link' ? (
                <a
                  href={m.unsubscribe.http!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-[var(--fg-muted)] underline hover:text-[var(--fg)]"
                >
                  Unsubscribe
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => sender.onUnsubscribe?.(m)}
                  className="text-xs font-medium text-[var(--fg-muted)] underline hover:text-[var(--fg)]"
                >
                  Unsubscribe
                </button>
              )
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setDetails((d) => !d)}
            aria-expanded={details}
            className="inline-flex max-w-full items-center gap-0.5 text-xs text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            <span className="truncate">to {toLine(m, mailbox)}</span>
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Show details</span>
          </button>
          {details ? (
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-2 text-xs">
              <dt className="text-right text-[var(--fg-muted)]">from:</dt>
              <dd className="break-words">{m.from}</dd>
              <dt className="text-right text-[var(--fg-muted)]">to:</dt>
              <dd className="break-words">{m.to || '(hidden)'}</dd>
              {m.cc ? (
                <>
                  <dt className="text-right text-[var(--fg-muted)]">cc:</dt>
                  <dd className="break-words">{m.cc}</dd>
                </>
              ) : null}
              <dt className="text-right text-[var(--fg-muted)]">date:</dt>
              <dd>{longTime(m.at, timeZone)}</dd>
            </dl>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="hidden text-xs text-[var(--fg-muted)] sm:inline">
            {longTime(m.at, timeZone)} {ago(m.at)}
          </span>
          {onStar ? (
            <button
              type="button"
              onClick={onStar}
              aria-label={starred ? 'Unstar' : 'Star'}
              aria-pressed={starred}
              className={ICON_BTN}
            >
              <Star
                className={cn('size-4', starred && 'fill-[var(--gold)] text-[var(--gold)]')}
                aria-hidden
              />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onWrite('reply')}
            aria-label={`Reply to ${m.fromName}`}
            title="Reply"
            className={ICON_BTN}
          >
            <Reply className="size-4" aria-hidden />
          </button>
          <MenuButton label="Message actions" items={items} align="end">
            <button type="button" aria-label="More message actions" className={ICON_BTN}>
              <MoreVertical className="size-4" aria-hidden />
            </button>
          </MenuButton>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse message"
            className="sr-only focus:not-sr-only"
          >
            Collapse
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-2 sm:pl-[3.25rem]">
        {translating ? (
          <p className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Translating…
          </p>
        ) : null}
        {translated && translation ? (
          <div className="space-y-2">
            <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-muted)]">
              <Languages className="size-3.5 text-[var(--gold)]" aria-hidden />
              Translated from {translation.language} by Kraken AI ·
              <button
                type="button"
                onClick={() => setTranslated(false)}
                className="font-medium text-[var(--accent)] hover:underline"
              >
                See original
              </button>
            </p>
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              {translation.text}
            </p>
          </div>
        ) : (
          <MessageBody
            message={m}
            showQuoted={showQuoted}
            onToggleQuoted={() => setShowQuoted((q) => !q)}
            hideRecipients
            hideAttachments
          />
        )}
        <AttachmentCards message={m} />
      </div>
    </li>
  );
}

/**
 * One conversation, laid out like Gmail's: the toolbar (back, archive,
 * report spam, delete, mark unread, snooze, move to, label, more, and the
 * "3 of 8" arrows), the subject with its label chips and Print, each message
 * as a card (avatar, sender, "to me ▾" details, date, star, reply and its
 * own menu), the older ones folded behind "N older messages", attachments as
 * cards, and Reply, Reply all and Forward at the bottom, which open Gmail's
 * inline composer here. Nothing sends until a person taps Send.
 */
export function ThreadView({
  row,
  timeZone,
  initialThread,
  canModify,
  mailbox,
  folder,
  write,
  setWrite,
  composeEnv,
  onBack,
  onAct,
  labelChoices,
  onLabel,
  labelMenuOpen,
  setLabelMenuOpen,
  onMove,
  moveMenuOpen,
  setMoveMenuOpen,
  onSnooze,
  snoozeMenuOpen,
  setSnoozeMenuOpen,
  snoozedUntil,
  onUnsnooze,
  onSent,
  position,
  sender = NO_SENDER_ACTIONS,
  onCompose,
}: {
  /** Open a floating compose window (Forward as attachment, Pop out). */
  onCompose?: (seed: ComposeSeed) => void;
  /** Filter like these, Block and Report phishing for each message's sender. */
  sender?: SenderActions;
  row: LiveThreadRow;
  timeZone: string;
  /** The conversation already read on the server (a link opened it): shown without a second read. */
  initialThread?: LiveThread;
  canModify: boolean;
  mailbox: string | null;
  /** The folder on screen (null during a search), for which actions the toolbar offers. */
  folder: FolderId | null;
  /** The inline composer the keys (r, a, f) or the buttons asked for. */
  write: WriteKind | null;
  setWrite: (kind: WriteKind | null) => void;
  composeEnv: ComposeEnv;
  onBack: () => void;
  onAct: (action: SystemAction) => Promise<boolean>;
  labelChoices: readonly MailLabel[];
  onLabel: ((change: LabelChange) => void) | null;
  labelMenuOpen: boolean;
  setLabelMenuOpen: (open: boolean) => void;
  onMove: ((to: string) => void) | null;
  moveMenuOpen: boolean;
  setMoveMenuOpen: (open: boolean) => void;
  onSnooze: ((wakeAt: Date) => void) | null;
  snoozeMenuOpen: boolean;
  setSnoozeMenuOpen: (open: boolean) => void;
  /** Opened from the Snoozed folder: when it comes back; Unsnooze replaces Archive. */
  snoozedUntil: string | null;
  onUnsnooze: () => void;
  onSent: () => void;
  /** "3 of 8" and the newer/older arrows; null when the conversation is not in the list. */
  position: { index: number; total: number; onNewer: () => void; onOlder: () => void } | null;
}) {
  const router = useRouter();
  const [thread, setThread] = React.useState<LiveThread | null>(initialThread ?? null);
  const labelColors = React.useMemo(() => colorsByName(labelChoices), [labelChoices]);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [openIds, setOpenIds] = React.useState<Set<string>>(new Set());
  const [showOlder, setShowOlder] = React.useState(false);
  const [seed, setSeed] = React.useState<ComposeSeed | null>(null);
  const [seedFocus, setSeedFocus] = React.useState(true);
  const [preparing, setPreparing] = React.useState(false);
  /** The message whose original "Show original" is showing. */
  const [original, setOriginal] = React.useState<string | null>(null);
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

  // The newest message and any unread ones start open, as in Gmail.
  const lastId = thread?.messages.at(-1)?.id ?? null;
  const [openedFor, setOpenedFor] = React.useState<string | null>(null);
  if (thread && openedFor !== thread.id + lastId) {
    setOpenedFor(thread.id + lastId);
    setOpenIds(new Set(lastId ? [lastId] : []));
  }

  /** Open the inline composer for a message (the newest by default). */
  const startWrite = React.useCallback(
    async (
      kind: WriteKind,
      message?: LiveMessage,
      opts: { quiet?: boolean; html?: string } = {},
    ) => {
      if (!thread) return;
      const m = message ?? thread.messages.at(-1)!;
      const base = replySeed(kind, thread, m, mailbox, timeZone);
      // A suggested reply fills the box; the person edits and sends it.
      if (opts.html) base.html = opts.html;
      setSeedFocus(!opts.quiet);
      if (kind !== 'replyAll' || composeEnv.demo) {
        setSeed(base);
        setWrite(kind);
        return;
      }
      // Reply all starts from the draft already on the thread in Gmail, if any.
      setPreparing(true);
      try {
        const r = await fetch(`/api/email-session/draft?id=${thread.id}`);
        const d = r.ok
          ? ((await r.json()) as {
              draft: { draftId: string | null; to: string; cc: string; body: string } | null;
            })
          : null;
        const draft = d?.draft;
        setSeed(
          draft
            ? {
                ...base,
                to: draft.to || base.to,
                cc: draft.cc,
                html: draft.body ? textToComposeHtml(draft.body) : '',
                draftId: draft.draftId,
              }
            : base,
        );
        setWrite('replyAll');
      } finally {
        setPreparing(false);
      }
    },
    [thread, mailbox, timeZone, composeEnv.demo, setWrite],
  );

  // A key asked for a composer (r, a, f): open it once the thread is here.
  React.useEffect(() => {
    if (!write || !thread || (seed && seed.mode === write) || preparing) return;
    // After this render: opening it sets state of its own.
    const t = window.setTimeout(() => void startWrite(write), 0);
    return () => window.clearTimeout(t);
  }, [write, thread, seed, preparing, startWrite]);

  // A Gmail draft already on the thread opens as Reply all, shown but not focused.
  const checkedDraft = React.useRef(false);
  React.useEffect(() => {
    if (!thread || checkedDraft.current || composeEnv.demo || !composeEnv.canSend) return;
    checkedDraft.current = true;
    let cancelled = false;
    fetch(`/api/email-session/draft?id=${thread.id}`)
      .then(async (r) =>
        r.ok ? ((await r.json()) as { draft: { draftId: string | null } }) : null,
      )
      .then((d) => {
        if (!cancelled && d?.draft?.draftId && !seed)
          void startWrite('replyAll', undefined, { quiet: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [thread, composeEnv.demo, composeEnv.canSend, seed, startWrite]);

  const closeWrite = () => {
    setSeed(null);
    setWrite(null);
  };

  const inSpam = folder === 'spam' || Boolean(row.inSpam);
  const inTrash = folder === 'trash' || Boolean(row.inTrash);
  const messages = thread?.messages ?? [];
  // Gmail folds the middle of a long conversation: the first, "N older", then the last two.
  const fold = !showOlder && messages.length >= 5;
  const hidden = fold ? messages.slice(1, -2) : [];
  const shown = fold ? [messages[0]!, ...messages.slice(-2)] : messages;

  // The newest message someone else sent: who "Filter messages like these" and Block are about.
  const lastIncoming = [...messages].reverse().find((m) => !m.fromUs) ?? null;
  const lastIncomingIsLast = Boolean(lastIncoming && lastIncoming === messages.at(-1));
  const moreItems: MenuItem[] = [
    {
      id: 'imp',
      label: row.important ? 'Mark as not important' : 'Mark as important',
      icon: Bookmark,
      onSelect: () => void onAct(row.important ? 'unimportant' : 'important'),
    },
    {
      id: 'star',
      label: row.starred ? 'Remove star' : 'Add star',
      icon: Star,
      onSelect: () => void onAct(row.starred ? 'unstar' : 'star'),
    },
    {
      id: 'fwd',
      label: 'Forward',
      icon: Forward,
      divider: true,
      onSelect: () => void startWrite('forward'),
    },
    ...(onCompose && thread && messages.length
      ? [
          {
            id: 'fwdAttached',
            label: 'Forward as attachment',
            icon: Paperclip,
            onSelect: () => onCompose(attachedSeed(thread, messages.at(-1)!)),
          },
        ]
      : []),
    ...(thread
      ? [
          {
            id: 'task',
            label: 'Add to Tasks',
            icon: ListTodo,
            divider: true,
            onSelect: () => void addToTasks(thread.id, () => router.push('/tasks')),
          },
        ]
      : []),
    ...(thread
      ? [
          {
            id: 'event',
            label: 'Create event',
            icon: CalendarPlus,
            onSelect: () => {
              const prefill = eventPrefill({
                subject: thread.subject,
                participants: thread.messages.flatMap((m) => [
                  m.from,
                  ...splitList(m.to),
                  ...splitList(m.cc),
                ]),
                mailbox,
                threadUrl: `${window.location.origin}/inbox?thread=${thread.id}`,
              });
              if (!storePrefill(prefill)) {
                toast.error('This browser would not hold the event details. Try again.');
                return;
              }
              router.push(`/calendar?${PREFILL_PARAM}=${PREFILL_VALUE}`);
            },
          },
        ]
      : []),
    {
      id: 'print',
      label: 'Print all',
      icon: Printer,
      onSelect: () => thread && printMessages(thread.subject, thread.messages, timeZone),
    },
    ...(sender.onFilterLike && lastIncoming
      ? [
          {
            id: 'filterLike',
            label: 'Filter messages like these',
            icon: Filter,
            divider: true,
            onSelect: () => sender.onFilterLike?.(lastIncoming),
          },
        ]
      : []),
    ...(sender.onBlock && lastIncoming
      ? [
          {
            id: 'block',
            label: `Block “${lastIncoming.fromName}”`,
            icon: Ban,
            onSelect: () => sender.onBlock?.(lastIncoming),
          },
        ]
      : []),
    ...(sender.onPhishing && !inSpam && !inTrash
      ? [
          {
            id: 'phishing',
            label: 'Report phishing',
            icon: ShieldAlert,
            onSelect: () => sender.onPhishing?.(),
          },
        ]
      : []),
  ];

  return (
    <article className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      <header
        role="toolbar"
        aria-label="Conversation actions"
        className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] px-2 py-1"
      >
        <button type="button" onClick={onBack} aria-label="Back to the list" className={ICON_BTN}>
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        {canModify ? (
          <>
            {snoozedUntil ? (
              <button
                type="button"
                onClick={onUnsnooze}
                className="h-8 rounded-md px-2 text-sm font-medium hover:bg-[var(--bg-hover)]"
              >
                Unsnooze
              </button>
            ) : inTrash ? (
              <button
                type="button"
                onClick={() => void onAct('restore')}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium hover:bg-[var(--bg-hover)]"
              >
                <InboxIcon className="size-4" aria-hidden /> Move to inbox
              </button>
            ) : inSpam ? (
              <button
                type="button"
                onClick={() => void onAct('notspam')}
                className="h-8 rounded-md px-2 text-sm font-medium hover:bg-[var(--bg-hover)]"
              >
                Not spam
              </button>
            ) : row.inInbox ? (
              <button
                type="button"
                onClick={() => void onAct('archive')}
                aria-label="Archive"
                title="Archive"
                className={ICON_BTN}
              >
                <Archive className="size-4" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void onAct('inbox')}
                aria-label="Move to inbox"
                title="Move to inbox"
                className={ICON_BTN}
              >
                <InboxIcon className="size-4" aria-hidden />
              </button>
            )}
            {!inSpam && !inTrash ? (
              <button
                type="button"
                onClick={() => void onAct('spam')}
                aria-label="Report spam"
                title="Report spam"
                className={ICON_BTN}
              >
                <OctagonAlert className="size-4" aria-hidden />
              </button>
            ) : null}
            {!inTrash ? (
              <button
                type="button"
                onClick={() => void onAct('trash')}
                aria-label="Delete"
                title="Delete"
                className={ICON_BTN}
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            ) : null}
            <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
            <button
              type="button"
              onClick={() => void onAct('unread').then((ok) => ok && onBack())}
              aria-label="Mark unread"
              title="Mark as unread"
              className={ICON_BTN}
            >
              <Mail className="size-4" aria-hidden />
            </button>
          </>
        ) : null}
        {onSnooze ? (
          <SnoozeMenu
            timeZone={timeZone}
            onSnooze={onSnooze}
            open={snoozeMenuOpen}
            onOpenChange={setSnoozeMenuOpen}
          >
            <button type="button" aria-label="Snooze" title="Snooze" className={ICON_BTN}>
              <AlarmClock className="size-4" aria-hidden />
            </button>
          </SnoozeMenu>
        ) : null}
        {onMove ? (
          <MoveMenu
            labels={labelChoices}
            current={
              folder === 'inbox' ? 'INBOX' : folder?.startsWith('label:') ? folder.slice(6) : null
            }
            onMove={onMove}
            open={moveMenuOpen}
            onOpenChange={setMoveMenuOpen}
          >
            <button type="button" aria-label="Move to" title="Move to" className={ICON_BTN}>
              <FolderInput className="size-4" aria-hidden />
            </button>
          </MoveMenu>
        ) : null}
        {onLabel ? (
          <LabelMenu
            choices={labelChoices}
            current={[row.labelIds]}
            onChange={onLabel}
            open={labelMenuOpen}
            onOpenChange={setLabelMenuOpen}
          >
            <button type="button" aria-label="Label" title="Label as" className={ICON_BTN}>
              <Tag className="size-4" aria-hidden />
            </button>
          </LabelMenu>
        ) : null}
        {canModify ? (
          <MenuButton label="More" items={moreItems}>
            <button type="button" aria-label="More" title="More" className={ICON_BTN}>
              <MoreVertical className="size-4" aria-hidden />
            </button>
          </MenuButton>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          {position ? (
            <>
              <span className="hidden px-1 text-xs text-[var(--fg-muted)] tabular-nums sm:inline">
                {position.index + 1} of {position.total}
              </span>
              <button
                type="button"
                onClick={position.onNewer}
                disabled={position.index <= 0}
                aria-label="Newer"
                title="Newer"
                className={ICON_BTN}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                onClick={position.onOlder}
                disabled={position.index >= position.total - 1}
                aria-label="Older"
                title="Older"
                className={ICON_BTN}
              >
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </>
          ) : null}
          <a
            href={gmailUrl(row.id, mailbox)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in Gmail"
            title="Open in Gmail"
            className={ICON_BTN}
          >
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </span>
      </header>

      <div className="flex items-start gap-3 px-4 pt-4 pb-2 sm:pl-[4.25rem]">
        <div className="min-w-0 flex-1">
          <h2 className="inline text-xl text-balance">{thread?.subject ?? row.subject}</h2>
          {/* The row's chips, so a change made here shows at once. */}
          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
            {row.inInbox && !inTrash && !inSpam ? (
              <span className="rounded bg-[var(--neutral-soft)] px-1.5 text-xs text-[var(--fg-muted)]">
                Inbox
              </span>
            ) : null}
            {inSpam ? (
              <span className="rounded bg-[var(--danger-soft)] px-1.5 text-xs text-[var(--danger)]">
                Spam
              </span>
            ) : null}
            {inTrash ? (
              <span className="rounded bg-[var(--neutral-soft)] px-1.5 text-xs text-[var(--fg-muted)]">
                Trash
              </span>
            ) : null}
            {row.labels.map((l) => (
              <LabelChip key={l} name={l} color={labelColors.get(l)} />
            ))}
          </span>
          {snoozedUntil ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--fg-muted)]">
              <AlarmClock className="size-4 text-[var(--accent)]" aria-hidden />
              Snoozed until {formatWake(snoozedUntil, readerZone(timeZone))}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Print all"
          title="Print all"
          disabled={!thread}
          onClick={() => thread && printMessages(thread.subject, thread.messages, timeZone)}
          className={ICON_BTN}
        >
          <Printer className="size-4" aria-hidden />
        </button>
      </div>

      {error ? <p className="px-4 py-2 text-sm text-[var(--danger)]">{error}</p> : null}
      {!thread && !error ? (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-[var(--fg-muted)]">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Opening…
        </p>
      ) : null}
      {thread ? (
        <ol aria-label="Messages" className="border-t border-[var(--border)]">
          {shown.map((m, i) => (
            <React.Fragment key={m.id}>
              <MessageCard
                message={m}
                open={openIds.has(m.id)}
                onToggle={() =>
                  setOpenIds((cur) => {
                    const next = new Set(cur);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })
                }
                timeZone={timeZone}
                mailbox={mailbox}
                starred={row.starred}
                onStar={canModify ? () => void onAct(row.starred ? 'unstar' : 'star') : null}
                onWrite={(kind) => void startWrite(kind, m)}
                onPrint={() => printMessages(thread.subject, [m], timeZone)}
                onUnreadFromHere={
                  canModify ? () => void onAct('unread').then((ok) => ok && onBack()) : null
                }
                sender={sender}
                onShowOriginal={() => setOriginal(m.id)}
                threadId={thread.id}
                onForwardAttached={onCompose ? () => onCompose(attachedSeed(thread, m)) : null}
                onDownload={() => {
                  const a = document.createElement('a');
                  a.href = originalHref(thread.id, m.id, true);
                  a.download = '';
                  a.click();
                }}
              />
              {fold && i === 0 ? (
                <li className="relative border-b border-[var(--border)] py-2">
                  <button
                    type="button"
                    onClick={() => setShowOlder(true)}
                    className="relative z-[1] ml-4 grid size-10 place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] text-sm font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
                    aria-label={`${hidden.length} older messages`}
                    title={`${hidden.length} older messages`}
                  >
                    {hidden.length}
                  </button>
                </li>
              ) : null}
            </React.Fragment>
          ))}
        </ol>
      ) : null}

      {thread ? (
        <div className="px-4 py-4 sm:pl-[4.25rem]">
          {seed ? (
            <div className="shadow-raised relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg)]">
              <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-xs text-[var(--fg-muted)]">
                {seed.mode === 'forward' ? (
                  <Forward className="size-3.5" aria-hidden />
                ) : seed.mode === 'replyAll' ? (
                  <ReplyAll className="size-3.5" aria-hidden />
                ) : (
                  <Reply className="size-3.5" aria-hidden />
                )}
                <span className="font-medium">
                  {seed.mode === 'forward'
                    ? 'Forward'
                    : seed.mode === 'replyAll'
                      ? 'Reply all'
                      : 'Reply'}
                </span>
                {seed.draftId ? (
                  <span className="rounded bg-[var(--ok-soft)] px-1.5 text-[var(--ok)]">
                    Draft from Gmail
                  </span>
                ) : null}
              </div>
              <ComposeForm
                key={seed.key}
                seed={seed}
                env={{ ...composeEnv, gmailHref: gmailUrl(row.id, mailbox) }}
                inline
                focusOnOpen={seedFocus}
                onPopOut={
                  onCompose
                    ? (popped) => {
                        closeWrite();
                        onCompose(popped);
                      }
                    : undefined
                }
                onDone={(what) => {
                  closeWrite();
                  if (what === 'sent' || what === 'scheduled') {
                    setReloadKey((k) => k + 1);
                    onSent();
                  }
                }}
                onClose={closeWrite}
              />
            </div>
          ) : (
            <>
              {composeEnv.canSend || composeEnv.demo ? (
                lastIncomingIsLast && messages.length ? (
                  <SuggestedReplies
                    threadId={thread.id}
                    lastMessageId={messages.at(-1)!.id}
                    onPick={(text) =>
                      void startWrite('reply', undefined, { html: textToComposeHtml(text) })
                    }
                  />
                ) : null
              ) : null}
              <div className="flex flex-wrap gap-2">
                {preparing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {(
                  [
                    ['reply', 'Reply', Reply],
                    ['replyAll', 'Reply all', ReplyAll],
                    ['forward', 'Forward', Forward],
                  ] as const
                ).map(([kind, label, Icon]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => void startWrite(kind)}
                    disabled={preparing}
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
                  >
                    <Icon className="size-4" aria-hidden /> {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
      <ShowOriginalDialog
        target={thread && original ? { threadId: thread.id, messageId: original } : null}
        onClose={() => setOriginal(null)}
      />
    </article>
  );
}

/** Gmail's forward for the other tabs' compose window: the newest message quoted under a header. */
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
