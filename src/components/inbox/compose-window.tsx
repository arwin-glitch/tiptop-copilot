'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  Bold,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Send,
  Trash2,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readerZone } from '@/components/inbox/snooze-menu';
import { TemplatesMenu } from '@/components/inbox/templates-menu';
import { isBlankHtml } from '@/lib/email/compose-html';
import {
  checkSendAt,
  schedulePresets,
  sendWindowNote,
  SCHEDULE_NOT_SET_UP,
} from '@/lib/email/schedule-send';
import { formatWake, pickedWakeAt, toDateTimeLocal } from '@/lib/email/snooze';
import { useUndoSeconds } from '@/components/inbox/use-stored';
import { cn } from '@/lib/util/cn';

type Signature = 'nick' | 'arwin';

/** What a compose window opens with. */
export interface ComposeSeed {
  /** Unique per window. */
  key: string;
  mode: 'new' | 'reply' | 'replyAll' | 'forward' | 'draft' | 'scheduled';
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** The body to start from, as the compose box's HTML. */
  html: string;
  /** A reply: the thread it goes on. */
  threadId?: string | null;
  /** A forward: the message whose attachments go along, and their names. */
  forwardOf?: string | null;
  forwardNames?: string[];
  /** Forward as attachment: this message goes along whole, as an .eml (message/rfc822). */
  attachMessage?: { threadId: string; messageId: string; name: string } | null;
  /** The Gmail draft this window saves to (opened from Drafts, or saved already). */
  draftId?: string | null;
  /** A scheduled send opened from Scheduled, and its time. */
  scheduledId?: string | null;
  sendAt?: string | null;
  signature?: Signature;
}

/** The compose box is saved to Gmail's Drafts this long after the last change. */
const AUTOSAVE_MS = 2_500;
const MAX_FILES_BYTES = 7 * 1024 * 1024;
const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Jane Doe <jane@x.com>" -> its address; a bare address stays. */
function addressIn(token: string): string {
  return (/<([^<>\s]+@[^<>\s]+)>/.exec(token)?.[1] ?? token).trim();
}

