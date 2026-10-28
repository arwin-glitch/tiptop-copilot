import type * as React from 'react';
import { tickOn } from '@/lib/calendar/colors';
import type { EventLook } from '@/lib/calendar/event-look';
import { labelName } from '@/lib/calendar/labels';
import type { RangeEvent } from '@/lib/calendar/range-types';

/**
 * How an event is drawn, one rule each (D-070, lib/calendar/event-look.ts):
 *
 * - The fill is the event's colour from Google: its label's, else its own,
 *   else its calendar's. Meetings and blocks are filled alike; the bell on a
 *   meeting is Kraken's verdict (it pings), and nothing turns a block grey.
 * - Not answered yet: the surface colour inside a border in the event's
 *   colour, with a thick left edge, and a "?" (Google's own style).
 * - Maybe: the same outline over diagonal stripes in the event's colour.
 * - Declined: the title struck through, faded.
 * - Already happened: the whole chip faded.
 *
 * The colours are data from Google, so they are set inline; everything
 * around them uses the theme tokens, so the outline styles read in light and
 * dark alike (the theme's own text on the theme's own surface).
 */

/** Faded, for an event that already happened (and more so if declined too). */
export const PAST_OPACITY = 0.55;
const DECLINED_OPACITY = 0.5;
const PAST_DECLINED_OPACITY = 0.4;

export function lookOpacity(look: EventLook | null | undefined): number | undefined {
  if (!look) return undefined;
  const declined = look.response === 'declined';
  if (look.past) return declined ? PAST_DECLINED_OPACITY : PAST_OPACITY;
  return declined ? DECLINED_OPACITY : undefined;
}

/** The outline Google draws for an answer still open (Not answered yet, Maybe). */
function outlined(background: string, striped: boolean): React.CSSProperties {
  return {
    backgroundColor: 'var(--bg-raised)',
    ...(striped
      ? {
          backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${background} 42%, transparent) 0 5px, transparent 5px 10px)`,
        }
      : {}),
    color: 'var(--fg)',
    borderColor: background,
    borderStyle: 'solid',
    borderLeftWidth: 4,
  };
}

export function chipStyle(
  event: Pick<RangeEvent, 'color'>,
  options: { dragging?: boolean; look?: EventLook | null } = {},
): React.CSSProperties {
  const { background, foreground } = event.color;
  const look = options.look ?? null;
  const base: React.CSSProperties = options.dragging
    ? { boxShadow: 'var(--elevation-lifted)', zIndex: 5 }
    : { opacity: lookOpacity(look) };
  if (look?.response === 'needsAction' || look?.response === 'tentative') {
    return { ...base, ...outlined(background, look.response === 'tentative') };
  }
  return {
    ...base,
    backgroundColor: background,
    color: foreground,
    borderColor: background,
    borderStyle: 'solid',
  };
}

/** The title's own style: struck through when Nick declined. */
export function titleStyle(look: EventLook | null | undefined): React.CSSProperties | undefined {
  return look?.response === 'declined'
    ? { textDecorationLine: 'line-through', textDecorationThickness: '1.5px' }
    : undefined;
}

/** The small "Hold" tag on a hold (a block, never pinged), the same in every view. */
export const HOLD_TAG_CLASS =
  'shrink-0 rounded-sm border border-current px-0.5 text-[10px] leading-none font-medium uppercase opacity-80';

/** The "?" on an invitation Nick has not answered, the same in every view. */
export const ASK_GLYPH_CLASS =
  'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[9px] leading-none font-bold';

/** The small round swatch beside a calendar or an event in a list. */
export function swatchStyle(background: string, hollow = false): React.CSSProperties {
  return hollow
    ? { borderColor: background, borderWidth: 2, borderStyle: 'solid' }
    : { backgroundColor: background, borderColor: background };
}

/** A list's or a month day's dot for an event, in its look: hollow while unanswered, striped for maybe. */
export function dotStyle(
  event: Pick<RangeEvent, 'color'>,
  look: EventLook | null | undefined,
): React.CSSProperties {
  const { background } = event.color;
  if (look?.response === 'needsAction') return swatchStyle(background, true);
  if (look?.response === 'tentative') {
    return {
      borderColor: background,
      borderWidth: 1.5,
      borderStyle: 'solid',
      backgroundImage: `repeating-linear-gradient(135deg, ${background} 0 2px, transparent 2px 4px)`,
    };
  }
  return swatchStyle(background);
}

/** The selected swatch's tick, picked per swatch to stand out (the theme's text colour if unknown). */
export function tickStyle(background: string): React.CSSProperties {
  return { color: tickOn(background) ?? 'var(--fg)' };
}

/**
 * "Meeting: Partner sync, 10am to 11am, not answered yet, label Portfolio,
 * TipTop team" for a screen reader: the same facts the chip's look shows.
 */
export function chipLabel(
  event: Pick<RangeEvent, 'verdict' | 'title' | 'hold' | 'label'>,
  when: string,
  calendarName: string | null,
  look?: EventLook | null,
): string {
  return [
    `${event.verdict.meeting ? 'Meeting' : 'Block'}: ${event.title}`,
    when,
    event.hold ? 'hold' : null,
    look?.response === 'needsAction'
      ? 'not answered yet'
      : look?.response === 'tentative'
        ? 'maybe'
        : look?.response === 'declined'
          ? 'declined'
          : null,
    look?.past ? 'ended' : null,
    labelName(event.label) ? `label ${labelName(event.label)}` : null,
    calendarName,
  ]
    .filter(Boolean)
    .join(', ');
}
