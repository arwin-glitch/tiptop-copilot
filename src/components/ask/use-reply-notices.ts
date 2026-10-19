'use client';

import * as React from 'react';
import { TOUR_STATE_EVENT, type TourStateDetail } from '@/components/help/tour-events';
import {
  EMPTY_REPLY_STATE,
  arriveReply,
  dismissReply,
  parseSeen,
  rememberSeen,
  resumeReplies,
  suspendReplies,
  titleWithCount,
  viewedThread,
  type ReplyArrival,
  type ReplyContext,
  type ReplyNotice,
  type ReplyNoticeState,
  type ReplyOutcome,
} from '@/lib/chat/reply-notice';

/**
 * The Ask Arwin widget's "Arwin replied" pop-up, as state: the rules are the
 * pure ones in lib/chat/reply-notice.ts; this feeds them what the browser
 * knows (is the tab hidden, is a tour running, which conversation is on
 * screen) and keeps the side effects: the seen answers in sessionStorage, so a
 * reload never repeats a pop-up, and the "(1) " in the page title while a
 * hidden tab has answers waiting.
 */

const SEEN_KEY = 'tiptop-ask-replies-seen';

export interface ReplyNotices {
  /** The pop-up to show, or null. */
  notice: ReplyNotice | null;
  /**
   * An answer landed. `onScreen` says the caller knows it is on screen (a
   * new conversation has no id on screen yet); otherwise it is worked out.
   */
  arrive: (arrival: ReplyArrival, options?: { onScreen?: boolean }) => ReplyOutcome;
  dismiss: () => void;
  /** A conversation was put on screen. */
  viewed: (threadId: string) => void;
  /**
   * An answer read where it landed, outside the widget (the full Ask page):
   * remembered as seen, so nothing announces it again.
   */
  known: (answerId: string) => void;
}

export function useReplyNotices(onScreenThreadId: () => string | null): ReplyNotices {
  const [notice, setNotice] = React.useState<ReplyNotice | null>(null);
  const stateRef = React.useRef<ReplyNoticeState>(EMPTY_REPLY_STATE);
  const loadedRef = React.useRef(false);
  const tourRef = React.useRef(false);
  const titledRef = React.useRef(false);
  const screenRef = React.useRef(onScreenThreadId);

  React.useEffect(() => {
    screenRef.current = onScreenThreadId;
  }, [onScreenThreadId]);

  const context = React.useCallback(
    (): ReplyContext => ({
      onScreenThreadId: screenRef.current(),
      tabHidden: document.visibilityState === 'hidden',
      tourRunning: tourRef.current,
      now: Date.now(),
    }),
    [],
  );

  const commit = React.useCallback((next: ReplyNoticeState) => {
    const prev = stateRef.current;
    if (next === prev) return;
    stateRef.current = next;
    if (next.seen !== prev.seen) writeSeen(next.seen);
    if (next.current !== prev.current) setNotice(next.current);
    if (next.hiddenCount !== prev.hiddenCount) {
      if (next.hiddenCount > 0 || titledRef.current) {
        document.title = titleWithCount(document.title, next.hiddenCount);
        titledRef.current = next.hiddenCount > 0;
      }
    }
  }, []);

  // Read once, on the first answer handled: answers seen before a reload count.
  const load = React.useCallback(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    stateRef.current = {
      ...stateRef.current,
      seen: rememberSeen(readSeen(), stateRef.current.seen),
    };
  }, []);

  const arrive = React.useCallback(
    (arrival: ReplyArrival, options: { onScreen?: boolean } = {}): ReplyOutcome => {
      load();
      const ctx = context();
      if (options.onScreen) ctx.onScreenThreadId = arrival.threadId;
      const { state, outcome } = arriveReply(stateRef.current, arrival, ctx);
      commit(state);
      return outcome;
    },
    [commit, context, load],
  );

  const known = React.useCallback(
    (answerId: string) => {
      load();
      const state = stateRef.current;
      if (state.seen.includes(answerId)) return;
      commit({ ...state, seen: rememberSeen(state.seen, [answerId]) });
    },
    [commit, load],
  );

  const dismiss = React.useCallback(() => commit(dismissReply(stateRef.current)), [commit]);
  const viewed = React.useCallback(
    (threadId: string) => commit(viewedThread(stateRef.current, threadId)),
    [commit],
  );

  // Back to a hidden tab, or a tour ending: what waited shows now.
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        commit(resumeReplies(stateRef.current, context()));
      }
    };
    const onTour = (event: Event) => {
      const active = Boolean((event as CustomEvent<TourStateDetail>).detail?.active);
      tourRef.current = active;
      commit(
        active ? suspendReplies(stateRef.current) : resumeReplies(stateRef.current, context()),
      );
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(TOUR_STATE_EVENT, onTour);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(TOUR_STATE_EVENT, onTour);
      if (titledRef.current) {
        document.title = titleWithCount(document.title, 0);
        titledRef.current = false;
      }
    };
  }, [commit, context]);

  return { notice, arrive, dismiss, viewed, known };
}

function readSeen(): string[] {
  try {
    return parseSeen(window.sessionStorage.getItem(SEEN_KEY));
  } catch {
    return [];
  }
}

function writeSeen(seen: readonly string[]) {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Blocked storage: answers are still remembered until the page reloads.
  }
}
