import type { RangeEvent } from './range-types';

/**
 * How an event looks in Day, Week and Month, one rule each, so nothing means
 * two things (D-070):
 *
 * - The fill is the event's colour (its label's, else its own, else its
 *   calendar's), as in Google. Nothing else turns an event grey.
 * - Already happened (ended before now): the whole chip faded.
 * - Nick hasn't answered (needsAction): Google's outline style, the surface
 *   colour inside a border in the event's colour, and a "?".
 * - Maybe (tentative): diagonal stripes in the event's colour.
 * - Declined: the title struck through, faded.
 * - Kraken's verdict is the bell: a meeting pings, a block does not. A block
 *   is drawn like any other event (no dashed edge, no muting).
 *
 * Pure, for the grid, the card, the key and the tests.
 */

export type ResponseLook = 'needsAction' | 'tentative' | 'declined';

export interface EventLook {
  /** It ended before now (an all-day event: before today). */
  past: boolean;
  /** Nick's own answer when it changes the look; null when accepted or not his to answer. */
  response: ResponseLook | null;
}

export function eventLook(
  event: Pick<
    RangeEvent,
    'allDay' | 'endsAt' | 'startsAt' | 'endDate' | 'myResponse' | 'organizer'
  >,
  at: {
    /** Null until the page is in the browser: nothing is drawn as past before then. */
    nowMs: number | null;
    /** Today's `YYYY-MM-DD` in the profile's zone. */
    today: string;
  },
): EventLook {
  let past = false;
  if (at.nowMs !== null) {
    if (event.allDay || !event.startsAt) {
      // Google keeps an all-day end exclusive: it is over once today reaches it.
      past = Boolean(event.endDate && event.endDate <= at.today);
    } else {
      const end = Date.parse(event.endsAt ?? event.startsAt);
      past = Number.isFinite(end) && end < at.nowMs;
    }
  }
  // The organizer has nothing to answer.
  const mine = event.organizer?.self ? null : event.myResponse;
  const response =
    mine === 'needsAction' || mine === 'tentative' || mine === 'declined' ? mine : null;
  return { past, response };
}

/** What the card says about it, in the key's own words. */
export const LOOK_WORDS: Readonly<Record<'past' | ResponseLook, string>> = {
  past: 'Ended',
  needsAction: 'Not answered yet',
  tentative: 'Maybe',
  declined: 'Declined',
};

/** The card's words for an event's look, in order: its answer first, then Ended. */
export function lookWords(look: EventLook): string[] {
  return [
    look.response ? LOOK_WORDS[look.response] : null,
    look.past ? LOOK_WORDS.past : null,
  ].filter((w): w is string => w !== null);
}