function splitTokens(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

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

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * A recipient field as chips, like Gmail's: type an address and press Enter,
 * comma or Tab (or leave the field) to make a chip; Backspace in an empty
 * field takes the last one back. An address that does not look like one
 * shows in the danger colour, and Send says so.
 */
function RecipientField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoFocus,
  trailing,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = React.useState('');
  const tokens = splitTokens(value);
  const commit = (raw: string) => {
    const add = splitTokens(raw);
    if (add.length === 0) return;
    onChange([...tokens, ...add].join(', '));
    setText('');
  };
  const people = usePeopleSuggestions(text);
  // Gmail highlights the first match; a full address typed out keeps what was typed.
  const [active, setActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const [shownFor, setShownFor] = React.useState(text);
  if (shownFor !== text) {
    setShownFor(text);
    setActive(ADDRESS.test(text.trim()) ? -1 : 0);
    setDismissed(false);
  }
  const taken = new Set(tokens.map((t) => addressIn(t).toLowerCase()));
  const options = people.filter((p) => !taken.has(p.email.toLowerCase()));
  const open = !dismissed && !disabled && text.trim().length >= 2 && options.length > 0;
  const listId = `${id}-people`;
  const pick = (p: { name: string; email: string }) => {
    const chip =
      p.name && p.name !== p.email
        ? `${p.name.replace(/[",<>]/g, ' ').trim()} <${p.email}>`
        : p.email;
    onChange([...tokens, chip].join(', '));
    setText('');
  };
  return (
    <div className="relative flex min-h-9 items-center gap-2 border-b border-[var(--border)] px-3">
      <label htmlFor={id} className="shrink-0 text-sm text-[var(--fg-muted)]">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
        {tokens.map((t, i) => {
          const ok = ADDRESS.test(addressIn(t));
          return (
            <span
              key={`${t}|${i}`}
              title={t}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                ok
                  ? 'border-[var(--border)] bg-[var(--neutral-soft)] text-[var(--fg)]'
                  : 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
              )}
            >
              <span className="truncate">{t}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${t}`}
                onClick={() => onChange(tokens.filter((_, j) => j !== i).join(', '))}
                className="rounded-full hover:bg-[var(--bg-hover)]"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((a) => (a + step + options.length) % options.length);
              return;
            }
            if (open && e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            if (open && active >= 0 && options[active] && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              pick(options[active]!);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
              if (e.key === 'Enter') e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && !text && tokens.length) {
              setText(tokens.at(-1) ?? '');
              onChange(tokens.slice(0, -1).join(', '));
              e.preventDefault();
            }
          }}
          onBlur={() => commit(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commit(`${text}${pasted.replace(/\n/g, ',')}`);
            }
          }}
          className="h-7 min-w-[8rem] flex-1 bg-transparent text-sm text-[var(--fg)] focus-visible:outline-none"
        />
      </div>
      {trailing}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested people"
          className="shadow-overlay absolute top-full right-3 left-3 z-10 mt-0.5 max-h-60 overflow-y-auto rounded-md border border-[var(--border-strong)] bg-[var(--bg-overlay)] py-1"
        >
          {options.map((p, i) => (
            <li
              key={p.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // Before the field's blur, which would make a chip of the half-typed text.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm',
                i === active && 'bg-[var(--bg-hover)]',
              )}
            >
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--nav-active)] text-xs font-semibold text-[var(--accent)]"
              >
                {(p.name || p.email).charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--fg)]">
                  {p.name || p.email}
                </span>
                <span className="block truncate text-xs text-[var(--fg-muted)]">{p.email}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * People for a To/Cc/Bcc field as it is typed: Kraken's contacts and recent
 * senders from the Inbox's own suggest route (people only, no mail search),
 * asked once per pause in typing. Read-only.
 */
function usePeopleSuggestions(text: string): { name: string; email: string }[] {
  const [found, setFound] = React.useState<{
    q: string;
    people: { name: string; email: string }[];
  }>({ q: '', people: [] });
  const q = text.trim();
  React.useEffect(() => {
    if (q.length < 2 || /[,;]/.test(q)) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      fetch(`/api/inbox/suggest?people=1&q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { people?: { name: string; email: string }[] } | null) => {
          if (!cancelled && j?.people) setFound({ q, people: j.people });
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q]);
  const lower = q.toLowerCase();
  if (!found.q || !lower.startsWith(found.q.toLowerCase())) return [];
  // The answer for a shorter prefix, narrowed to what is typed now until the next one lands.
  return found.people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(lower));
}

const TOOL =
  'grid size-8 place-items-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-40';

/** Gmail's basic formatting bar: bold, italic, underline, link, bulleted and numbered lists. */
export function FormatBar({
  editor,
  disabled,
  onChange,
}: {
  editor: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  onChange: () => void;
}) {
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [href, setHref] = React.useState('https://');
  const saved = React.useRef<Range | null>(null);
  const run = (command: string, value?: string) => {
    editor.current?.focus();
    // execCommand is the one cross-browser way to format a contenteditable
    // box; the HTML it writes is sanitized on the server before it is sent.
    document.execCommand(command, false, value);
    onChange();
  };
  const tools: { cmd: string; label: string; icon: typeof Bold; key: string }[] = [
    { cmd: 'bold', label: 'Bold (Ctrl+B)', icon: Bold, key: 'b' },
    { cmd: 'italic', label: 'Italic (Ctrl+I)', icon: Italic, key: 'i' },
    { cmd: 'underline', label: 'Underline (Ctrl+U)', icon: Underline, key: 'u' },
  ];
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5">
      {tools.map((t) => (
        <button
          key={t.cmd}
          type="button"
          disabled={disabled}
          aria-label={t.label}
          title={t.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(t.cmd)}
          className={TOOL}
        >
          <t.icon className="size-4" aria-hidden />
        </button>
      ))}
      <Popover
        open={linkOpen}
        onOpenChange={(o) => {
          if (o) {
            const sel = window.getSelection();
            saved.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            setHref('https://');
          }
          setLinkOpen(o);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Insert link"
            title="Insert link"
            onMouseDown={(e) => e.preventDefault()}
            className={TOOL}
          >
            <LinkIcon className="size-4" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Insert link" className="w-72 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = href.trim();
              if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) {
                toast.error('A link starts with https:// or mailto:');
                return;
              }
              setLinkOpen(false);
              editor.current?.focus();
              const sel = window.getSelection();
              if (saved.current && sel) {
                sel.removeAllRanges();
                sel.addRange(saved.current);
              }
              if (sel && !sel.isCollapsed) run('createLink', url);
              else run('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
            }}
            className="space-y-2"
          >
            <label htmlFor="compose-link" className="text-xs text-[var(--fg-muted)]">
              Web address or email link
            </label>
            <input
              id="compose-link"
              autoFocus
              value={href}
              onChange={(e) => setHref(e.target.value)}
              className="h-8 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" variant="primary">
                Insert
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        disabled={disabled}
        aria-label="Bulleted list"
        title="Bulleted list"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run('insertUnorderedList')}
        className={TOOL}
      >
        <List className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-label="Numbered list"
        title="Numbered list"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run('insertOrderedList')}
        className={TOOL}
      >
        <ListOrdered className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Gmail's schedule-send menu: three preset times and "Pick date & time", in
 * the browser's own time zone, each with the honest window Kraken keeps.
 * Picking one calls `onSchedule`; nothing is scheduled until then. Before
 * the scheduled-send table exists it says so and offers nothing.
 */
