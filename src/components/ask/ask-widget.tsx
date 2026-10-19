'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { ChevronLeft, Maximize2, MessageCircleMore, Plus, RotateCw, X } from 'lucide-react';
import { askFromWidgetAction, type WidgetAskResult } from '@/app/actions/ask';
import type { ActionResult } from '@/app/actions';
import { AskComposer, ConversationMessage, WorkingMessage } from '@/components/ask/message-parts';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  ASK_FULL_PAGE_ATTR,
  ASK_QUERY_PARAM,
  askRequestFromHref,
  askRequestFromParam,
  type AskRequest,
} from '@/lib/chat/ask-link';
import { replyAnnouncement, replyArrival } from '@/lib/chat/reply-notice';
import {
  THREAD_STATUS_LABEL,
  historyLine,
  startedLabel,
  type ThreadStatus,
  type ThreadSummary,
} from '@/lib/chat/thread-summary';
import { ignoreTitleBarPointer } from '@/lib/desktop/title-bar';
import type { ChatMessage } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { snippet } from '@/lib/util/text';
import {
  ASK_OPEN_EVENT,
  ASK_PANEL_EVENT,
  ASK_WATCH_EVENT,
  openAskWidget,
  type AskPanelDetail,
  type AskWatchDetail,
} from './ask-events';
import { ReplyNoticeCard } from './reply-notice';
import { useReplyNotices } from './use-reply-notices';

/**
 * Ask Arwin: the assistant as a floating chat on every signed-in page.
 *
 * A launcher in the bottom-right corner (above the phone tab bar) opens a
 * panel with two views: the history of past conversations, and one
 * conversation with the composer. It runs on the same chat service as the
 * full Ask page, which stays as the fallback for deep links and long answers.
 *
 * In production an answer arrives asynchronously (a cloud routine answers via
 * Slack, usually within a couple of minutes), so a conversation with an answer
 * on its way polls until it lands, exactly as the Ask page does. The poll
 * carries on with the panel closed, and for a conversation left for another
 * one (or a question left waiting on the full Ask page). An answer that lands
 * out of sight marks the launcher with a gold dot and pops up "Arwin replied"
 * above it for a few seconds (components/ask/reply-notice.tsx; the rules are
 * in lib/chat/reply-notice.ts).
 *
 * `/ask` links anywhere in the app ("Ask about today", a deal's "IC memo")
 * open the widget instead of navigating, and any page opens it with
 * `?ask=<question>` or `openAskWidget()`. Without script those links are
 * still the full page.
 *
 * The panel is modal at every size, under a scrim: the page is inert while it
 * is open, and keys typed in it never reach the page's own shortcuts (the
 * Inbox's Gmail keys, the email session's Ctrl+Enter send). An answer that
 * lands is announced to a screen reader, panel open or closed.
 */

const POLL_MS = 4_000;
const HISTORY_POLL_MS = 8_000;
/** Starters for a conversation scoped to one deal; the scope names the deal. */
const DEAL_SUGGESTIONS = [
  'Give me a 30-second overview.',
  'What are the risks and open questions?',
] as const;
const PENDING_HINT = 'Answers usually take a minute or two. You can close this; it keeps checking.';
/** How long an "Arwin answered" announcement stays in its live region. */
const ANNOUNCE_MS = 10_000;
/** A conversation not on screen is checked this often while its answer is on the way. */
const BACKGROUND_POLL_MS = 8_000;
/**
 * With the tab hidden every check slows to this rather than stopping, so an
 * answer that lands still puts "(1)" in the tab's title.
 */
const HIDDEN_POLL_MS = 30_000;
/** An answer later than this is left to the history list. */
const WATCH_MAX_MS = 30 * 60_000;

interface DealScope {
  id: string;
  /** Null until it has been looked up. */
  name: string | null;
}

interface Conversation {
  /** Changes whenever a different conversation is put on screen. */
  key: number;
  threadId: string | null;
  deal: DealScope | null;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
}

interface HistoryState {
  threads: ThreadSummary[] | null;
  loading: boolean;
  error: string | null;
}

interface ThreadPayload {
  thread: { id: string } | null;
  messages: ChatMessage[];
  deal: { id: string; name: string } | null;
}

/** A conversation with an answer on its way, and since when (ms). */
type Watched = Map<string, number>;

function emptyConversation(key: number, deal: DealScope | null = null): Conversation {
  return { key, threadId: null, deal, messages: [], loading: false, error: null };
}

function isPendingAnswer(m: ChatMessage): boolean {
  return m.role === 'assistant' && m.status === 'pending';
}

/** "Arwin answered: <its first line>" when a conversation ends on an answer. */
function answerAnnouncement(messages: readonly ChatMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || last.status === 'pending') return null;
  const first =
    last.content
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  return first ? `Arwin answered: ${snippet(first, 160)}` : 'Arwin answered.';
}

