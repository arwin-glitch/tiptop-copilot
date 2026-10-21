'use client';

import * as React from 'react';
import { Check, Video, X } from 'lucide-react';
import {
  cleanGuestList,
  exclusiveEnd,
  isEmailAddress,
  timesProblem,
  type EventDraft,
} from '@/lib/calendar/edit-rules';
import { inclusiveLastDay, instantFromFields, wallFields } from '@/lib/calendar/draft';
import { shortTime } from '@/lib/calendar/grid';
import type { CalendarInfo, EventPaletteEntry, RangeEvent } from '@/lib/calendar/range-types';
import { addDaysToKey } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Label, Select, Textarea } from '@/components/ui/form';
import { fetchGuests } from './calendar-api';
import { swatchStyle } from './event-style';

/**
 * Making and changing an event, as in Google Calendar: a quick editor after
 * a drag on the grid (title, the time, Save, or More options), and the full
 * editor: title, start and end, all day, the time zone the times are shown
 * in, the calendar, guests, Google Meet, place, description and Google's own
 * event colours. Saving hands the draft back; the page asks the guests
 * question and talks to the server.
 */

export interface EditorState {
  mode: 'quick' | 'full';
  /** The event being changed; null for a new one. */
  event: RangeEvent | null;
  draft: EventDraft;
  calendarId: string;
}

interface Fields {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  guests: string[];
  meet: boolean;
  location: string;
  description: string;
  colorId: string | null;
  calendarId: string;
}

function toFields(state: EditorState, timeZone: string): Fields {
  const { draft } = state;
  let startDate: string;
  let startTime = '09:00';
  let endDate: string;
  let endTime = '10:00';
  if (draft.allDay) {
    startDate = draft.start;
    endDate = inclusiveLastDay(draft.end);
  } else {
    const s = wallFields(draft.start, timeZone);
    const e = wallFields(draft.end, timeZone);
    startDate = s.date;
    startTime = s.time;
    endDate = e.date;
    endTime = e.time;
  }
  return {
    title: draft.title,
    allDay: draft.allDay,
    startDate,
    startTime,
    endDate,
    endTime,
    guests: draft.guests ?? [],
    meet: Boolean(draft.meet),
    location: draft.location ?? '',
    description: draft.description ?? '',
    colorId: draft.colorId ?? null,
    calendarId: state.calendarId,
  };
}

function toDraft(fields: Fields, base: EventDraft, timeZone: string): EventDraft | string {
  let start: string | null;
  let end: string | null;
  if (fields.allDay) {
    start = fields.startDate;
    end = fields.endDate ? exclusiveEnd(fields.endDate) : null;
  } else {
    start = instantFromFields(fields.startDate, fields.startTime, timeZone);
    end = instantFromFields(fields.endDate, fields.endTime, timeZone);
  }
  if (!start || !end) return 'Pick the dates and times again.';
  const draft: EventDraft = {
    ...base,
    title: fields.title,
    allDay: fields.allDay,
    start,
    end,
    guests: cleanGuestList(fields.guests),
    meet: fields.meet,
    location: fields.location,
    description: fields.description,
    colorId: fields.colorId,
  };
  return timesProblem(draft) ?? draft;
}

function longDate(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function zoneName(timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'long' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value;
  return name ? `${name} (${timeZone})` : timeZone;
}

/** Keep an event's length when its start moves, as Google does. */
function shiftEnd(fields: Fields, next: Partial<Fields>, timeZone: string): Partial<Fields> {
  if (fields.allDay) {
    if (next.startDate && fields.startDate && fields.endDate) {
      const days = Math.round(
        (Date.parse(fields.endDate) - Date.parse(fields.startDate)) / 86_400_000,
      );
      return { ...next, endDate: addDaysToKey(next.startDate, Math.max(0, days)) };
    }
    return next;
  }
  const before = instantFromFields(fields.startDate, fields.startTime, timeZone);
  const end = instantFromFields(fields.endDate, fields.endTime, timeZone);
  const after = instantFromFields(
    next.startDate ?? fields.startDate,
    next.startTime ?? fields.startTime,
    timeZone,
  );
  if (!before || !end || !after) return next;
  const moved = new Date(Date.parse(after) + (Date.parse(end) - Date.parse(before))).toISOString();
  const e = wallFields(moved, timeZone);
  return { ...next, endDate: e.date, endTime: e.time };
}

export function EventEditor({
  state,
  calendars,
  palette,
  timeZone,
  saving,
  onCancel,
  onSave,
  onMoreOptions,
}: {
  state: EditorState | null;
  /** Calendars this account can write to. */
  calendars: CalendarInfo[];
  palette: EventPaletteEntry[];
  timeZone: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: EventDraft, calendarId: string) => void;
  onMoreOptions: (draft: EventDraft, calendarId: string) => void;
}) {
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => (!open && !saving ? onCancel() : undefined)}
    >
      {state ? (
        <EditorBody
          key={`${state.mode}-${state.event?.key ?? 'new'}`}
          state={state}
          calendars={calendars}
          palette={palette}
          timeZone={timeZone}
          saving={saving}
          onCancel={onCancel}
          onSave={onSave}
          onMoreOptions={onMoreOptions}
        />
      ) : null}
    </Dialog>
  );
}

