'use client';

import * as React from 'react';
import { Bell, BellOff, ChevronDown, Info, X } from 'lucide-react';
import { LOOK_WORDS, type EventLook } from '@/lib/calendar/event-look';
import { UNLABELLED, type LegendLabel } from '@/lib/calendar/labels';
import type { CalendarColor } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ASK_GLYPH_CLASS, chipStyle, HOLD_TAG_CLASS, swatchStyle, titleStyle } from './event-style';

/**
 * Above the grid in Day, Week and Month: the calendars' named colour labels
 * as a row of chips (a tap shows only that label's events; "Unlabelled" the
 * rest, D-072), and a Key that explains how an event looks, one rule each
 * (D-070), with the named labels again. The look is drawn with the grid's own styles, so the key
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

const CHIP =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus)]';
const CHIP_ON = 'border-[var(--fg)] bg-[var(--bg-hover)] text-[var(--fg)]';
const CHIP_OFF =
  'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]';
/** The row's gap between chips, in px (gap-1.5). */
const GAP_PX = 6;
/** The row's own inset, in px each side, so a focused chip's outline is not cut off. */
const INSET_PX = 2;

interface LegendChip {
  key: string;
  name: string;
  color: string | null;
}

function ChipFace({ chip }: { chip: LegendChip }) {
  return (
    <>
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full border"
        style={chip.color ? swatchStyle(chip.color) : swatchStyle('var(--fg-subtle)', true)}
      />
      {chip.name}
    </>
  );
}

/**
 * The named labels of the calendars shown (lib/calendar/labels.ts,
 * legendLabels: merged by name, in Google's picker order), each a filter
 * chip, plus "Unlabelled", which also holds events whose label has no name.
 *
 * One line on a computer: the chips that fit, and "More" for the rest, in a
 * popover (a chip picked there lights "More" up). On a phone, every chip in
 * a strip that scrolls sideways on its own, so the page never does.
 */
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
  const chips: LegendChip[] = [
    ...labels.map((l) => ({
      key: l.key,
      name: l.name,
      color: l.color.background as string | null,
    })),
    { key: UNLABELLED, name: 'Unlabelled', color: null },
  ];
  const chipsKey = chips.map((c) => c.key).join('|');
  const rowRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  // How many chips show in the row on a computer; the rest are behind "More".
  const [fit, setFit] = React.useState(chips.length);

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const compute = () => {
      const width = (el: Element | null) => (el ? el.getBoundingClientRect().width : 0);
      const widths = [...measure.querySelectorAll('[data-measure-chip]')].map(width);
      const more = width(measure.querySelector('[data-measure-more]'));
      // Room for "Show all" is kept either way, so a tap never pushes a chip behind "More".
      const clear = width(measure.querySelector('[data-measure-clear]')) + GAP_PX;
      const room = row.clientWidth - 2 * INSET_PX - clear;
      const all = widths.reduce((sum, w) => sum + w, 0) + GAP_PX * (widths.length - 1);
      if (all <= room) {
        setFit(widths.length);
        return;
      }
      let used = more;
      let n = 0;
      while (n < widths.length && used + GAP_PX + widths[n]! <= room) {
        used += GAP_PX + widths[n]!;
        n++;
      }
      setFit(n);
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [chipsKey]);

  if (labels.length === 0) return null;
  const shown = Math.min(fit, chips.length);
  const hidden = chips.slice(shown);
  const hiddenOn = hidden.filter((c) => filter.includes(c.key)).length;

  const chipButton = (c: LegendChip, extra?: string) => {
    const on = filter.includes(c.key);
    return (
      <button
        key={c.key}
        type="button"
        aria-pressed={on}
        onClick={() => onToggle(c.key)}
        className={cn(CHIP, on ? CHIP_ON : CHIP_OFF, extra)}
      >
        <ChipFace chip={c} />
      </button>
    );
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={rowRef}
        role="group"
        aria-label="Labels"
        data-label-legend=""
        className="flex min-w-0 items-center gap-1.5 p-0.5 max-sm:overflow-x-auto max-sm:pb-1 sm:overflow-hidden"
      >
        {/* Past the fit, a chip is hidden on a computer only: a phone scrolls the strip. */}
        {chips.map((c, i) => chipButton(c, i >= shown ? 'sm:hidden' : undefined))}
        {hidden.length ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-label-more=""
                aria-label={`${hidden.length} more ${hidden.length === 1 ? 'label' : 'labels'}${hiddenOn ? `, ${hiddenOn} picked` : ''}`}
                className={cn(CHIP, hiddenOn ? CHIP_ON : CHIP_OFF, 'max-sm:hidden')}
              >
                More
                <span className="text-[var(--fg-subtle)] tabular-nums">{hidden.length}</span>
                <ChevronDown className="size-3" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto max-w-[min(24rem,calc(100vw-2rem))]">
              <div role="group" aria-label="More labels" className="flex flex-wrap gap-1.5">
                {hidden.map((c) => chipButton(c))}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
        {filter.length ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap text-[var(--accent)] hover:bg-[var(--bg-hover)]"
          >
            <X className="size-3" aria-hidden /> Show all
          </button>
        ) : null}
      </div>
      {/* Every chip at its own width, unseen, to work out how many fit. */}
      <div
        ref={measureRef}
        aria-hidden
        inert
        className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-full gap-1.5 overflow-hidden"
      >
        {chips.map((c) => (
          <span key={c.key} data-measure-chip="" className={cn(CHIP, CHIP_OFF)}>
            <ChipFace chip={c} />
          </span>
        ))}
        <span data-measure-more="" className={cn(CHIP, CHIP_OFF)}>
          More
          <span className="tabular-nums">{chips.length}</span>
          <ChevronDown className="size-3" />
        </span>
        <span
          data-measure-clear=""
          className="inline-flex h-7 shrink-0 items-center gap-1 px-2 text-xs font-medium whitespace-nowrap"
        >
          <X className="size-3" /> Show all
        </span>
      </div>
    </div>
  );
}
