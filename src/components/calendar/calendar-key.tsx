'use client';

import * as React from 'react';
import { Bell, BellOff, Info, X } from 'lucide-react';
import { LOOK_WORDS, type EventLook } from '@/lib/calendar/event-look';
import { UNLABELLED, type LegendLabel } from '@/lib/calendar/labels';
import type { CalendarColor } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ASK_GLYPH_CLASS, chipStyle, HOLD_TAG_CLASS, swatchStyle, titleStyle } from './event-style';

/**
 * Above the grid in Day, Week and Month: the calendars' colour labels as a
 * row of chips (a tap shows only that label's events; "Unlabelled" the rest),
 * and a Key that explains how an event looks, one rule each (D-070), with
 * the labels again. The look is drawn with the grid's own styles, so the key
 * cannot drift from what it explains.
 */

/** A sample event in the key, drawn exactly as a chip is. */
function Sample({
  color,
  look,
  title,
  asking,
}: {
  color: CalendarColor;
  look: EventLook;
  title: string;
  asking?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="flex h-6 w-28 shrink-0 items-center gap-1 overflow-hidden rounded-[5px] border px-1.5 text-[12px] leading-none font-semibold"
      style={chipStyle({ color }, { look })}
    >
      {asking ? <span className={ASK_GLYPH_CLASS}>?</span> : null}
      <span className="truncate" style={titleStyle(look)}>
        {title}
      </span>
    </span>
  );
}

const PLAIN: EventLook = { past: false, response: null };

export function CalendarKey({
  labels,
  sample,
}: {
  labels: readonly LegendLabel[];
  /** The colour the samples are drawn in: the first label's, else the main calendar's. */
  sample: CalendarColor;
}) {
  const rows: { look: EventLook; title: string; text: string; asking?: boolean }[] = [
    {
      look: PLAIN,
      title: 'Partner sync',
      text: 'Filled with its colour: its label’s, else its own, else its calendar’s, as in Google Calendar.',
    },
    {
      look: { past: true, response: null },
      title: 'Partner sync',
      text: `${LOOK_WORDS.past}: it already happened.`,
    },
    {
      look: { past: false, response: 'needsAction' },
      title: 'Board meeting',
      text: `${LOOK_WORDS.needsAction}: Nick hasn’t answered the invitation.`,
      asking: true,
    },
    {
      look: { past: false, response: 'tentative' },
      title: 'LP lunch',
      text: `${LOOK_WORDS.tentative}: Nick said maybe.`,
    },
    {
      look: { past: false, response: 'declined' },
      title: 'Vendor demo',
      text: `${LOOK_WORDS.declined}: Nick said no.`,
    },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-tour="calendar-key"
          aria-label="Key: how events look"
        >
          <Info aria-hidden /> Key
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))]"
        data-calendar-key=""
      >
        <p className="mb-2 font-serif text-base font-semibold">How events look</p>
        <ul className="space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.text} className="flex items-start gap-2.5">
              <Sample color={sample} look={r.look} title={r.title} asking={r.asking} />
              <span className="min-w-0 text-[var(--fg-muted)]">{r.text}</span>
            </li>
          ))}
          <li className="flex items-start gap-2.5">
            <span className="flex w-28 shrink-0 justify-center">
              <Bell className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 text-[var(--fg-muted)]">
              Meeting: pings Nick’s phone 5 minutes before.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="flex w-28 shrink-0 justify-center text-[var(--fg-subtle)]">
              <BellOff className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 text-[var(--fg-muted)]">
              No bell: a block (focus time, travel, a registration, a hold). It never pings, and it
              looks like any other event otherwise.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="flex w-28 shrink-0 justify-center">
              <span className={HOLD_TAG_CLASS}>Hold</span>
            </span>
            <span className="min-w-0 text-[var(--fg-muted)]">A hold nobody has confirmed.</span>
          </li>
        </ul>
        <p className="mt-3 mb-1 text-sm font-medium">Labels</p>
        {labels.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {labels.map((l) => (
              <li key={l.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full border"
                  style={swatchStyle(l.color.background)}
                />
                {l.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--fg-muted)]">
            The calendars shown have no colour labels: events take Google’s event colours.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The labels of the calendars shown, each a filter chip, plus "Unlabelled". */
export function LabelLegend({
  labels,
  filter,
  onToggle,
  onClear,
}: {
  labels: readonly LegendLabel[];
  filter: readonly string[];
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  if (labels.length === 0) return null;
  const chips = [
    ...labels.map((l) => ({
      key: l.key,
      name: l.name,
      color: l.color.background as string | null,
    })),
    { key: UNLABELLED, name: 'Unlabelled', color: null as string | null },
  ];
  return (
    <div
      role="group"
      aria-label="Labels"
      data-label-legend=""
      className="flex min-w-0 flex-1 items-center gap-1.5 max-sm:overflow-x-auto max-sm:pb-1 sm:flex-wrap"
    >
      {chips.map((c) => {
        const on = filter.includes(c.key);
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(c.key)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
              on
                ? 'border-[var(--fg)] bg-[var(--bg-hover)] text-[var(--fg)]'
                : 'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
            )}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full border"
              style={c.color ? swatchStyle(c.color) : swatchStyle('var(--fg-subtle)', true)}
            />
            {c.name}
          </button>
        );
      })}
      {filter.length ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)]"
        >
          <X className="size-3" aria-hidden /> Show all
        </button>
      ) : null}
    </div>
  );
}