export function AskWidget({
  aiAvailable,
  timeZone,
  suggestions,
}: {
  /** Decided on the server, by the Ask page's own rule. */
  aiAvailable: boolean;
  /** The reader's profile timezone, for "Started Oct 12 at 10:12 AM". */
  timeZone: string;
  suggestions: readonly string[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  // The full page is already the conversation there; a launcher over its
  // composer would only cover the Ask button.
  const onAskPage = pathname === '/ask' || pathname.startsWith('/ask/');

  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<'home' | 'thread'>('home');
  const [history, setHistory] = React.useState<HistoryState>({
    threads: null,
    loading: false,
    error: null,
  });
  const [conv, setConv] = React.useState<Conversation>(() => emptyConversation(0));
  const [question, setQuestion] = React.useState('');
  const [sending, startSending] = React.useTransition();
  /** The conversation whose answer landed unseen: the launcher's gold dot. */
  const [unreadThread, setUnreadThread] = React.useState<string | null>(null);
  const unread = unreadThread !== null;
  const [announcement, setAnnouncement] = React.useState('');
  /** How many conversations are being checked for an answer; see `watchRef`. */
  const [watching, setWatching] = React.useState(0);
  const greetingHidden = React.useSyncExternalStore(
    subscribeGreeting,
    readGreetingDismissed,
    () => true,
  );

  // Read only from callbacks: async results check they still belong to what
  // is on screen, and the poll checks whether anyone is looking.
  const convKey = React.useRef(0);
  const openRef = React.useRef(false);
  const waitingRef = React.useRef(false);
  const viewRef = React.useRef(view);
  const convThreadRef = React.useRef<string | null>(null);
  const onAskPageRef = React.useRef(onAskPage);
  /** Every conversation with an answer on its way, shown or not. */
  const watchRef = React.useRef<Watched>(new Map());
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const newButtonRef = React.useRef<HTMLButtonElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  /**
   * A half-typed follow-up per conversation, kept while another one is on
   * screen (the "Arwin replied" card can switch conversations mid-sentence),
   * and put back when Nick returns to it.
   */
  const draftsRef = React.useRef(new Map<string, string>());

  const hasPending = conv.messages.some(isPendingAnswer);

  React.useEffect(() => {
    openRef.current = open;
  }, [open]);
  React.useEffect(() => {
    waitingRef.current = hasPending;
  }, [hasPending]);
  React.useEffect(() => {
    viewRef.current = view;
  }, [view]);
  React.useEffect(() => {
    convThreadRef.current = conv.threadId;
  }, [conv.threadId]);
  React.useEffect(() => {
    onAskPageRef.current = onAskPage;
  }, [onAskPage]);

  /* ------------------------------------------------------ answers landing */

  /**
   * The conversation in front of Nick: the one open in the panel, or with the
   * panel closed the one the full Ask page shows.
   */
  const onScreenThreadId = React.useCallback((): string | null => {
    if (openRef.current) return viewRef.current === 'thread' ? convThreadRef.current : null;
    if (!onAskPageRef.current) return null;
    try {
      return new URLSearchParams(window.location.search).get('thread');
    } catch {
      return null;
    }
  }, []);
  const {
    notice: replyNotice,
    arrive: arriveReply,
    dismiss: dismissReply,
    viewed: viewedReply,
  } = useReplyNotices(onScreenThreadId);

  /** Start (`since`) or stop (null) checking a conversation for its answer. */
  const setWatch = React.useCallback((threadId: string, since: number | null) => {
    const map = watchRef.current;
    if (since !== null) {
      if (map.has(threadId)) return;
      map.set(threadId, since);
    } else if (!map.delete(threadId)) {
      return;
    }
    writeWatched(map);
    setWatching(map.size);
  }, []);

  // A read, up here because an answer landing refreshes the history too.
  const loadHistory = React.useCallback(async (quiet = false) => {
    if (!quiet) setHistory((h) => ({ ...h, loading: true, error: null }));
    const result = await getJson<{ threads: ThreadSummary[] }>('/api/ask/threads');
    setHistory((h) => {
      if (result.ok) return { threads: result.data.threads, loading: false, error: null };
      // A failed background poll keeps what is on screen.
      return quiet ? h : { threads: h.threads, loading: false, error: result.message };
    });
  }, []);

  /**
   * A conversation's answer is in. Announced in place when it is on screen;
   * anywhere else it marks the launcher and gets the "Arwin replied" pop-up.
   */
  const noteLanded = React.useCallback(
    (threadId: string, messages: readonly ChatMessage[], onScreen = false) => {
      setWatch(threadId, null);
      const arrival = replyArrival(threadId, messages, Date.now());
      if (!arrival) return;
      const outcome = arriveReply(arrival, { onScreen });
      if (outcome === 'on-screen') {
        const said = answerAnnouncement(messages);
        if (said) setAnnouncement(said);
      } else if (outcome !== 'seen') {
        setUnreadThread(threadId);
        // Seen from the history list: it catches up, so the conversation the
        // pop-up names is there to open too.
        if (openRef.current && viewRef.current === 'home') void loadHistory(true);
      }
    },
    [arriveReply, loadHistory, setWatch],
  );

  /**
   * A conversation was opened on the full Ask page (from the pop-up, or its
   * Recent list): the launcher's dot no longer points at it.
   */
  const markThreadSeen = React.useCallback(
    (threadId: string) => {
      viewedReply(threadId);
      setUnreadThread((u) => (u === threadId ? null : u));
    },
    [viewedReply],
  );

  // The guided tour waits while the panel is open (see ASK_PANEL_EVENT).
  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent<AskPanelDetail>(ASK_PANEL_EVENT, { detail: { open } }));
  }, [open]);

  React.useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(''), ANNOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  // A link followed from inside the panel (a citation, a record) goes to a
  // page Nick wants to see, so the panel gets out of the way.
  const [shownPath, setShownPath] = React.useState(pathname);
  if (pathname !== shownPath) {
    setShownPath(pathname);
    if (open) setOpen(false);
  }

  /* ---------------------------------------------------------------- reads */

  const loadThread = React.useCallback(
    async (threadId: string, key: number, quiet = false) => {
      const result = await getJson<ThreadPayload>(
        `/api/ask/thread?id=${encodeURIComponent(threadId)}`,
      );
      if (convKey.current !== key) return;
      if (!result.ok) {
        if (!quiet) setConv((c) => ({ ...c, loading: false, error: result.message }));
        return;
      }
      const data = result.data;
      if (data.messages.some(isPendingAnswer)) setWatch(threadId, Date.now());
      else if (watchRef.current.has(threadId)) noteLanded(threadId, data.messages);
      setConv((c) =>
        c.key !== key
          ? c
          : {
              ...c,
              threadId,
              deal: data.deal ?? c.deal,
              messages: data.messages,
              loading: false,
              error: null,
            },
      );
    },
    [noteLanded, setWatch],
  );

  const loadDeal = React.useCallback(async (dealId: string, key: number) => {
    const result = await getJson<ThreadPayload>(
      `/api/ask/thread?deal=${encodeURIComponent(dealId)}`,
    );
    if (convKey.current !== key || !result.ok || !result.data.deal) return;
    const deal = result.data.deal;
    setConv((c) => (c.key === key ? { ...c, deal: { id: deal.id, name: deal.name } } : c));
  }, []);

  /* ------------------------------------------------------------- actions */

  /** The conversation on screen is being swapped out: its draft is kept. */
  function keepDraft() {
    const threadId = conv.threadId;
    if (!threadId) return;
    if (question.trim()) draftsRef.current.set(threadId, question);
    else draftsRef.current.delete(threadId);
  }

  function startConversation(dealId: string | null): number {
    keepDraft();
    const key = ++convKey.current;
    setConv(emptyConversation(key, dealId ? { id: dealId, name: null } : null));
    setQuestion('');
    setView('thread');
    if (dealId) void loadDeal(dealId, key);
    return key;
  }

  function showThread(threadId: string) {
    keepDraft();
    const key = ++convKey.current;
    setConv({ ...emptyConversation(key), threadId, loading: true });
    setQuestion(draftsRef.current.get(threadId) ?? '');
    draftsRef.current.delete(threadId);
    setView('thread');
    viewedReply(threadId);
    setUnreadThread((u) => (u === threadId ? null : u));
    void loadThread(threadId, key);
  }

  function showHome() {
    setView('home');
    void loadHistory(history.threads !== null);
  }

  /**
   * After a question is sent, focus stays in the panel. The Ask button (or
   * the suggestion clicked) is disabled or gone at once, and focus left on
   * the page would hand the next keystrokes to the page's own shortcuts. With
   * a mouse or trackpad it goes back to the question box for a follow-up; on
   * a touch screen to the conversation, so no keyboard pops up over the answer.
   */
  const keepFocusInPanel = React.useCallback(() => {
    window.requestAnimationFrame(() => {
      const panel = contentRef.current;
      if (!panel) return;
      const active = document.activeElement;
      const stillUsable =
        active instanceof HTMLElement &&
        panel.contains(active) &&
        !(active as HTMLButtonElement).disabled;
      if (stillUsable) return;
      let fine = false;
      try {
        fine = window.matchMedia('(pointer: fine)').matches;
      } catch {
        // No media queries: the conversation is the safe place for focus.
      }
      const target = (fine ? composerRef.current : null) ?? scrollRef.current ?? panel;
      try {
        target.focus({ preventScroll: true });
      } catch {
        // Focus stays where it is.
      }
    });
  }, []);

  /** Returns false when the question could not be sent now. */
  function submit(
    text: string,
    target?: { key: number; threadId: string | null; dealId: string | null },
  ): boolean {
    const trimmed = text.trim();
    if (!trimmed || sending || !aiAvailable) return false;
    const key = target?.key ?? conv.key;
    const threadId = target ? target.threadId : conv.threadId;
    const dealId = target ? target.dealId : (conv.deal?.id ?? null);

    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      organization_id: '',
      thread_id: threadId ?? '',
      role: 'user',
      content: trimmed,
      citations: [],
      tool_calls: [],
      model: null,
      prompt_version: null,
      status: 'answered',
      created_at: new Date().toISOString(),
    };
    setConv((c) => (c.key === key ? { ...c, messages: [...c.messages, optimistic] } : c));
    setQuestion('');
    keepFocusInPanel();

    startSending(async () => {
      let result: ActionResult<WidgetAskResult>;
      try {
        result = await askFromWidgetAction(trimmed, {
          threadId: threadId ?? undefined,
          dealId: dealId ?? undefined,
        });
      } catch {
        result = {
          ok: false,
          error: { code: 'internal', message: 'That question could not be sent. Try again.' },
        };
      }
      const stillShown = convKey.current === key;
      if (result.ok && result.data) {
        const data = result.data;
        if (data.messages.some(isPendingAnswer)) {
          setWatch(data.threadId, Date.now());
        } else {
          // The demo and an in-app model answer within the request, which
          // may have outlasted the panel: Nick can close it while it runs.
          const onScreen = stillShown && openRef.current && viewRef.current === 'thread';
          noteLanded(data.threadId, data.messages, onScreen);
        }
        if (stillShown) {
          setConv((c) =>
            c.key !== key
              ? c
              : {
                  ...c,
                  threadId: data.threadId,
                  deal: data.deal ? { id: data.deal.id, name: data.deal.name } : c.deal,
                  messages: data.messages,
                },
          );
        }
        return;
      }
      if (stillShown) {
        setConv((c) =>
          c.key !== key ? c : { ...c, messages: c.messages.filter((m) => m.id !== optimistic.id) },
        );
        setQuestion(trimmed);
      }
      toast.error(result.error?.message ?? 'That question could not be answered', {
        description: result.error?.stillUsable,
      });
    });
    return true;
  }

  function openPanel(request?: AskRequest) {
    setOpen(true);
    const unseen = unreadThread;
    setUnreadThread(null);
    dismissGreeting();

    if (request?.threadId) {
      showThread(request.threadId);
      return;
    }
    if (request?.question || request?.dealId) {
      const dealId = request.dealId ?? null;
      const key = startConversation(dealId);
      if (request.question && !submit(request.question, { key, threadId: null, dealId })) {
        setQuestion(request.question);
      }
      return;
    }
    // An answer that landed while closed is shown, not just flagged.
    if (unseen && unseen === conv.threadId && !conv.error) {
      setView('thread');
      viewedReply(unseen);
      return;
    }
    if (unseen) {
      showThread(unseen);
      return;
    }
    // Reopened as it was left: the history refreshed, or the conversation
    // brought up to date (its poll may have stopped when the answer landed).
    if (view === 'home') void loadHistory(history.threads !== null);
    else if (conv.threadId && !hasPending) void loadThread(conv.threadId, conv.key, true);
  }

  /** The "Arwin replied" pop-up was clicked: its conversation, on screen. */
  function openFromNotice(threadId: string) {
    dismissReply();
    if (onAskPage) {
      // The full page shows conversations itself; opened there, it is read
      // (see AskPageThreadListener).
      markThreadSeen(threadId);
      router.push(`/ask?thread=${encodeURIComponent(threadId)}`, { scroll: false });
      return;
    }
    const ready = conv.threadId === threadId && !conv.loading && !conv.error;
    if (!open) {
      if (!ready) {
        openPanel({ threadId });
        return;
      }
      setOpen(true);
      setUnreadThread(null);
      dismissGreeting();
    }
    if (ready) {
      setView('thread');
      viewedReply(threadId);
      setUnreadThread((u) => (u === threadId ? null : u));
    } else {
      showThread(threadId);
    }
  }

  /** Where focus goes when the pop-up is closed from under it. */
  function focusAfterNotice() {
    if (open) focusForView();
    else launcherRef.current?.focus();
  }

  /* ------------------------------------------------------- outside entry */

  const onOpenRequest = React.useEffectEvent((request: AskRequest) => {
    if (!onAskPage) openPanel(request);
  });

  const onDocumentClick = React.useEffectEvent((event: MouseEvent) => {
    if (onAskPage || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
    if (anchor.closest(`[${ASK_FULL_PAGE_ATTR}]`)) return;
    const request = askRequestFromHref(anchor.href, window.location.href);
    if (!request) return;
    // Caught in the capture phase, before Next's <Link> sees the click; Link
    // leaves a click whose default is already prevented alone.
    event.preventDefault();
    openPanel(request);
  });

  // The full Ask page hands over a question it is waiting on.
  React.useEffect(() => {
    const handleWatch = (event: Event) => {
      const detail = (event as CustomEvent<AskWatchDetail | undefined>).detail;
      if (!detail?.threadId) return;
      setWatch(detail.threadId, detail.watching ? Date.now() : null);
    };
    window.addEventListener(ASK_WATCH_EVENT, handleWatch);
    // Conversations still waiting before a reload. Deferred a tick: picking
    // them up is a change like any other, not part of mounting.
    const timer = window.setTimeout(() => {
      for (const [threadId, since] of readWatched(Date.now())) setWatch(threadId, since);
    }, 0);
    return () => {
      window.removeEventListener(ASK_WATCH_EVENT, handleWatch);
      window.clearTimeout(timer);
    };
  }, [setWatch]);

  React.useEffect(() => {
    const handleOpen = (event: Event) =>
      onOpenRequest((event as CustomEvent<AskRequest | undefined>).detail ?? {});
    const handleClick = (event: MouseEvent) => onDocumentClick(event);
    window.addEventListener(ASK_OPEN_EVENT, handleOpen);
    window.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener(ASK_OPEN_EVENT, handleOpen);
      window.removeEventListener('click', handleClick, true);
    };
  }, []);

  /* ---------------------------------------------------------------- polls */

  React.useEffect(() => {
    if (!hasPending || !conv.threadId) return;
    const threadId = conv.threadId;
    const key = conv.key;
    let last = Date.now();
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (document.visibilityState === 'hidden' && now - last < HIDDEN_POLL_MS) return;
      last = now;
      void loadThread(threadId, key, true);
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [hasPending, conv.threadId, conv.key, loadThread]);

  /** One check of a watched conversation that is not the one being polled. */
  const checkThread = React.useCallback(
    async (threadId: string) => {
      if (threadId === convThreadRef.current) {
        // In the panel, just not polling: brought up to date there.
        void loadThread(threadId, convKey.current, true);
        return;
      }
      const result = await getJson<ThreadPayload>(
        `/api/ask/thread?id=${encodeURIComponent(threadId)}`,
      );
      if (!result.ok || !watchRef.current.has(threadId)) return;
      if (!result.data.messages.some(isPendingAnswer)) noteLanded(threadId, result.data.messages);
    },
    [loadThread, noteLanded],
  );

  // Every other conversation with an answer on its way: one asked before
  // starting another, or left waiting on the full Ask page.
  React.useEffect(() => {
    if (watching === 0) return;
    let last = 0;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const hidden = document.visibilityState === 'hidden';
      if (now - last < (hidden ? HIDDEN_POLL_MS : BACKGROUND_POLL_MS)) return;
      last = now;
      for (const [threadId, since] of watchRef.current) {
        if (now - since > WATCH_MAX_MS) {
          setWatch(threadId, null);
          continue;
        }
        // The conversation on screen with its answer on the way polls itself.
        if (threadId === convThreadRef.current && waitingRef.current) continue;
        void checkThread(threadId);
      }
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [watching, checkThread, setWatch]);

  const historyWaiting = history.threads?.some((t) => t.status === 'waiting') ?? false;
  React.useEffect(() => {
    if (!open || view !== 'home' || !historyWaiting) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void loadHistory(true);
    }, HISTORY_POLL_MS);
    return () => window.clearInterval(interval);
  }, [open, view, historyWaiting, loadHistory]);

  /* ----------------------------------------------------- focus and scroll */

  const focusForView = React.useCallback(() => {
    if (view === 'thread') (composerRef.current ?? closeRef.current)?.focus();
    else (newButtonRef.current ?? closeRef.current)?.focus();
  }, [view]);

  // Moving between the two views moves focus with it, so a keyboard user is
  // never left on a control that just disappeared.
  React.useEffect(() => {
    if (openRef.current) focusForView();
  }, [view, conv.key, focusForView]);

  // The latest question goes to the top of the view, not the end of its
  // answer: the question and the answer's first line (the direct answer) are
  // what Nick reads; a long answer's tail is what scrolling is for.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || view !== 'thread') return;
    const questions = el.querySelectorAll<HTMLElement>('[data-ask-question]');
    const latest = questions[questions.length - 1];
    el.scrollTop = latest ? latest.offsetTop - 12 : el.scrollHeight;
  }, [conv.messages.length, sending, view, open]);

  /* --------------------------------------------------------------- render */

  const fullPageHref =
    view === 'thread' && conv.threadId
      ? `/ask?thread=${encodeURIComponent(conv.threadId)}`
      : view === 'thread' && conv.deal
        ? `/ask?deal=${encodeURIComponent(conv.deal.id)}`
        : '/ask';
  const dealName = conv.deal ? (conv.deal.name ?? 'this deal') : null;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => (next ? openPanel() : setOpen(false))}
    >
      {onAskPage ? null : (
        // The wrapper lets clicks through its gaps; only the controls catch them.
        // It steps aside while any other dialog is open: the inbox composer
        // docks into this same corner, with Send at its bottom right.
        <div className="pointer-events-none fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)] z-[var(--z-nav)] flex items-center gap-2 lg:right-6 lg:bottom-6 [:root:has([role=dialog]:not([data-ask-panel]):not([data-tour-card]))_&]:hidden">
          {/* Above the launcher, its right edge on the launcher's: never over
              the launcher itself, and above the phone tab bar with it. */}
          {replyNotice && !open ? (
            <ReplyNoticeCard
              notice={replyNotice}
              placement="launcher"
              onOpen={openFromNotice}
              onDismiss={dismissReply}
              onFocusOut={focusAfterNotice}
              className="absolute right-0 bottom-full mb-3"
            />
          ) : null}

          {!greetingHidden && !open && !replyNotice ? (
            <div className="motion-safe:animate-rise pointer-events-auto flex items-center gap-2 motion-safe:[animation-delay:500ms]">
              <button
                type="button"
                onClick={dismissGreeting}
                aria-label="Dismiss greeting"
                title="Dismiss"
                className="shadow-lifted flex size-9 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-overlay)] text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:text-[var(--fg)]"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => openPanel()}
                data-tour="ask-greeting"
                className="shadow-lifted rounded-full border border-[var(--border-strong)] bg-[var(--bg-overlay)] px-4 py-2 text-sm font-medium whitespace-nowrap text-[var(--fg)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)]"
              >
                Hi. Need any help?
              </button>
            </div>
          ) : null}

          <DialogPrimitive.Trigger asChild>
            <button
              ref={launcherRef}
              type="button"
              aria-label={unread ? 'Ask Arwin, new answer' : 'Ask Arwin'}
              title="Ask Arwin"
              data-tour="ask-launcher"
              className="shadow-overlay pointer-events-auto relative flex size-14 items-center justify-center rounded-2xl bg-[var(--primary)] text-[var(--primary-fg)] ring-1 ring-[var(--gold)] transition-[background-color,transform] duration-[var(--motion-fast)] hover:bg-[var(--primary-hover)] active:scale-95"
            >
              {open ? (
                <X className="size-6" aria-hidden="true" />
              ) : (
                <MessageCircleMore className="size-6" aria-hidden="true" />
              )}
              {unread ? (
                <span
                  aria-hidden="true"
                  className="absolute -top-1 -right-1 size-3.5 rounded-full bg-[var(--gold)] ring-2 ring-[var(--bg)]"
                />
              ) : null}
            </button>
          </DialogPrimitive.Trigger>
        </div>
      )}

      <DialogPrimitive.Portal>
        {/* The panel is modal (the page is inert while it is open), so the
            page is dimmed at every size: a click outside closes the panel,
            and the scrim says so before anyone tries. */}
        <DialogPrimitive.Overlay
          data-ask-scrim=""
          className="motion-safe:animate-fade-in fixed inset-0 z-[var(--z-overlay)] bg-[var(--scrim)]"
        />
        <DialogPrimitive.Content
          ref={contentRef}
          data-ask-panel=""
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusForView();
          }}
          // Esc on the "Arwin replied" card dismisses the card, not the panel.
          // The dialog hears Esc first (on the document, in the capture phase),
          // so it is told to leave this one to the card's own handler.
          onEscapeKeyDown={(event) => {
            if (event.target instanceof Element && event.target.closest('[data-ask-reply]')) {
              event.preventDefault();
            }
          }}
          // Keys typed here are the panel's: none reaches a page shortcut on
          // `window` (Esc and Tab are handled by the dialog itself).
          onKeyDown={(event) => event.stopPropagation()}
          // Minimising or moving the desktop app's window leaves it open.
          onPointerDownOutside={ignoreTitleBarPointer}
          className={cn(
            'shadow-overlay motion-safe:animate-rise fixed z-[var(--z-overlay)] flex flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-overlay)] text-[var(--fg)]',
            // Phone, a phone on its side, or any short window: a sheet over
            // everything, inside the safe areas, never wider than a column.
            // (Below the desktop app's top bar, which is 0px high elsewhere.)
            'inset-x-2 top-[calc(max(0.5rem,var(--safe-top))+var(--titlebar-h))] bottom-[max(0.5rem,env(safe-area-inset-bottom))] mx-auto max-w-[40rem]',
            // Wide and tall enough: a panel above the launcher, which sits
            // above the tab bar.
            'panel-float:top-auto panel-float:right-4 panel-float:bottom-[calc(8.25rem+env(safe-area-inset-bottom))] panel-float:left-auto panel-float:h-[min(38rem,calc(100dvh-12.5rem-var(--titlebar-h)))] panel-float:w-[24rem]',
            // Desktop: above the corner launcher.
            'panel-float-lg:right-6 panel-float-lg:bottom-[6.25rem] panel-float-lg:h-[min(40rem,calc(100dvh-8.5rem-var(--titlebar-h)))] panel-float-lg:w-[25rem]',
          )}
        >
          {/* Announces an answer that lands while the panel is open. */}
          <div role="status" aria-live="polite" data-ask-announcer="" className="sr-only">
            {open ? announcement : ''}
          </div>
          <div role="status" aria-live="polite" data-ask-reply-announcer="" className="sr-only">
            {open && replyNotice ? replyAnnouncement(replyNotice) : ''}
          </div>
          <header className="dark relative flex shrink-0 items-center gap-3 bg-[var(--bg-sidebar)] px-4 py-3 text-[var(--fg)] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,transparent,var(--gold)_25%,var(--gold)_75%,transparent)]">
            <ArwinAvatar online={aiAvailable} />
            <div className="min-w-0 flex-1 leading-tight">
              <DialogPrimitive.Title className="text-title font-serif font-semibold">
                Ask Arwin
              </DialogPrimitive.Title>
              <p className="text-mini text-[var(--fg-muted)]">
                {aiAvailable ? 'Online' : 'Read only'}
              </p>
            </div>
            <DialogPrimitive.Description className="sr-only">
              Ask about email, deals, portfolio, tasks and calendar. Past conversations are listed
              here.
            </DialogPrimitive.Description>
            <Link
              href={fullPageHref}
              // ASK_FULL_PAGE_ATTR: the click catcher leaves this link alone.
              data-ask-full-page=""
              onClick={() => setOpen(false)}
              aria-label="Open full page"
              title="Open full page"
              className="flex size-9 items-center justify-center rounded-md text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Link>
            <DialogPrimitive.Close
              ref={closeRef}
              aria-label="Close"
              title="Close"
              className="flex size-9 items-center justify-center rounded-md text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            >
              <X className="size-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>

          {/* An answer to another conversation, while this one is open: the
              panel covers the launcher, so the pop-up shows in here. It
              floats over the top of the conversation rather than taking a
              place in it, so nothing under it jumps as it comes and goes. */}
          {replyNotice && open ? (
            <div className="relative z-10 h-0 shrink-0">
              <div className="absolute inset-x-3 top-3">
                <ReplyNoticeCard
                  notice={replyNotice}
                  placement="panel"
                  onOpen={openFromNotice}
                  onDismiss={dismissReply}
                  onFocusOut={focusAfterNotice}
                />
              </div>
            </div>
          ) : null}

          {view === 'home' ? (
            <>
              <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
                <HistoryList
                  history={history}
                  timeZone={timeZone}
                  onOpen={showThread}
                  onRetry={() => void loadHistory()}
                  suggestions={aiAvailable ? suggestions.slice(0, 3) : []}
                  onSuggestion={(s) => {
                    const key = startConversation(null);
                    submit(s, { key, threadId: null, dealId: null });
                  }}
                />
              </div>
              {aiAvailable ? (
                <div className="shrink-0 border-t border-[var(--border)] p-3">
                  <button
                    ref={newButtonRef}
                    type="button"
                    onClick={() => startConversation(null)}
                    className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
                  >
                    <Plus aria-hidden="true" />
                    New conversation
                  </button>
                </div>
              ) : (
                <p className="text-mini shrink-0 border-t border-[var(--border)] px-4 py-3 text-[var(--fg-muted)]">
                  Asking needs an AI provider, which is not connected. Past conversations are still
                  here to read.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
                <button
                  type="button"
                  onClick={showHome}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2')}
                >
                  <ChevronLeft aria-hidden="true" />
                  All conversations
                </button>
                {dealName ? (
                  <Badge tone="accent" className="ml-auto max-w-[45%] truncate">
                    About {dealName}
                  </Badge>
                ) : null}
              </div>

              <div
                ref={scrollRef}
                // Focusable, so focus has somewhere to stay after a question
                // is sent from a touch screen, and the arrow keys scroll it.
                tabIndex={-1}
                className="relative min-h-0 flex-1 scrollbar-thin overflow-y-auto p-3"
              >
                {conv.loading ? (
                  <WorkingMessage label="Opening the conversation…" compact />
                ) : conv.error ? (
                  <div className="space-y-2 text-sm text-[var(--fg-muted)]">
                    <p>{conv.error}</p>
                    {conv.threadId ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!conv.threadId) return;
                          setConv((c) => ({ ...c, loading: true, error: null }));
                          void loadThread(conv.threadId, conv.key);
                        }}
                        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                      >
                        <RotateCw aria-hidden="true" />
                        Try again
                      </button>
                    ) : null}
                  </div>
                ) : conv.messages.length === 0 && !sending ? (
                  <EmptyConversation
                    aiAvailable={aiAvailable}
                    dealName={dealName}
                    suggestions={
                      !aiAvailable ? [] : dealName ? DEAL_SUGGESTIONS : suggestions.slice(0, 4)
                    }
                    onSuggestion={(s) => submit(s)}
                  />
                ) : (
                  <ol className="space-y-3" aria-label="Conversation">
                    {conv.messages.map((message) => (
                      <li key={message.id} data-ask-question={message.role === 'user' || undefined}>
                        <ConversationMessage message={message} compact pendingHint={PENDING_HINT} />
                      </li>
                    ))}
                    {sending ? (
                      <li>
                        <WorkingMessage label="Searching your records…" compact />
                      </li>
                    ) : null}
                  </ol>
                )}
              </div>

              {aiAvailable ? (
                <AskComposer
                  className="shrink-0 border-t border-[var(--border)] p-2.5"
                  compact
                  textareaRef={composerRef}
                  value={question}
                  onChange={setQuestion}
                  onSubmit={(text) => void submit(text)}
                  pending={sending}
                  placeholder={dealName ? `Ask about ${dealName}…` : 'Ask Arwin anything…'}
                />
              ) : null}
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      {/* Announces an answer that lands while the panel is closed. Outside
          the panel, which hides the rest of the page from a screen reader
          while it is open. */}
      <div role="status" aria-live="polite" data-ask-announcer="" className="sr-only">
        {open ? '' : announcement}
      </div>
      <div role="status" aria-live="polite" data-ask-reply-announcer="" className="sr-only">
        {!open && replyNotice ? replyAnnouncement(replyNotice) : ''}
      </div>

      {/* The full Ask page has no launcher; the pop-up sits under its header,
          clear of the composer at the bottom. */}
      {onAskPage && replyNotice && !open ? (
        <div className="pointer-events-none fixed top-[calc(var(--app-header-h)+var(--app-banner-h)+0.75rem+var(--titlebar-h))] right-4 z-[var(--z-nav)] lg:top-[calc(var(--app-banner-h)+1rem+var(--titlebar-h))] lg:right-6">
          <ReplyNoticeCard
            notice={replyNotice}
            placement="page"
            onOpen={openFromNotice}
            onDismiss={dismissReply}
          />
        </div>
      ) : null}

      <React.Suspense fallback={null}>
        {onAskPage ? <AskPageThreadListener onShown={markThreadSeen} /> : <AskParamListener />}
      </React.Suspense>
    </DialogPrimitive.Root>
  );
}

