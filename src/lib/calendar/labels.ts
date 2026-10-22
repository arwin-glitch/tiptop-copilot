import { labelColor, NO_GOOGLE_COLOR } from './colors';
import type { GCalCalendar } from './google-types';
import type { CalendarInfo, EventLabel, RangeEvent } from './range-types';

/**
 * Google Calendar's colour labels: named colours each calendar defines
 * ("Travel", "LPs", "Founders"...), read live from the calendar
 * (calendars.get, labelProperties.eventLabels) and never stored or written
 * here: only the calendar's owner changes them, in Google Calendar. An event
 * points at one with eventLabelId; its colour is then the label's.
 *
 * Pure and client-safe: the reader, the page and the Ask tool share it, so a
 * label means the same thing everywhere.
 */

/** The filter key for events without a label (or with one their calendar no longer has). */
export const UNLABELLED = '__none__';

/** What a label is called on screen: its name, or what Google shows for an unnamed one. */
export function labelText(label: Pick<EventLabel, 'name'> | null | undefined): string {
  return label?.name?.trim() || 'Unnamed label';
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
 * calendars is one chip; an unnamed label keeps its own colour's chip.
 */
export function labelKey(label: Pick<EventLabel, 'id' | 'name' | 'color'>): string {
  const name = label.name?.trim().toLowerCase();
  return name ? `name:${name}` : `color:${label.color.background}`;
}

/** An event's legend key: its label's, else UNLABELLED. */
export function eventLabelKey(event: Pick<RangeEvent, 'label'>): string {
  return event.label ? labelKey(event.label) : UNLABELLED;
}

export interface LegendLabel {
  key: string;
  name: string;
  color: EventLabel['color'];
}

/** The labels of the calendars shown, once each by key, in calendar then Google order. */
export function legendLabels(
  calendars: readonly Pick<CalendarInfo, 'id' | 'labels'>[],
  shownIds: readonly string[],
): LegendLabel[] {
  const shown = new Set(shownIds);
  const out = new Map<string, LegendLabel>();
  for (const c of calendars) {
    if (!shown.has(c.id)) continue;
    for (const label of c.labels) {
      const key = labelKey(label);
      if (!out.has(key)) out.set(key, { key, name: labelText(label), color: label.color });
    }
  }
  return [...out.values()];
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
