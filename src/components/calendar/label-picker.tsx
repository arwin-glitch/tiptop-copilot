'use client';

import { Check, ExternalLink } from 'lucide-react';
import { colorWords } from '@/lib/calendar/colors';
import { labelName, pickerLabels } from '@/lib/calendar/labels';
import type { EventLabel } from '@/lib/calendar/range-types';
import { cn } from '@/lib/util/cn';
import { swatchStyle, tickStyle } from './event-style';

/** Google Calendar's own place to name, rename or recolour labels. */
export const GOOGLE_CALENDAR_HOME = 'https://calendar.google.com/calendar/r';

const CHIP =
  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--focus)]';
const CHIP_ON = 'border-[var(--fg)] bg-[var(--bg-hover)] text-[var(--fg)]';
const CHIP_OFF =
  'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]';

/**
 * Google Calendar's label picker, on the event card and in the editor
 * (D-072), laid out as Google lays it out: the calendar's named labels as
 * chips (dot and name) round the colour wheel, the current one ticked; then
 * the colours nobody has named as a row of plain dots, each called by
 * Google's name for it ("Tomato", or "Colour #rrggbb" for one Google does
 * not name); then "No label", and a link to edit the labels in Google
 * Calendar. A dot is the same label write as a chip: its slot's
 * eventLabelId. Picking the current one does nothing.
 */
export function LabelPicker({
  labels,
  current,
  onPick,
  editHref = GOOGLE_CALENDAR_HOME,
  className,
}: {
  labels: readonly EventLabel[];
  /** The label id picked now; null for none. */
  current: string | null;
  onPick: (labelId: string | null) => void;
  editHref?: string;
  className?: string;
}) {
  const { named, colours } = pickerLabels(labels);
  const pick = (id: string | null) => {
    if (id !== current) onPick(id);
  };
  const noneOn = current === null;
  return (
    <div className={cn('space-y-2', className)} data-label-picker="">
      <div role="radiogroup" aria-label="Event label" className="space-y-1.5">
        {named.length ? (
          <div className="flex flex-wrap gap-1.5">
            {named.map((l) => {
              const on = current === l.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(l.id)}
                  className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                >
                  <span
                    aria-hidden
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-full border"
                    style={swatchStyle(l.color.background)}
                  >
                    {on ? (
                      <Check className="size-2.5" style={tickStyle(l.color.background)} />
                    ) : null}
                  </span>
                  <span className="min-w-0 truncate">{labelName(l)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1">
          {colours.map((l) => {
            const on = current === l.id;
            const words = colorWords(l.color.background);
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={words}
                title={words}
                data-label-colour=""
                onClick={() => pick(l.id)}
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-[var(--focus)]',
                  on ? 'border-[var(--fg)]' : 'border-transparent',
                )}
              >
                <span
                  aria-hidden
                  className="flex size-5 items-center justify-center rounded-full border"
                  style={swatchStyle(l.color.background)}
                >
                  {on ? <Check className="size-3" style={tickStyle(l.color.background)} /> : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={noneOn}
            onClick={() => pick(null)}
            className={cn(CHIP, colours.length ? 'ml-1' : '', noneOn ? CHIP_ON : CHIP_OFF)}
          >
            {noneOn ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
            No label
          </button>
        </div>
      </div>
      <a
        href={editHref}
        target="_blank"
        rel="noopener noreferrer"
        className="link-inline inline-flex items-center gap-1 text-xs"
      >
        Edit labels in Google Calendar <ExternalLink className="size-3" aria-hidden />
      </a>
    </div>
  );
}