/* ------------------------------------------------------------------ parts */

function ArwinAvatar({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--jewel)] font-serif text-lg font-semibold text-[var(--jewel-fg)] ring-1 ring-[var(--gold)]"
    >
      A
      {online ? (
        <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-[var(--accent)] ring-2 ring-[var(--bg-sidebar)]" />
      ) : null}
    </span>
  );
}

const STATUS_TONE: Record<ThreadStatus, NonNullable<BadgeProps['tone']>> = {
  answered: 'ok',
  waiting: 'info',
  unanswered: 'neutral',
};

function HistoryList({
  history,
  timeZone,
  onOpen,
  onRetry,
  suggestions,
  onSuggestion,
}: {
  history: HistoryState;
  timeZone: string;
  onOpen: (threadId: string) => void;
  onRetry: () => void;
  suggestions: readonly string[];
  onSuggestion: (question: string) => void;
}) {
  const { threads, loading, error } = history;

  if (!threads) {
    if (error) {
      return (
        <div className="space-y-2 p-4 text-sm text-[var(--fg-muted)]">
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <RotateCw aria-hidden="true" />
            Try again
          </button>
        </div>
      );
    }
    return (
      <ul aria-label="Loading past conversations" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex gap-3 border-b border-[var(--border)] px-4 py-3">
            <span className="skeleton size-8 shrink-0 rounded-md" />
            <span className="flex-1 space-y-2">
              <span className="skeleton block h-3 w-2/3 rounded" />
              <span className="skeleton block h-3 w-full rounded" />
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="px-4 py-6">
        <p className="text-sm font-medium">No conversations yet.</p>
        <p className="text-mini mt-1 text-[var(--fg-muted)]">
          Ask about email, deals, portfolio, tasks and calendar. Answers come from your records.
        </p>
        {suggestions.length > 0 ? (
          <SuggestionChips suggestions={suggestions} onPick={onSuggestion} className="mt-3" />
        ) : null}
      </div>
    );
  }

  return (
    <>
      {error ? (
        <p role="status" className="text-mini px-4 pt-2 text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      <ul aria-label="Past conversations" aria-busy={loading || undefined}>
        {threads.map((t) => {
          // The question leads, so each row says what it was about; the last
          // thing said and the start time are the quiet lines under it.
          const line = historyLine(t);
          return (
            <li key={t.id} className="border-b border-[var(--border)] last:border-b-0">
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                className="flex w-full gap-3 px-4 py-3 text-left transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] focus-visible:-outline-offset-2"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--jewel)] text-[var(--jewel-fg)]"
                >
                  <MessageCircleMore className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-note line-clamp-2 font-semibold">{t.title}</span>
                    <Badge tone={STATUS_TONE[t.status]} className="shrink-0">
                      {t.status === 'waiting' ? (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
                        />
                      ) : null}
                      {THREAD_STATUS_LABEL[t.status]}
                    </Badge>
                  </span>
                  {line ? (
                    <span className="text-mini mt-0.5 line-clamp-1 text-[var(--fg-muted)]">
                      <span className="font-medium text-[var(--fg)]">
                        {line.from === 'arwin' ? 'Arwin: ' : 'You: '}
                      </span>
                      {line.text}
                    </span>
                  ) : null}
                  <span className="text-micro mt-0.5 block text-[var(--fg-subtle)]">
                    {startedLabel(t.startedAt, timeZone)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function EmptyConversation({
  aiAvailable,
  dealName,
  suggestions,
  onSuggestion,
}: {
  aiAvailable: boolean;
  dealName: string | null;
  suggestions: readonly string[];
  onSuggestion: (question: string) => void;
}) {
  return (
    <div className="py-2">
      <p className="font-serif text-lg font-semibold">
        {dealName ? `What do you want to know about ${dealName}?` : 'What do you want to know?'}
      </p>
      <p className="text-mini mt-1 text-[var(--fg-muted)]">
        {aiAvailable
          ? 'One question, one direct answer, with the record it came from.'
          : 'Asking needs an AI provider, which is not connected.'}
      </p>
      {suggestions.length > 0 ? (
        <SuggestionChips suggestions={suggestions} onPick={onSuggestion} className="mt-3" />
      ) : null}
    </div>
  );
}

function SuggestionChips({
  suggestions,
  onPick,
  className,
}: {
  suggestions: readonly string[];
  onPick: (question: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="text-mini rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-left text-[var(--fg-muted)] transition-colors duration-[var(--motion-instant)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

/**
 * `?ask=<question>` on any page opens the widget with that question, then
 * drops the parameter so a reload does not ask again. Its own component for
 * the Suspense boundary `useSearchParams` wants.
 */
function AskParamListener() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(ASK_QUERY_PARAM);
  // Effects run twice in development; the same URL is handled once.
  const handled = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (value === null) {
      handled.current = null;
      return;
    }
    const signature = `${pathname}?${params.toString()}`;
    if (handled.current === signature) return;
    handled.current = signature;

    const request = askRequestFromParam(value);
    if (request) openAskWidget(request);
    const rest = new URLSearchParams(params.toString());
    rest.delete(ASK_QUERY_PARAM);
    const qs = rest.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [value, params, pathname, router]);

  return null;
}

/**
 * On the full Ask page, the conversation it shows (`?thread=`) has been seen,
 * however it was opened: the "Arwin replied" pop-up, the page's Recent list,
 * or a link. Its own component for the Suspense boundary `useSearchParams`
 * wants.
 */
function AskPageThreadListener({ onShown }: { onShown: (threadId: string) => void }) {
  const threadId = useSearchParams().get('thread');

  React.useEffect(() => {
    if (threadId) onShown(threadId);
  }, [threadId, onShown]);

  return null;
}

/* ------------------------------------------------------------ the greeting */

/**
 * "Hi. Need any help?" shows until it is dismissed or the widget is first
 * opened. A display preference only, so it lives in localStorage (read through
 * `useSyncExternalStore`, like the theme), with an in-memory fallback for a
 * browser that blocks storage.
 */
const GREETING_KEY = 'tiptop-ask-greeting-dismissed';
const greetingListeners = new Set<() => void>();
let greetingDismissedInMemory = false;

function subscribeGreeting(listener: () => void): () => void {
  greetingListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    greetingListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readGreetingDismissed(): boolean {
  if (greetingDismissedInMemory) return true;
  try {
    return window.localStorage.getItem(GREETING_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissGreeting() {
  if (greetingDismissedInMemory) return;
  greetingDismissedInMemory = true;
  try {
    window.localStorage.setItem(GREETING_KEY, '1');
  } catch {
    // Blocked storage costs the memory of the dismissal, nothing else.
  }
  for (const listener of greetingListeners) listener();
}

/* ------------------------------------------------------------------ fetch */

async function getJson<T>(
  url: string,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as
      (T & { ok?: boolean; error?: { message?: string } }) | null;
    if (!response.ok || !body || body.ok === false) {
      return { ok: false, message: body?.error?.message ?? 'That could not be loaded. Try again.' };
    }
    return { ok: true, data: body };
  } catch {
    return { ok: false, message: 'That could not be loaded. Check the connection and try again.' };
  }
}

/* ------------------------------------------------------------- watch list */

/**
 * The conversations still waiting on an answer, kept for the tab's session so
 * a reload carries on checking them. Session storage, like the guided tour:
 * nothing here outlives the tab.
 */
const WATCH_KEY = 'tiptop-ask-watching';
const WATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

function readWatched(now: number): Watched {
  const watched: Watched = new Map();
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(WATCH_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return watched;
    for (const [threadId, since] of Object.entries(value)) {
      if (!WATCH_ID.test(threadId) || typeof since !== 'number') continue;
      if (now - since <= WATCH_MAX_MS) watched.set(threadId, since);
    }
  } catch {
    // Unreadable: nothing was waiting.
  }
  return watched;
}

function writeWatched(watched: Watched) {
  try {
    if (watched.size === 0) window.sessionStorage.removeItem(WATCH_KEY);
    else window.sessionStorage.setItem(WATCH_KEY, JSON.stringify(Object.fromEntries(watched)));
  } catch {
    // Blocked storage: checking still carries on until the page reloads.
  }
}
