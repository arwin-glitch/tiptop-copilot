import type { EventQuestionPublic, EventRsvpContext } from '@/lib/events/contracts';
import { isQuestionAsked, type RegistrationQuestion } from '@/lib/events/questions';
import type { EventGuestStatus } from '@/lib/types/domain';

/**
 * Shared by the RSVP form's pieces (client): labels, which questions are
 * asked, the POST, and the result wording. No server imports.
 */

export interface SlotLabels {
  cta: string;
  going: string;
  maybe: string;
  notGoing: string;
}

/** The block's own labels win; the event's response set fills the gaps. */
export function resolveLabels(labels: SlotLabels, context: EventRsvpContext): SlotLabels {
  const set = context.registration.responseSet.labels;
  return {
    cta: labels.cta || 'RSVP',
    going: labels.going || set.going || 'Going',
    maybe: labels.maybe || set.maybe || 'Maybe',
    notGoing: labels.notGoing || set.not_going || "Can't go",
  };
}

/** Adapter: a public question as the registration rules expect it. */
function asRule(q: EventQuestionPublic): RegistrationQuestion {
  return {
    id: q.id,
    type: q.type,
    label: q.label,
    help: q.help,
    required: q.required,
    options: q.options,
    session_id: q.sessionId,
    ask_plus_ones: q.askPlusOnes,
    position: 0,
    removed_at: null,
    show_if: q.showIf ?? null,
  };
}

export function askedQuestions(
  questions: readonly EventQuestionPublic[],
  sessionIds: readonly string[],
  answers: Record<string, unknown>,
  plusOne = false,
): EventQuestionPublic[] {
  const set = new Set(sessionIds);
  return questions.filter((q) => isQuestionAsked(asRule(q), { sessionIds: set, answers, plusOne }));
}

export type SessionOutcome = EventGuestStatus | 'full';

export interface RsvpResponse {
  ok: boolean;
  outcome?: { sessions: Record<string, SessionOutcome>; plusOnes: number };
  ticketPath?: string | null;
  error?: { code: string; message: string };
}

export async function postRsvp(endpoint: string, body: unknown): Promise<RsvpResponse> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => null)) as RsvpResponse | null;
    if (!data)
      return {
        ok: false,
        error: { code: 'internal', message: 'Something went wrong. Try again.' },
      };
    return data;
  } catch {
    return {
      ok: false,
      error: { code: 'internal', message: 'You seem to be offline. Try again.' },
    };
  }
}

export type ResultTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface ResultView {
  tone: ResultTone;
  icon: string;
  title: string;
  body: string;
}

export function resultFor(
  sessions: Record<string, SessionOutcome>,
  labels: SlotLabels,
): ResultView {
  const statuses = Object.values(sessions);
  if (statuses.includes('going')) {
    const others = statuses.filter((s) => s !== 'going');
    return {
      tone: 'ok',
      icon: '✓',
      title: `You’re going`,
      body: others.includes('waitlist')
        ? 'You’re on the waitlist for the rest. We’ll let you know if a spot opens.'
        : others.includes('pending')
          ? 'Part of your RSVP waits for the host to confirm.'
          : 'Your ticket has the details, the calendar file and your QR code.',
    };
  }
  if (statuses.includes('pending')) {
    return {
      tone: 'neutral',
      icon: '…',
      title: 'Request received',
      body: 'The host will confirm.',
    };
  }
  if (statuses.includes('waitlist')) {
    return {
      tone: 'warn',
      icon: '⏳',
      title: 'You’re on the waitlist',
      body: 'It’s full right now. We’ll let you know if a spot opens.',
    };
  }
  if (statuses.includes('maybe')) {
    return {
      tone: 'neutral',
      icon: '?',
      title: `Marked: ${labels.maybe}`,
      body: 'You can change it any time before RSVPs close.',
    };
  }
  if (statuses.includes('declined')) {
    return { tone: 'neutral', icon: '–', title: 'Thank you', body: 'The host has your answer.' };
  }
  if (statuses.every((s) => s === 'full')) {
    return {
      tone: 'bad',
      icon: '!',
      title: 'This event is full',
      body: 'There are no spots left.',
    };
  }
  return {
    tone: 'neutral',
    icon: '✓',
    title: 'Thanks for letting us know',
    body: 'You can change your answer any time before RSVPs close.',
  };
}

export const STATUS_TEXT: Record<SessionOutcome, string> = {
  going: 'Going',
  maybe: 'Maybe',
  not_going: 'Not going',
  pending: 'Waiting for approval',
  waitlist: 'Waitlist',
  declined: 'Declined',
  invited: 'Invited',
  full: 'Full',
};

/** Tell the page's effects layer (WS2) to play the RSVP moment. */
export function playRsvpMoment(): void {
  try {
    window.dispatchEvent(new CustomEvent('tiptop:rsvp-moment', { detail: { status: 'going' } }));
  } catch {
    // no effects layer: nothing to play
  }
}

export const DEFAULT_TIME_ZONE = 'America/Chicago';
