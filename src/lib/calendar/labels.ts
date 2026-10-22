import { compareColors, labelColor, NO_GOOGLE_COLOR } from './colors';
import type { GCalCalendar } from './google-types';
import type { CalendarInfo, EventLabel, RangeEvent } from './range-types';

/**
 * Google Calendar's colour labels: named colours each calendar defines
 * ("Travel", "LPs", "Founders"...), read live from the calendar
 * (calendars.get, labelProperties.eventLabels) and never stored or written
 * here: only the calendar's owner changes them, in Google Calendar. An event
 * points at one with eventLabelId; its colour is then the label's.
 *
 * Google lists a slot for every colour it offers, named or not (a real main
 * calendar: ten named, fourteen without a name). As Google's own picker does,
 * only a label with a name is a label here (D-072): an unnamed one is just a
 * colour. Its events are drawn in it, but no name is ever shown for it, it is
 * no filter chip of its own (it counts as "Unlabelled"), and the picker shows
 * it as a plain dot.
 *
 * Pure and client-safe: the reader, the page and the Ask tool share it, so a
 * label means the same thing everywhere.
 */

/** The filter key for events without a named label (or with one their calendar no longer has). */
export const UNLABELLED = '__none__';

/** A label's name, trimmed; null for one without a name (a colour, not a label). */
export function labelName(label: Pick<EventLabel, 'name'> | null | undefined): string | null {
  return label?.name?.trim() || null;
}

/** Labels in Google's picker order: round the colour wheel, greys last, then by name. */
export function byPickerOrder<T extends { name: string | null; color: { background: string } }>(
  labels: readonly T[],
): T[] {
  return [...labels].sort((a, b) =>
    compareColors(
      { background: a.color.background, name: a.name },
      { background: b.color.background, name: b.name },
    ),
  );
}

export interface PickerLabels {
  /** Labels with a name, as chips: dot and name. */
  named: EventLabel[];
  /** Colours without a name, as plain dots. */
  colours: EventLabel[];
}

/** A calendar's labels as Google's picker shows them: the named ones, then the bare colours. */
export function pickerLabels(labels: readonly EventLabel[]): PickerLabels {
  return {
    named: byPickerOrder(labels.filter((l) => labelName(l) !== null)),
    colours: byPickerOrder(labels.filter((l) => labelName(l) === null)),
  };
}

/** A calendar's labels in Google's order: ids kept once, colours checked, names trimmed. */
export function toEventLabels(calendar: GCalCalendar | null | undefined): EventLabel[] {
  const seen = new Set<string>();
  const out: EventLabel[] = [];
  for (const raw of calendar?.labelProperties?.eventLabels ?? []) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
      color: labelColor(raw.backgroundColor) ?? NO_GOOGLE_COLOR,
    });
  }
  return out;
}

/** The label an event points at, when its calendar defines it. */
export function findLabel(
  labels: readonly EventLabel[] | null | undefined,
  id: string | null | undefined,
): EventLabel | null {
  if (!id) return null;
  return labels?.find((l) => l.id === id) ?? null;
}

/**
 * The key the legend filters by: the label's name, so "Travel" on two
 * calendars is one chip. A label without a name is a colour, not a label:
 * it filters with the unlabelled events.
 */
export function labelKey(label: Pick<EventLabel, 'name'>): string {
  const name = labelName(label)?.toLowerCase();
  return name ? `name:${name}` : UNLABELLED;
}

/** An event's legend key: its named label's, else UNLABELLED. */
export function eventLabelKey(event: Pick<RangeEvent, 'label'>): string {
  return event.label ? labelKey(event.label) : UNLABELLED;
}

export interface LegendLabel {
  key: string;
  name: string;
  color: EventLabel['color'];
}

/**
 * The named labels of the calendars shown, once each by name (the colour of
 * the first calendar that has it), in Google's picker order. Labels without
 * a name are left out: they are colours, and "Unlabelled" covers them.
 */
export function legendLabels(
  calendars: readonly Pick<CalendarInfo, 'id' | 'labels'>[],
  shownIds: readonly string[],
): LegendLabel[] {
  const shown = new Set(shownIds);
  const out = new Map<string, LegendLabel>();
  for (const c of calendars) {
    if (!shown.has(c.id)) continue;
    for (const label of c.labels) {
      const name = labelName(label);
      if (!name) continue;
      const key = labelKey(label);
      if (!out.has(key)) out.set(key, { key, name, color: label.color });
    }
  }
  return byPickerOrder([...out.values()]);
}

/** Whether an event shows under the legend's filter: none picked shows everything. */
export function passesLabelFilter(
  event: Pick<RangeEvent, 'label'>,
  filter: readonly string[],
): boolean {
  return filter.length === 0 || filter.includes(eventLabelKey(event));
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Whether a label's name answers a name someone asked for ("portcos",
 * "Portcos meetings", "LP"): the same words either way, or one inside the
 * other, any case, ignoring punctuation and a plural "s".
 */
export function labelNameMatches(name: string | null | undefined, asked: string): boolean {
  const a = fold(name ?? '');
  const b = fold(asked);
  if (!a || !b) return false;
  if (a === b) return true;
  const single = (w: string) => (w.length >= 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  const aw = a.split(' ').map(single);
  const bw = b.split(' ').map(single);
  if (aw.join(' ') === bw.join(' ')) return true;
  // Every word of the label's name appears in what was asked ("portcos meetings" finds "Portcos"),
  // or every word asked appears in the name ("board" finds "Board Work").
  return aw.every((w) => bw.includes(w)) || bw.every((w) => aw.includes(w));
}