function ScheduleMenu({
  timeZone,
  ready,
  onSchedule,
  disabled,
  children,
}: {
  timeZone: string;
  ready: boolean;
  onSchedule: (at: Date) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [opened, setOpened] = React.useState<{ now: Date; zone: string } | null>(null);
  if (open && !opened) setOpened({ now: new Date(), zone: readerZone(timeZone) });
  if (!open && opened) setOpened(null);
  const zone = opened?.zone ?? readerZone(timeZone);
  const presets = opened ? schedulePresets(opened.now, opened.zone) : [];
  const choose = (at: Date) => {
    setOpen(false);
    setPicking(false);
    setError(null);
    onSchedule(at);
  };
  const pickedAt = picked ? pickedWakeAt(picked, zone) : null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPicking(false);
          setPicked('');
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" aria-label="Schedule send" className="w-80 p-2">
        <p className="px-1.5 pb-1 text-sm font-semibold">Schedule send</p>
        {!ready ? (
          <p className="px-1.5 py-2 text-sm text-[var(--warn)]">{SCHEDULE_NOT_SET_UP}</p>
        ) : !picking ? (
          <div className="space-y-px">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choose(p.at)}
                className="flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
              >
                <span>{p.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">{formatWake(p.at, zone)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setPicking(true);
                setPicked(toDateTimeLocal(new Date(Date.now() + 3_600_000), zone));
              }}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
            >
              <Clock className="size-4 text-[var(--fg-muted)]" aria-hidden /> Pick date &amp; time
            </button>
            <p className="px-1.5 pt-1 text-xs text-[var(--fg-subtle)]">
              Times are in your time zone ({zone}). Kraken sends within about 3 minutes, 6 AM–9 PM
              Central.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const at = pickedWakeAt(picked, zone);
              const check = at ? checkSendAt(at, new Date()) : null;
              if (!at || !check?.ok) {
                setError(check && !check.ok ? check.message : 'Pick a date and time.');
                return;
              }
              choose(at);
            }}
            className="space-y-2 px-1.5"
          >
            <label htmlFor="schedule-at" className="text-xs text-[var(--fg-muted)]">
              Date and time ({zone})
            </label>
            <input
              id="schedule-at"
              type="datetime-local"
              value={picked}
              min={toDateTimeLocal(new Date(), zone)}
              onChange={(e) => {
                setPicked(e.target.value);
                setError(null);
              }}
              className="h-9 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
            />
            {pickedAt ? (
              <p className="text-xs text-[var(--fg-subtle)]">{sendWindowNote(pickedAt)}</p>
            ) : null}
            {error ? <p className="text-xs text-[var(--danger)]">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicking(false)}>
                Back
              </Button>
              <Button type="submit" size="sm" variant="primary">
                Schedule send
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

export interface ComposeEnv {
  /** Sending is on (Send, Schedule and Gmail drafts). */
  canSend: boolean;
  /** Without sending, where a reply can be finished instead: the thread in Gmail. */
  gmailHref?: string | null;
  /** The demo: drafts and scheduled sends stay in the demo; Send is off. */
  demo: boolean;
  /** Schedule send's table is there (its migration run). */
  scheduleReady: boolean;
  timeZone: string;
}

/**
 * The compose box itself: recipient chips (To, and Cc and Bcc on a tap),
 * the subject, Gmail's formatting bar, attachments, Sign as, and Send with
 * its ▾ for Schedule send. Send waits the Undo Send period (5, 10, 20 or 30
 * seconds, picked in the Inbox's ⋮ menu) with Undo before it goes;
 * nothing ever sends without that tap, or the Schedule a person picked.
 * The box saves itself to Gmail's Drafts a moment after each change, without
 * a signature, which Send adds (Nick's real Gmail one, never typed).
 */