function EditorBody({
  state,
  calendars,
  palette,
  timeZone,
  saving,
  onCancel,
  onSave,
  onMoreOptions,
}: {
  state: EditorState;
  calendars: CalendarInfo[];
  palette: EventPaletteEntry[];
  timeZone: string;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: EventDraft, calendarId: string) => void;
  onMoreOptions: (draft: EventDraft, calendarId: string) => void;
}) {
  const [fields, setFields] = React.useState(() => toFields(state, timeZone));
  const [problem, setProblem] = React.useState<string | null>(null);
  const set = (next: Partial<Fields>) => {
    setProblem(null);
    setFields((f) => ({ ...f, ...next }));
  };
  const isNew = state.event === null;
  const recurring = Boolean(state.event?.recurringEventId);
  const existingMeet = state.event?.meetUrl ?? null;
  const calendar = calendars.find((c) => c.id === fields.calendarId) ?? null;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const draft = toDraft(fields, state.draft, timeZone);
    if (typeof draft === 'string') {
      setProblem(draft);
      return;
    }
    onSave(draft, fields.calendarId);
  };

  if (state.mode === 'quick') {
    const when = fields.allDay
      ? fields.endDate && fields.endDate !== fields.startDate
        ? `${longDate(fields.startDate)} – ${longDate(fields.endDate)}`
        : `${longDate(fields.startDate)} · All day`
      : `${longDate(fields.startDate)} · ${shortTime(state.draft.start, timeZone)} – ${shortTime(state.draft.end, timeZone)}`;
    return (
      <DialogContent title="New event" description={when} className="max-w-md">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Title" htmlFor="quick-title">
            <Input
              id="quick-title"
              autoFocus
              value={fields.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="Add title"
              maxLength={1024}
            />
          </Field>
          {calendars.length > 1 ? (
            <Field label="Calendar" htmlFor="quick-calendar">
              <Select
                id="quick-calendar"
                value={fields.calendarId}
                onChange={(e) => set({ calendarId: e.target.value })}
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {problem ? <p className="text-sm text-[var(--danger)]">{problem}</p> : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const draft = toDraft(fields, state.draft, timeZone);
                if (typeof draft === 'string') setProblem(draft);
                else onMoreOptions(draft, fields.calendarId);
              }}
            >
              More options
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={isNew ? 'New event' : 'Edit event'} className="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title" htmlFor="event-title">
          <Input
            id="event-title"
            autoFocus
            value={fields.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Add title"
            maxLength={1024}
          />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">When</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fields.allDay}
              onChange={(e) => set({ allDay: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
            All day
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor="event-start-date" className="text-xs text-[var(--fg-muted)]">
                  Starts
                </Label>
                <Input
                  id="event-start-date"
                  type="date"
                  value={fields.startDate}
                  onChange={(e) => set(shiftEnd(fields, { startDate: e.target.value }, timeZone))}
                />
              </div>
              {!fields.allDay ? (
                <div className="w-28">
                  <Label htmlFor="event-start-time" className="text-xs text-[var(--fg-muted)]">
                    Start time
                  </Label>
                  <Input
                    id="event-start-time"
                    type="time"
                    step={900}
                    value={fields.startTime}
                    onChange={(e) => set(shiftEnd(fields, { startTime: e.target.value }, timeZone))}
                  />
                </div>
              ) : null}
            </div>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor="event-end-date" className="text-xs text-[var(--fg-muted)]">
                  Ends
                </Label>
                <Input
                  id="event-end-date"
                  type="date"
                  value={fields.endDate}
                  onChange={(e) => set({ endDate: e.target.value })}
                />
              </div>
              {!fields.allDay ? (
                <div className="w-28">
                  <Label htmlFor="event-end-time" className="text-xs text-[var(--fg-muted)]">
                    End time
                  </Label>
                  <Input
                    id="event-end-time"
                    type="time"
                    step={900}
                    value={fields.endTime}
                    onChange={(e) => set({ endTime: e.target.value })}
                  />
                </div>
              ) : null}
            </div>
          </div>
          {!fields.allDay ? (
            <p className="text-xs text-[var(--fg-muted)]">
              Times are in {zoneName(timeZone)}
              {state.draft.timeZone !== timeZone
                ? `; the event keeps its own zone, ${state.draft.timeZone}`
                : ''}
              .
            </p>
          ) : null}
        </fieldset>

        <Field
          label="Calendar"
          htmlFor="event-calendar"
          hint={
            recurring
              ? 'A repeating event moves to another calendar from Google Calendar.'
              : undefined
          }
        >
          <Select
            id="event-calendar"
            value={fields.calendarId}
            disabled={recurring}
            onChange={(e) => set({ calendarId: e.target.value })}
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <GuestInput guests={fields.guests} onChange={(guests) => set({ guests })} />

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fields.meet || Boolean(existingMeet)}
              disabled={Boolean(existingMeet)}
              onChange={(e) => set({ meet: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
            <Video className="size-4 text-[var(--fg-muted)]" aria-hidden />
            Add Google Meet video conferencing
          </label>
          {existingMeet ? (
            <p className="pl-6 text-xs text-[var(--fg-muted)]">
              <a
                href={existingMeet}
                target="_blank"
                rel="noopener noreferrer"
                className="link-inline"
              >
                {existingMeet.replace('https://', '')}
              </a>{' '}
              · remove a Meet link in Google Calendar.
            </p>
          ) : fields.meet ? (
            <p className="pl-6 text-xs text-[var(--fg-muted)]">
              Google makes the link when you save.
            </p>
          ) : null}
        </div>

        <Field label="Location" htmlFor="event-location">
          <Input
            id="event-location"
            value={fields.location}
            onChange={(e) => set({ location: e.target.value })}
            placeholder="Add location"
            maxLength={1024}
          />
        </Field>

        <Field label="Description" htmlFor="event-description">
          <Textarea
            id="event-description"
            value={fields.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Add description"
            maxLength={8000}
            className="min-h-20"
          />
        </Field>

        {palette.length > 0 ? (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Event colour</legend>
            <div
              role="radiogroup"
              aria-label="Event colour"
              className="flex flex-wrap items-center gap-1.5"
            >
              <ColorSwatch
                label={`Calendar colour${calendar ? ` (${calendar.name})` : ''}`}
                background={calendar?.color.background ?? '#9e9e9e'}
                selected={fields.colorId === null}
                onSelect={() => set({ colorId: null })}
              />
              {palette.map((p) => (
                <ColorSwatch
                  key={p.id}
                  label={p.name}
                  background={p.background}
                  selected={fields.colorId === p.id}
                  onSelect={() => set({ colorId: p.id })}
                />
              ))}
            </div>
          </fieldset>
        ) : null}

        {problem ? <p className="text-sm text-[var(--danger)]">{problem}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ColorSwatch({
  label,
  background,
  selected,
  onSelect,
}: {
  label: string;
  background: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        'flex size-7 items-center justify-center rounded-full border-2 transition-transform hover:scale-110',
        selected ? 'border-[var(--fg)]' : 'border-transparent',
      )}
    >
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-full border"
        style={swatchStyle(background)}
      >
        {selected ? <Check className="size-3 text-[#1d1d1d]" /> : null}
      </span>
    </button>
  );
}

/** Guests as chips: type or paste addresses, or pick someone from the network. */
function GuestInput({
  guests,
  onChange,
}: {
  guests: string[];
  onChange: (guests: string[]) => void;
}) {
  const [text, setText] = React.useState('');
  const [suggestions, setSuggestions] = React.useState<{ name: string; email: string }[]>([]);
  const query = text.trim();

  React.useEffect(() => {
    if (query.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void fetchGuests(query).then((res) => {
        if (live) setSuggestions(res.ok ? res.value.people : []);
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const add = (raw: string) => {
    const found = raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().replace(/^<|>$/g, ''))
      .filter((s) => isEmailAddress(s.toLowerCase()));
    if (found.length) onChange(cleanGuestList([...guests, ...found]));
    setText('');
    setSuggestions([]);
  };

  const shownSuggestions =
    query.length >= 2 ? suggestions.filter((s) => !guests.includes(s.email)) : [];

  return (
    <div className="space-y-1.5">
      <Label htmlFor="event-guests">Guests</Label>
      {guests.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Guests added">
          {guests.map((g) => (
            <li
              key={g}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-sunken)] py-0.5 pr-1 pl-2.5 text-sm"
            >
              <span className="min-w-0 truncate">{g}</span>
              <button
                type="button"
                onClick={() => onChange(guests.filter((x) => x !== g))}
                aria-label={`Remove ${g}`}
                className="rounded-full p-0.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative">
        <Input
          id="event-guests"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && guests.length) {
              onChange(guests.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (text.trim() && isEmailAddress(text.trim().toLowerCase())) add(text);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[\s,;]/.test(pasted.trim())) {
              e.preventDefault();
              add(pasted);
            }
          }}
          placeholder="Add guests by email"
          autoComplete="off"
        />
        {shownSuggestions.length ? (
          <ul className="shadow-overlay absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-raised)]">
            {shownSuggestions.map((s) => (
              <li key={s.email}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(s.email)}
                  className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                >
                  <span>{s.name}</span>
                  <span className="text-xs text-[var(--fg-muted)]">{s.email}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="text-xs text-[var(--fg-muted)]">
        Nobody is emailed unless you choose Send when you save.
      </p>
    </div>
  );
}
