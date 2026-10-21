import type * as React from 'react';
import type { RangeEvent } from '@/lib/calendar/range-types';

/**
 * How an event is drawn: in Google's colour for it, with Copilot's verdict on
 * top. A meeting is a solid chip in that colour; a block (a hold, focus time,
 * anything nobody else is on) is lighter, a tint of the colour with a dashed
 * edge, the way the day list draws blocks. The colours are data from Google,
 * so they are set inline; everything around them uses the theme tokens.
 */

export function chipStyle(
  event: RangeEvent,
  options: { dragging?: boolean } = {},
): React.CSSProperties {
  const { background, foreground } = event.color;
  const base: React.CSSProperties = options.dragging
    ? { boxShadow: 'var(--elevation-lifted)', zIndex: 5 }
    : {};
  if (event.verdict.meeting) {
    return { ...base, backgroundColor: background, color: foreground, borderColor: background };
  }
  return {
    ...base,
    backgroundColor: `color-mix(in srgb, ${background} 24%, var(--bg-raised))`,
    color: 'var(--fg)',
    borderColor: background,
    borderStyle: 'dashed',
  };
}

/** The small "Hold" tag on a hold (a block, never pinged), the same in every view. */
export const HOLD_TAG_CLASS =
  'shrink-0 rounded-sm border border-current px-0.5 text-[10px] leading-none font-medium uppercase opacity-80';

/** The small round swatch beside a calendar or an event in a list. */
export function swatchStyle(background: string, hollow = false): React.CSSProperties {
  return hollow
    ? { borderColor: background, borderWidth: 2, borderStyle: 'solid' }
    : { backgroundColor: background, borderColor: background };
}

/** "Meeting: Partner sync, 10am to 11am, TipTop team" for a screen reader. */
export function chipLabel(event: RangeEvent, when: string, calendarName: string | null): string {
  return [
    `${event.verdict.meeting ? 'Meeting' : 'Block'}: ${event.title}`,
    when,
    event.hold ? 'hold' : null,
    calendarName,
  ]
    .filter(Boolean)
    .join(', ');
}