export function ComposeForm({
  seed,
  env,
  inline = false,
  focusOnOpen = true,
  onDone,
  onClose,
  onDraftSaved,
  onPopOut,
}: {
  seed: ComposeSeed;
  env: ComposeEnv;
  /**
   * Gmail's "Pop out reply": the inline reply moves to a floating compose
   * window with what is written so far, its draft and its thread. Inline only.
   */
  onPopOut?: (seed: ComposeSeed) => void;
  /** In the conversation (Gmail's inline reply): no subject line, no window chrome. */
  inline?: boolean;
  /** Put the caret in the box as it opens (not for a Gmail draft shown quietly). */
  focusOnOpen?: boolean;
  /** Sent, scheduled or discarded: the window closes and the list refreshes. */
  onDone: (what: 'sent' | 'scheduled' | 'discarded' | 'cancelled') => void;
  /** Closed with the words kept (in Drafts, once saved). */
  onClose: () => void;
  onDraftSaved?: () => void;
}) {
  const uid = React.useId();
  const undoFor = useUndoSeconds();
  const [to, setTo] = React.useState(seed.to);
  const [cc, setCc] = React.useState(seed.cc);
  const [bcc, setBcc] = React.useState(seed.bcc);
  const [showCc, setShowCc] = React.useState(Boolean(seed.cc));
  const [showBcc, setShowBcc] = React.useState(Boolean(seed.bcc));
  const [subject, setSubject] = React.useState(seed.subject);
  const [signature, setSignature] = React.useState<Signature>(seed.signature ?? 'nick');
  const [files, setFiles] = React.useState<File[]>([]);
  const [draftId, setDraftId] = React.useState<string | null>(seed.draftId ?? null);
  const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>(
    seed.draftId ? 'saved' : 'idle',
  );
  const [countdown, setCountdown] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const editor = React.useRef<HTMLDivElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const timer = React.useRef<number | null>(null);
  const saveTimer = React.useRef<number | null>(null);
  const dirty = React.useRef(false);
  const savingNow = React.useRef<Promise<string | null> | null>(null);
  const closed = React.useRef(false);
  const draftRef = React.useRef<string | null>(seed.draftId ?? null);
  const canDraft = env.canSend || env.demo;
  const scheduled = seed.mode === 'scheduled';

  // The body starts from the seed once; after that the box owns its HTML.
  React.useEffect(() => {
    if (editor.current) editor.current.innerHTML = seed.html;
  }, [seed.html]);
  // The caret goes where Gmail puts it: the body, or To when nobody is there yet.
  React.useEffect(() => {
    if (!focusOnOpen) return;
    if (!seed.to && seed.mode !== 'reply' && seed.mode !== 'replyAll') {
      document.getElementById(`${uid}-to`)?.focus();
    } else {
      editor.current?.focus();
    }
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const html = () => editor.current?.innerHTML ?? '';

  const save = React.useCallback(async (): Promise<string | null> => {
    if (!canDraft || scheduled) return draftRef.current;
    if (savingNow.current) await savingNow.current;
    if (!dirty.current) return draftRef.current;
    dirty.current = false;
    setSaveState('saving');
    const run = (async () => {
      const res = await postJson('/api/inbox/drafts', {
        action: 'save',
        draftId: draftRef.current,
        to,
        cc,
        bcc,
        subject,
        html: html(),
        threadId: seed.threadId ?? null,
      });
      if (!res.ok) {
        setSaveState('failed');
        return draftRef.current;
      }
      const data = (await res.json()) as { draftId: string };
      draftRef.current = data.draftId;
      setDraftId(data.draftId);
      setSaveState('saved');
      onDraftSaved?.();
      return data.draftId;
    })();
    savingNow.current = run;
    try {
      return await run;
    } finally {
      savingNow.current = null;
    }
  }, [canDraft, scheduled, to, cc, bcc, subject, seed.threadId, onDraftSaved]);

  const saveRef = React.useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const changed = React.useCallback(() => {
    if (closed.current) return;
    dirty.current = true;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
  }, []);

  // Recipients and subject changes save too (the body calls `changed` itself).
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    changed();
  }, [to, cc, bcc, subject, changed]);

  React.useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const recipients = () => [...splitTokens(to), ...splitTokens(cc), ...splitTokens(bcc)];

  const check = (): string | null => {
    const all = recipients();
    if (all.length === 0) return 'Add at least one recipient.';
    const bad = all.find((t) => !ADDRESS.test(addressIn(t)));
    if (bad) return `“${bad}” is not an email address.`;
    if (isBlankHtml(html()) && !seed.forwardOf && !seed.attachMessage) {
      return 'Write the email first.';
    }
    return null;
  };

  const payload = async () => ({
    to: splitTokens(to).map(addressIn).join(', '),
    cc: splitTokens(cc).map(addressIn).join(', '),
    bcc: splitTokens(bcc).map(addressIn).join(', '),
    subject,
    html: html(),
    signature,
    threadId: seed.threadId ?? null,
    forwardOf: seed.forwardOf ?? null,
    attachMessage: seed.attachMessage
      ? { threadId: seed.attachMessage.threadId, messageId: seed.attachMessage.messageId }
      : null,
  });

  const finish = (what: 'sent' | 'scheduled' | 'discarded' | 'cancelled') => {
    closed.current = true;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    onDone(what);
  };

  const send = React.useCallback(async () => {
    setSending(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (savingNow.current) await savingNow.current;
      const body = await payload();
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          type: f.type || 'application/octet-stream',
          data: await readAsBase64(f),
        })),
      );
      const res = scheduled
        ? await postJson('/api/inbox/scheduled', {
            action: 'sendNow',
            id: seed.scheduledId,
            ...body,
          })
        : await postJson('/api/inbox/compose', { ...body, draftId: draftRef.current, attachments });
      if (res.ok) {
        toast.success('Message sent');
        finish('sent');
      } else {
        toast.error(await errorMessage(res, 'It did not send. Try again.'));
      }
    } catch {
      toast.error('It did not send. Try again.');
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, signature, files, scheduled, seed]);

  // The send fires from the last tick itself; the ref always holds the newest send.
  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const startSend = () => {
    const problem = check();
    if (problem) {
      toast.error(problem);
      return;
    }
    let left = undoFor;
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

  /** A person picked a time: that pick is the send decision, made once. */
  const schedule = async (at: Date) => {
    if (!env.scheduleReady) {
      toast.error(SCHEDULE_NOT_SET_UP);
      return;
    }
    const problem = check();
    if (problem) {
      toast.error(problem);
      return;
    }
    if (files.length || seed.attachMessage) {
      toast.error('Attachments cannot be scheduled from here yet. Send it now, or remove them.');
      return;
    }
    const sendAt = at.toISOString();
    setSending(true);
    try {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (savingNow.current) await savingNow.current;
      const body = await payload();
      const res = await postJson('/api/inbox/scheduled', {
        action: scheduled ? 'update' : 'schedule',
        id: seed.scheduledId ?? undefined,
        sendAt,
        // The Gmail draft this window was saving to goes to Trash once it is scheduled.
        draftId: draftRef.current,
        ...body,
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, 'It was not scheduled. Try again.'));
        return;
      }
      const data = (await res.json()) as { id: string };
      const when = formatWake(at, readerZone(env.timeZone));
      toast.success(`Send scheduled for ${when}`, {
        description: sendWindowNote(at),
        action: scheduled
          ? undefined
          : {
              label: 'Undo',
              onClick: () =>
                void postJson('/api/inbox/scheduled', { action: 'cancel', id: data.id }).then(
                  async (r) =>
                    r.ok
                      ? toast.success('Scheduled send cancelled. It is in Drafts.')
                      : toast.error(await errorMessage(r, 'Could not cancel it.')),
                ),
            },
      });
      finish('scheduled');
    } finally {
      setSending(false);
    }
  };

  const cancelScheduled = async () => {
    setSending(true);
    const res = await postJson('/api/inbox/scheduled', {
      action: 'cancel',
      id: seed.scheduledId,
    });
    setSending(false);
    if (!res.ok) {
      toast.error(await errorMessage(res, 'Could not cancel it. Try again.'));
      return;
    }
    toast.success('Send cancelled. It is in Drafts.');
    finish('cancelled');
  };

  const discard = async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    closed.current = true;
    if (savingNow.current) await savingNow.current;
    const id = draftRef.current;
    if (id && canDraft) {
      const res = await postJson('/api/inbox/drafts', { action: 'discard', draftId: id });
      if (!res.ok) {
        toast.error(await errorMessage(res, 'Could not discard it; it stays in Drafts.'));
        onDone('discarded');
        return;
      }
      toast.success(env.demo ? 'Draft discarded' : 'Draft discarded (in Trash)', {
        action: env.demo
          ? {
              label: 'Undo',
              onClick: () => void fetch(`/api/inbox/drafts?id=${encodeURIComponent(id)}&restore=1`),
            }
          : undefined,
      });
    }
    onDone('discarded');
  };

  /** Close keeps the words: a last save to Drafts, as Gmail does. */
  const close = async () => {
    if (pending) undo();
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const hasWords = !isBlankHtml(html()) || recipients().length > 0 || subject.trim() !== '';
    if (dirty.current && hasWords && canDraft && !scheduled) {
      const saved = await save();
      if (saved) toast.success('Saved to Drafts');
    }
    closed.current = true;
    onClose();
  };
  const closeRef = React.useRef(close);
  React.useEffect(() => {
    closeRef.current = close;
  });

  /** Hand the words, the draft and the thread to a floating window; this box closes. */
  const popOut = async () => {
    if (!onPopOut) return;
    if (pending) undo();
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    if (savingNow.current) await savingNow.current;
    // Unsaved words go to the draft first, so the window opens on a saved draft.
    if (dirty.current) await save();
    closed.current = true;
    onPopOut({
      ...seed,
      key: `pop-${seed.key}-${Date.now()}`,
      to,
      cc,
      bcc,
      subject,
      html: html(),
      draftId: draftRef.current,
      signature,
    });
  };

  const copy = async () => {
    const text = editor.current?.innerText ?? '';
    const head = `To: ${to}\n${cc ? `Cc: ${cc}\n` : ''}Subject: ${subject}`;
    try {
      await navigator.clipboard.writeText(`${head}\n\n${text}`);
      toast.success('Copied. Paste it into Gmail.');
    } catch {
      toast.error('Could not copy. Select the text and copy it.');
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    if (next.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) {
      toast.error('Attachments can be 7 MB in all from here. Attach bigger files in Gmail.');
      return;
    }
    setFiles(next);
  };

  const busy = pending || sending;
  const sendLabel = scheduled ? 'Send now' : 'Send';

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          if (env.canSend && !busy) startSend();
        } else if (e.key === 'Escape' && !inline) {
          // A menu inside handles its own Escape first.
          if (e.defaultPrevented) return;
          e.preventDefault();
          void closeRef.current();
        }
      }}
    >
      {inline && onPopOut ? (
        <button
          type="button"
          aria-label="Pop out reply"
          title="Pop out reply"
          disabled={busy}
          onClick={() => void popOut()}
          className="absolute top-1 right-1.5 grid size-7 place-items-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {scheduled && seed.sendAt ? (
        <p className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--accent)]">
          <Clock className="size-3.5" aria-hidden />
          Scheduled for {formatWake(seed.sendAt, readerZone(env.timeZone))}. Edit it, pick a new
          time, send it now, or cancel it.
        </p>
      ) : null}
      <RecipientField
        id={`${uid}-to`}
        label={inline ? 'To' : 'To'}
        value={to}
        onChange={setTo}
        disabled={busy}
        trailing={
          <span className="flex shrink-0 gap-1 text-sm text-[var(--fg-muted)]">
            {!showCc ? (
              <button type="button" onClick={() => setShowCc(true)} className="hover:underline">
                Cc
              </button>
            ) : null}
            {!showBcc ? (
              <button type="button" onClick={() => setShowBcc(true)} className="hover:underline">
                Bcc
              </button>
            ) : null}
          </span>
        }
      />
      {showCc ? (
        <RecipientField id={`${uid}-cc`} label="Cc" value={cc} onChange={setCc} disabled={busy} />
      ) : null}
      {showBcc ? (
        <RecipientField
          id={`${uid}-bcc`}
          label="Bcc"
          value={bcc}
          onChange={setBcc}
          disabled={busy}
        />
      ) : null}
      {!inline ? (
        <div className="flex items-center border-b border-[var(--border)] px-3">
          <label htmlFor={`${uid}-subject`} className="sr-only">
            Subject
          </label>
          <input
            id={`${uid}-subject`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={busy}
            placeholder="Subject"
            className="h-9 w-full bg-transparent text-sm text-[var(--fg)] placeholder:text-[var(--fg-muted)] focus-visible:outline-none"
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div
          ref={editor}
          id={`${uid}-body`}
          role="textbox"
          aria-multiline="true"
          aria-label={inline ? (seed.mode === 'forward' ? 'Forward' : 'Reply') : 'Message Body'}
          contentEditable={!busy}
          suppressContentEditableWarning
          onInput={changed}
          className={cn(
            'min-h-40 text-sm leading-relaxed break-words text-[var(--fg)] focus-visible:outline-none [&_a]:text-[var(--accent)] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6',
            inline && 'min-h-28',
          )}
        />
        {seed.forwardNames?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {seed.forwardNames.map((a) => (
              <span
                key={a}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs"
              >
                <Paperclip className="size-3" aria-hidden /> {a}
                <span className="text-[var(--fg-subtle)]">forwarded</span>
              </span>
            ))}
          </div>
        ) : null}
        {seed.attachMessage ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs">
              <Paperclip className="size-3" aria-hidden /> {seed.attachMessage.name}
              <span className="text-[var(--fg-subtle)]">attached email</span>
            </span>
          </div>
        ) : null}
        {files.length ? (
          <ul className="mt-2 space-y-1" aria-label="Attachments">
            {files.map((f, i) => (
              <li
                key={`${f.name}|${i}`}
                className="flex items-center gap-2 rounded bg-[var(--bg-sunken)] px-2 py-1 text-xs"
              >
                <Paperclip className="size-3" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="text-[var(--fg-subtle)]">
                  {f.size < 1024 * 1024
                    ? `${Math.max(1, Math.round(f.size / 1024))} KB`
                    : `${(f.size / 1024 / 1024).toFixed(1)} MB`}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  className="rounded p-0.5 hover:bg-[var(--bg-hover)]"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="border-t border-[var(--border)] px-2 py-1">
        <FormatBar editor={editor} disabled={busy} onChange={changed} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {!env.canSend ? (
          <>
            {env.gmailHref ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => window.open(env.gmailHref!, '_blank', 'noopener')}
              >
                <Send className="size-4" aria-hidden /> Send in Gmail
              </Button>
            ) : null}
            <Button size="sm" onClick={copy}>
              <Copy className="size-4" aria-hidden /> Copy for Gmail
            </Button>
            {env.demo && env.scheduleReady ? (
              <ScheduleMenu timeZone={env.timeZone} ready onSchedule={(at) => void schedule(at)}>
                <Button size="sm" variant="secondary">
                  <Clock className="size-4" aria-hidden /> Schedule (demo)
                </Button>
              </ScheduleMenu>
            ) : null}
            <span className="text-xs text-[var(--fg-muted)]">
              {env.demo ? 'Demo: nothing is sent.' : 'Sending from the app isn’t turned on.'}
            </span>
          </>
        ) : pending ? (
          <>
            <span className="text-sm text-[var(--fg-muted)]" aria-live="polite">
              Sending in {countdown}s…
            </span>
            <Button size="sm" variant="secondary" onClick={undo}>
              <Undo2 className="size-4" aria-hidden /> Undo
            </Button>
          </>
        ) : (
          <span className="inline-flex">
            <Button
              size="sm"
              variant="primary"
              onClick={startSend}
              disabled={sending}
              className="rounded-r-none"
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              {sendLabel}
            </Button>
            <ScheduleMenu
              timeZone={env.timeZone}
              ready={env.scheduleReady}
              onSchedule={(at) => void schedule(at)}
              disabled={sending}
            >
              <Button
                size="sm"
                variant="primary"
                aria-label="More send options"
                title="Schedule send"
                className="rounded-l-none border-l border-[var(--primary-fg)]/30 px-1.5"
              >
                <ChevronDown className="size-4" aria-hidden />
              </Button>
            </ScheduleMenu>
          </span>
        )}
        {!scheduled ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              disabled={busy || !env.canSend}
              onClick={() => fileInput.current?.click()}
              className={TOOL}
            >
              <Paperclip className="size-4" aria-hidden />
            </button>
            <TemplatesMenu
              disabled={busy}
              className={TOOL}
              current={() => ({ subject, html: html() })}
              onInsert={(t) => {
                // Gmail's Insert template: the subject when there is none yet, the body at the cursor.
                if (!subject.trim() && t.subject) setSubject(t.subject);
                const box = editor.current;
                if (!box) return;
                box.focus();
                if (isBlankHtml(box.innerHTML)) box.innerHTML = t.html;
                else document.execCommand('insertHTML', false, t.html);
                changed();
              }}
            />
          </>
        ) : null}
        <span className="flex items-center gap-1 text-xs">
          <span className="text-[var(--fg-muted)]">Sign as</span>
          {(['nick', 'arwin'] as Signature[]).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={signature === s}
              disabled={busy}
              onClick={() => setSignature(s)}
              className={cn(
                'rounded-full px-2 py-0.5',
                signature === s
                  ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                  : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
              )}
            >
              {s === 'nick' ? 'Nick' : 'Arwin'}
            </button>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span className="text-xs text-[var(--fg-subtle)]" aria-live="polite">
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Draft saved'
                : saveState === 'failed'
                  ? 'Not saved'
                  : ''}
          </span>
          {scheduled ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void cancelScheduled()}
              disabled={busy}
            >
              Cancel send
            </Button>
          ) : (
            <button
              type="button"
              aria-label={draftId ? 'Discard draft' : 'Discard'}
              title="Discard draft"
              disabled={busy}
              onClick={() => void discard()}
              className={TOOL}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          )}
        </span>
      </div>
      <p className="px-3 pb-2 text-[11px] text-[var(--fg-subtle)]">
        {signature === 'nick' ? 'Nick’s' : 'Arwin’s'} real Gmail signature is added when it sends.
        Ctrl+Enter sends · {undoFor}s to undo.
      </p>
    </div>
  );
}

/**
 * Gmail's compose window, bottom right: minimise to its title bar, full
 * screen, and close (which keeps the words in Drafts). Several can be open
 * side by side; on a phone each fills the screen, as the Gmail app does.
 */
export function ComposeWindow({
  seed,
  env,
  slot,
  onDone,
  onClose,
  onDraftSaved,
}: {
  seed: ComposeSeed;
  env: ComposeEnv;
  /** Its place from the right, for side-by-side windows. */
  slot: number;
  onDone: (what: 'sent' | 'scheduled' | 'discarded' | 'cancelled') => void;
  onClose: () => void;
  onDraftSaved?: () => void;
}) {
  const [mode, setMode] = React.useState<'open' | 'min' | 'full'>('open');
  const [subject, setSubject] = React.useState(seed.subject);
  const closeRef = React.useRef<(() => void) | null>(null);
  const title =
    subject.trim() ||
    (seed.mode === 'scheduled'
      ? 'Scheduled message'
      : seed.mode === 'forward'
        ? 'Forward'
        : seed.mode === 'reply' || seed.mode === 'replyAll'
          ? 'Reply'
          : 'New Message');
  // On a wide screen windows sit side by side from the right, Gmail's 16px apart.
  const right = `calc(1.5rem + ${slot} * (min(34rem, 100vw - 3rem) + 1rem))`;
  return (
    <>
      {mode === 'full' ? (
        <div
          className="fixed inset-0 z-[var(--z-header)] bg-[var(--scrim)]"
          aria-hidden
          onClick={() => setMode('open')}
        />
      ) : null}
      <div
        role="dialog"
        aria-label={title}
        style={mode === 'full' ? undefined : ({ '--compose-right': right } as React.CSSProperties)}
        className={cn(
          'fixed z-[var(--z-header)] flex flex-col border border-[var(--border-strong)] bg-[var(--bg-overlay)] shadow-2xl',
          mode === 'full'
            ? 'inset-4 rounded-[var(--radius-card)] sm:inset-x-[8vw] sm:inset-y-[6vh]'
            : mode === 'min'
              ? 'right-[var(--compose-right)] bottom-0 w-64 rounded-t-[var(--radius-card)] max-sm:right-2'
              : 'inset-0 pt-[var(--titlebar-h)] sm:inset-auto sm:right-[var(--compose-right)] sm:bottom-0 sm:h-[min(36rem,85dvh)] sm:w-[min(34rem,calc(100vw-3rem))] sm:rounded-t-[var(--radius-card)] sm:pt-0',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-1 bg-[var(--bg-sunken)] px-3 py-2',
            mode !== 'full' && 'sm:rounded-t-[var(--radius-card)]',
          )}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
            onClick={() => setMode(mode === 'min' ? 'open' : 'min')}
          >
            {title}
          </button>
          <button
            type="button"
            aria-label={mode === 'min' ? 'Restore' : 'Minimize'}
            title={mode === 'min' ? 'Restore' : 'Minimize'}
            onClick={() => setMode(mode === 'min' ? 'open' : 'min')}
            className="hidden rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] sm:block"
          >
            <Minus className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={mode === 'full' ? 'Exit full screen' : 'Full screen'}
            title={mode === 'full' ? 'Exit full screen' : 'Full screen'}
            onClick={() => setMode(mode === 'full' ? 'open' : 'full')}
            className="hidden rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] sm:block"
          >
            {mode === 'full' ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label="Save & close"
            title="Save & close"
            onClick={() => closeRef.current?.()}
            className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className={cn('flex min-h-0 flex-1 flex-col', mode === 'min' && 'hidden')}>
          <ComposeFormWithClose
            seed={seed}
            env={env}
            onDone={onDone}
            onClose={onClose}
            onDraftSaved={onDraftSaved}
            closeRef={closeRef}
            onSubject={setSubject}
          />
        </div>
      </div>
    </>
  );
}

/** The form, with its close reachable from the window's own × and its subject shown in the title. */
function ComposeFormWithClose({
  closeRef,
  onSubject,
  ...props
}: React.ComponentProps<typeof ComposeForm> & {
  closeRef: React.RefObject<(() => void) | null>;
  onSubject: (subject: string) => void;
}) {
  const wrapper = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    closeRef.current = () => {
      // The form's own Escape path saves and closes.
      wrapper.current
        ?.querySelector<HTMLElement>('[role="textbox"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };
  }, [closeRef]);
  return (
    <div
      ref={wrapper}
      className="flex min-h-0 flex-1 flex-col"
      onInput={(e) => {
        const t = e.target as HTMLInputElement;
        if (t.placeholder === 'Subject') onSubject(t.value);
      }}
    >
      <ComposeForm {...props} />
    </div>
  );
}
