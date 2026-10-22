'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { CalendarDays, ChevronLeft, ChevronRight, Layers, Loader2, Plus } from 'lucide-react';
import { keyBelongsToOverlay } from '@/components/shell/page-hotkeys';
import { WebOnly } from '@/components/desktop/desktop-only';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useConfirm } from '@/components/ui/confirm';
import { Composer, type ComposeDraft } from '@/components/inbox/composer';
import {
  changedFields,
  draftFromEvent,
  instantFromFields,
  newAllDayDraft,
  newDraft,
  optimisticEvent,
  wallFields,
} from '@/lib/calendar/draft';
import {
  duplicateDraft,
  eventOptions,
  isColorOnly,
  RSVP_CHOICES,
  withResponse,
  type RsvpResponse,
} from '@/lib/calendar/event-actions';
import {
  guestEmails,
  guestPrompt,
  RECURRING_SCOPES,
  type EventDraft,
  type GuestChoice,
  type GuestPrompt,
  type RecurringScope,
} from '@/lib/calendar/edit-rules';
import {
  daySpan,
  coversDay,
  isDateKey,
  monthWeeks,
  rangeLabel,
  stepDate,
  viewRange,
} from '@/lib/calendar/grid';
import { legendLabels, passesLabelFilter, UNLABELLED } from '@/lib/calendar/labels';
import {
  CALENDAR_VIEWS,
  visibleCalendarIds,
  type CalendarInfo,
  type CalendarRangeData,
  type CalendarViewKind,
  type RangeEvent,
} from '@/lib/calendar/range-types';
import { addDaysToKey, localDateKey } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import {
  createEvent,
  deleteEvent,
  fetchRange,
  recolorEvent,
  relabelEvent,
  respondToEvent,
  savePrefs,
  updateEvent,
} from './calendar-api';
import { CalendarKey, LabelLegend } from './calendar-key';
import { useChoice } from './choice-dialog';
import { EventEditor, type EditorState } from './event-editor';
import { EventPanel, type CardAnchor } from './event-panel';
import { MiniMonth } from './mini-month';
import { MonthGrid } from './month-grid';
import { PHONE_QUERY, PreviewSwitch } from './preview-switch';
import { TimeGrid, type GridChange } from './time-grid';

/**
 * The Calendar tab's Day, Week and Month views, the default (the "New
 * calendar" switch goes back to the day list): like Google Calendar, any
 * date past or future, Today and back and forward, a date picker, all in the
 * address (?view=&date=). Nick's
 * calendars down the side with Google's own names and colours, each one on or
 * off. Every event keeps Copilot's Meeting/Block verdict, and a click on it
 * opens Google Calendar's event card beside it (event-panel.tsx): Edit,
 * Delete, Duplicate, Email guests, its colour, Going? for an invitation, Join.
 *
 * Above the grid, the calendars' colour labels as filter chips and a Key
 * that explains how events look (D-070): the fill is the label's colour,
 * faded once over, outlined with a "?" while unanswered, striped for maybe,
 * struck through when declined, and a bell on a meeting.
 *
 * Changes (with calendar editing on) go through lib/calendar/write.ts. Before
 * any change that involves guests, the page asks Google Calendar's question,
 * "Send … emails to guests?", every time; only Send emails anyone. An answer
 * to an invitation asks "Send your response to the organizer?" the same way.
 * A colour or label change is nobody else's business and is never asked about.
 */

export interface CalendarViewsProps {
  initial: CalendarRangeData;
  view: CalendarViewKind;
  date: string;
  today: string;
  timeZone: string;
  shown: Record<string, boolean>;
  /** The legend's remembered label filter (label keys). */
  labelFilter: string[];
  ownEmails: string[];
  mailbox: string | null;
  editing: { allowed: boolean; reason: string | null; demo: boolean };
  /** "Turn on calendar editing", when it is off and can be turned on. */
  turnOnHref: string | null;
  /** The compose window may send (the opt-in grant); else it offers Copy for Gmail. */
  canSend: boolean;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const VIEW_LABEL: Record<CalendarViewKind, string> = { day: 'Day', week: 'Week', month: 'Month' };

function parseView(value: string | null): CalendarViewKind | null {
  return CALENDAR_VIEWS.includes(value as CalendarViewKind) ? (value as CalendarViewKind) : null;
}

/** What to read for a view: a whole week for Day, so stepping through the week reads nothing. */
function fetchWindow(view: CalendarViewKind, date: string) {
  return viewRange(view === 'day' ? 'week' : view, date);
}

function covers(
  data: CalendarRangeData,
  from: string,
  to: string,
  ids: readonly string[],
): boolean {
  if (data.state !== 'ok' || data.from > from || data.to < to) return false;
  const tried = new Set([...data.loaded, ...data.failed.map((f) => f.calendarId)]);
  return ids.every((id) => tried.has(id));
}

function usePhone(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(PHONE_QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/** The key of a new event on the page while Google is still saving it. */
const PENDING_PREFIX = 'pending-';

/** The repeating-event question, per kind of change. */
const SCOPE_QUESTION: Record<
  'edit' | 'delete' | 'respond' | 'color' | 'label',
  { title: string; description: string }
> = {
  edit: {
    title: 'Change a repeating event',
    description:
      'Apply this to this event only, or to every event in the series. To change this and the following events, or to move the whole series to another day, use Google Calendar.',
  },
  delete: {
    title: 'Delete a repeating event',
    description:
      'Delete this event only, or every event in the series. To delete this and the following events, use Google Calendar.',
  },
  respond: {
    title: 'Answer a repeating event',
    description:
      'Answer for this event only, or for every event in the series. To answer this and the following events, use Google Calendar.',
  },
  color: {
    title: 'Colour a repeating event',
    description: 'Colour this event only, or every event in the series. Nobody is emailed.',
  },
  label: {
    title: 'Label a repeating event',
    description: 'Label this event only, or every event in the series. Nobody is emailed.',
  },
};

export function CalendarViews(props: CalendarViewsProps) {
  const { timeZone, ownEmails, editing } = props;
  const params = useSearchParams();
  const phone = usePhone();
  const urlView = parseView(params.get('view'));
  const urlDate = params.get('date');
  // A phone opens on Day, like Google's app, unless the address names a view.
  const view: CalendarViewKind = urlView ?? (phone ? 'day' : props.view);
  const date = isDateKey(urlDate) ? urlDate : props.date;

  const [current, setCurrent] = React.useState<CalendarRangeData>(props.initial);
  const [shown, setShown] = React.useState<Record<string, boolean>>(props.shown);
  const [labelFilter, setLabelFilter] = React.useState<string[]>(props.labelFilter);
  const [failure, setFailure] = React.useState<{ key: string; message: string } | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);
  const cache = React.useRef(new Map<string, CalendarRangeData>());
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<{ key: string; anchor: CardAnchor } | null>(null);
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [compose, setCompose] = React.useState<ComposeDraft | null>(null);
  // A press outside an open card closes it and does nothing else, as in Google
  // Calendar: it does not also start a new event on the slot pressed.
  const swallowCreate = React.useRef(false);
  const [saving, setSaving] = React.useState(false);
  const [askChoice, choiceDialog] = useChoice();
  const [confirm, confirmDialog] = useConfirm();
  const swipe = React.useRef<{ x: number; y: number } | null>(null);
  const savedView = React.useRef(props.view);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const calendars = current.calendars.length ? current.calendars : props.initial.calendars;
  const palette = current.palette.length ? current.palette : props.initial.palette;
  const calendarsById = React.useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const visibleIds = React.useMemo(() => visibleCalendarIds(calendars, shown), [calendars, shown]);
  const visibleKey = visibleIds.join(',');
  const writable = calendars.filter((c) => c.writable);
  const canEdit = editing.allowed && writable.length > 0;
  const today = nowMs !== null ? localDateKey(new Date(nowMs), timeZone) : props.today;

  // The clock, for the current-time line: only in the browser, so both renders agree.
  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const first = window.setTimeout(tick, 0);
    const every = window.setInterval(tick, 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  const range = viewRange(view, date);
  const window_ = fetchWindow(view, date);
  const needKey = `${window_.from}|${window_.to}|${visibleKey}`;
  const loaded = covers(current, range.from, range.to, visibleIds);

  // Read the range when the view moves past what is loaded (or a calendar is turned on).
  React.useEffect(() => {
    if (covers(current, range.from, range.to, visibleIds) && reloadToken === 0) return;
    let live = true;
    const hit = reloadToken === 0 ? cache.current.get(needKey) : undefined;
    const read = hit
      ? Promise.resolve({ ok: true as const, value: hit })
      : fetchRange(window_.from, window_.to, visibleIds);
    void read.then((res) => {
      if (!live) return;
      if (reloadToken) setReloadToken(0);
      if (!res.ok) {
        setFailure({ key: needKey, message: res.message });
        return;
      }
      cache.current.set(needKey, res.value);
      if (cache.current.size > 12) cache.current.delete(cache.current.keys().next().value!);
      setFailure(null);
      setCurrent(res.value);
    });
    return () => {
      live = false;
    };
    // `current` is read for the coverage check only; a change to it never needs a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, reloadToken]);

  const reload = React.useCallback(() => {
    cache.current.clear();
    setReloadToken((n) => n + 1);
  }, []);

  /* ------------------------------------------------------------ moving */

  const go = React.useCallback(
    (next: { view?: CalendarViewKind; date?: string }) => {
      const v = next.view ?? view;
      const d = next.date ?? date;
      const href = `/calendar?view=${v}&date=${d}`;
      // Today on today (or a view already shown) adds no step to Back.
      if (`${window.location.pathname}${window.location.search}` !== href) {
        window.history.pushState(null, '', href);
      }
      if (next.view && next.view !== savedView.current) {
        savedView.current = next.view;
        void savePrefs({ view: next.view, preview: true });
      }
    },
    [view, date],
  );

  const step = React.useCallback(
    (delta: number) => go({ date: stepDate(view, date, delta) }),
    [go, view, date],
  );

  // Whether a card or the quick editor is open, for the press-outside check below.
  const cardOpen = React.useRef(false);
  React.useEffect(() => {
    cardOpen.current = selected !== null || editor?.mode === 'quick';
  });
  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!cardOpen.current) return;
      const target = e.target instanceof Element ? e.target : null;
      // Inside the card, or a question asked over it: not a press outside.
      if (target?.closest('[data-event-card], [data-quick-editor], [role="dialog"]')) return;
      swallowCreate.current = true;
      const clear = () =>
        window.setTimeout(() => {
          swallowCreate.current = false;
        }, 0);
      window.addEventListener('pointerup', clear, { once: true });
      window.addEventListener('pointercancel', clear, { once: true });
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  /* ------------------------------------------------------- the questions */

  const askScope = React.useCallback(
    (action: 'edit' | 'delete' | 'respond' | 'color' | 'label') =>
      askChoice<RecurringScope>({
        ...SCOPE_QUESTION[action],
        choices: RECURRING_SCOPES.map((s) => ({
          value: s.value,
          label: s.label,
          tone: s.value === 'this' ? 'primary' : 'secondary',
        })),
      }),
    [askChoice],
  );

  const askGuests = React.useCallback(
    (prompt: GuestPrompt) =>
      askChoice<GuestChoice>({
        title: prompt.title,
        description: prompt.description,
        details: [
          ...prompt.added.map((g) => `Added: ${g}`),
          ...prompt.removed.map((g) => (prompt.kind === 'cancel' ? g : `Removed: ${g}`)),
        ],
        choices: [
          { value: 'dont_send', label: "Don't send" },
          { value: 'send', label: 'Send', tone: 'primary' },
        ],
      }),
    [askChoice],
  );

  /* ---------------------------------------------- the events, optimistic */

  const putEvent = React.useCallback((key: string, next: RangeEvent | null, insert = false) => {
    // Other ranges read earlier may hold the event as it was: read them again.
    cache.current.clear();
    setCurrent((c) => {
      const has = c.events.some((e) => e.key === key);
      const events = has
        ? c.events.flatMap((e) => (e.key === key ? (next ? [next] : []) : [e]))
        : insert && next
          ? [...c.events, next]
          : c.events;
      return { ...c, events };
    });
  }, []);

  const notifyNote = (notify: GuestChoice, kind: 'saved' | 'deleted') =>
    `${kind === 'saved' ? 'Saved' : 'Deleted'}${notify === 'send' ? '; Google is emailing the guests' : ''}.`;

  const defaultCalendarId = (writable.find((c) => c.primary) ?? writable[0])?.id ?? null;

  const openCreate = (draft: EventDraft, mode: 'quick' | 'full') => {
    if (!canEdit || !defaultCalendarId) {
      toast.message(editing.reason ?? 'Events cannot be added here.');
      return;
    }
    setSelected(null);
    setEditor({ mode, event: null, draft, calendarId: defaultCalendarId });
  };

  // From the grid: not when the press only closed an open card.
  const createAt = (r: GridChange) => {
    if (swallowCreate.current) return;
    openCreate(newDraft(r.start, r.end, timeZone), 'quick');
  };
  /** An all-day event on one day, or across the days dragged over (`endKey` exclusive). */
  const createAllDay = (day: string, endKey = addDaysToKey(day, 1)) => {
    if (swallowCreate.current) return;
    openCreate(newAllDayDraft(day, endKey, timeZone), 'quick');
  };
  const createNow = () => {
    const base = date === today && nowMs !== null ? new Date(nowMs) : null;
    const start = base
      ? new Date(Math.ceil(base.getTime() / 1_800_000) * 1_800_000)
      : new Date(instantFromFields(date, '09:00', timeZone) ?? Date.now());
    openCreate(newDraft(start, new Date(start.getTime() + 3_600_000), timeZone), 'full');
  };

  /** `heading` is the editor's own (Duplicate event), kept if it has to reopen. */
  async function saveNew(draft: EventDraft, calendarId: string, heading?: string) {
    const prompt = guestPrompt('create', [], draft.guests ?? []);
    let notify: GuestChoice = 'dont_send';
    if (prompt) {
      const answer = await askGuests(prompt);
      if (!answer) return;
      notify = answer;
    }
    const calendar = calendarsById.get(calendarId);
    if (!calendar) return;
    const tempKey = `${PENDING_PREFIX}${Date.now()}`;
    setEditor(null);
    putEvent(tempKey, optimisticEvent(null, draft, calendar, palette, tempKey), true);
    setSaving(true);
    const res = await createEvent(calendarId, draft, notify);
    setSaving(false);
    if (!res.ok) {
      putEvent(tempKey, null);
      toast.error(res.message);
      // Reopened as it was: a failed Duplicate is still "Duplicate event".
      setEditor({ mode: 'full', event: null, draft, calendarId, ...(heading ? { heading } : {}) });
      return;
    }
    putEvent(tempKey, res.value.event);
    // Opened while it was saving: the card follows it to the id Google gave it.
    const saved = res.value.event;
    if (saved) setSelected((s) => (s && s.key === tempKey ? { ...s, key: saved.key } : s));
    if (res.value.event && !visibleIds.includes(calendarId)) reload();
    toast.success(notifyNote(notify, 'saved'));
  }

  async function commitUpdate(
    event: RangeEvent,
    changes: Partial<EventDraft>,
    destination: string | null,
    reopen?: { draft: EventDraft; calendarId: string },
  ): Promise<void> {
    const calendar = calendarsById.get(destination ?? event.calendarId);
    if (!calendar) return;
    // As in Google Calendar, a dragged event stays where it was dropped while
    // the questions are asked; Cancel puts it back. Nothing is saved before.
    putEvent(event.key, optimisticEvent(event, changes, calendar, palette, event.key));
    const putBack = () => putEvent(event.key, event);
    let scope: RecurringScope = 'this';
    if (event.recurringEventId) {
      const answer = await askScope('edit');
      if (!answer) return putBack();
      scope = answer;
    }
    const before = guestEmails(event.attendees, ownEmails);
    // A colour alone tells nobody (Google keeps it to the viewer): no question.
    const prompt =
      isColorOnly(changes) && !destination
        ? null
        : guestPrompt('update', before, changes.guests ?? before);
    let notify: GuestChoice = 'dont_send';
    if (prompt) {
      const answer = await askGuests(prompt);
      if (!answer) return putBack();
      notify = answer;
    }
    setEditor(null);
    setSaving(true);
    const res = await updateEvent({
      calendarId: event.calendarId,
      eventId: event.id,
      scope,
      notify,
      changes,
      destinationCalendarId: destination,
    });
    setSaving(false);
    if (!res.ok) {
      putEvent(event.key, event);
      toast.error(res.message);
      if (reopen) setEditor({ mode: 'full', event, ...reopen });
      return;
    }
    if (res.value.reload || !res.value.event) {
      reload();
    } else if (res.value.event.key !== event.key) {
      putEvent(event.key, null);
      putEvent(res.value.event.key, res.value.event, true);
    } else {
      putEvent(event.key, res.value.event);
    }
    toast.success(notifyNote(notify, 'saved'));
  }

  async function saveEdit(event: RangeEvent, draft: EventDraft, calendarId: string) {
    const changes = changedFields(draftFromEvent(event, timeZone, ownEmails), draft);
    const destination = calendarId !== event.calendarId ? calendarId : null;
    if (Object.keys(changes).length === 0 && !destination) {
      setEditor(null);
      return;
    }
    await commitUpdate(event, changes, destination, { draft, calendarId });
  }

  async function remove(event: RangeEvent) {
    let scope: RecurringScope = 'this';
    let asked = false;
    if (event.recurringEventId) {
      const answer = await askScope('delete');
      if (!answer) return;
      scope = answer;
      asked = true;
    }
    const prompt = guestPrompt('delete', guestEmails(event.attendees, ownEmails), []);
    let notify: GuestChoice = 'dont_send';
    if (prompt) {
      const answer = await askGuests(prompt);
      if (!answer) return;
      notify = answer;
      asked = true;
    }
    if (!asked) {
      const sure = await confirm({
        title: 'Delete this event?',
        description: `“${event.title}” comes off the calendar in Google too.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!sure) return;
    }
    setSelected(null);
    putEvent(event.key, null);
    const res = await deleteEvent({
      calendarId: event.calendarId,
      eventId: event.id,
      scope,
      notify,
    });
    if (!res.ok) {
      putEvent(event.key, event, true);
      toast.error(res.message);
      return;
    }
    if (res.value.reload) reload();
    toast.success(notifyNote(notify, 'deleted'));
  }

  /* ------------------------------------------- the event card's quick taps */

  /**
   * Going? Yes / No / Maybe. Google emails the organizer the answer, so it
   * asks every time whether to send it; Cancel (or Esc) changes nothing, and
   * nothing defaults to Send.
   */
  async function respond(event: RangeEvent, response: RsvpResponse) {
    if (event.myResponse === response) return;
    let scope: RecurringScope = 'this';
    if (event.recurringEventId) {
      const answer = await askScope('respond');
      if (!answer) return;
      scope = answer;
    }
    const label = RSVP_CHOICES.find((c) => c.value === response)?.label ?? response;
    const who = event.organizer?.name ?? event.organizer?.email ?? 'the organizer';
    const notify = await askChoice<GuestChoice>({
      title: 'Send your response to the organizer?',
      description: `Google Calendar can email ${who} that your answer is “${label}”.`,
      choices: [
        { value: 'dont_send', label: "Don't send" },
        { value: 'send', label: 'Send', tone: 'primary' },
      ],
    });
    if (!notify) return;
    putEvent(event.key, withResponse(event, response, ownEmails));
    const res = await respondToEvent({
      calendarId: event.calendarId,
      eventId: event.id,
      scope,
      response,
      notify,
    });
    if (!res.ok) {
      putEvent(event.key, event);
      toast.error(res.message);
      return;
    }
    if (res.value.reload || !res.value.event) reload();
    else putEvent(event.key, res.value.event);
    toast.success(notify === 'send' ? 'Saved; Google is telling the organizer.' : 'Saved.');
  }

  /** A colour from the card: colorId alone, never a question about guests, never an email. */
  async function recolor(event: RangeEvent, colorId: string | null) {
    if ((event.colorId ?? null) === colorId) return;
    const calendar = calendarsById.get(event.calendarId);
    if (!calendar) return;
    let scope: RecurringScope = 'this';
    if (event.recurringEventId) {
      const answer = await askScope('color');
      if (!answer) return;
      scope = answer;
    }
    putEvent(event.key, optimisticEvent(event, { colorId }, calendar, palette, event.key));
    const res = await recolorEvent({
      calendarId: event.calendarId,
      eventId: event.id,
      scope,
      colorId,
    });
    if (!res.ok) {
      putEvent(event.key, event);
      toast.error(res.message);
      return;
    }
    if (res.value.reload || !res.value.event) reload();
    else putEvent(event.key, res.value.event);
  }

  /**
   * A colour label from the card (or a suggested label, tapped): the label
   * alone, never a question about guests, never an email. The suggestion is
   * only ever applied here, by that tap.
   */
  async function relabel(event: RangeEvent, labelId: string | null) {
    if ((event.label ? event.labelId : null) === labelId) return;
    const calendar = calendarsById.get(event.calendarId);
    if (!calendar) return;
    let scope: RecurringScope = 'this';
    if (event.recurringEventId) {
      const answer = await askScope('label');
      if (!answer) return;
      scope = answer;
    }
    putEvent(event.key, optimisticEvent(event, { labelId }, calendar, palette, event.key));
    const res = await relabelEvent({
      calendarId: event.calendarId,
      eventId: event.id,
      scope,
      labelId,
    });
    if (!res.ok) {
      putEvent(event.key, event);
      toast.error(res.message);
      return;
    }
    if (res.value.reload || !res.value.event) reload();
    else putEvent(event.key, res.value.event);
  }

  /** Google's Duplicate: the editor, prefilled, for a new event on the same calendar. */
  const duplicate = (event: RangeEvent) => {
    const calendarId = calendarsById.get(event.calendarId)?.writable
      ? event.calendarId
      : defaultCalendarId;
    if (!canEdit || !calendarId) return;
    setSelected(null);
    const draft = duplicateDraft(event, timeZone, ownEmails);
    setEditor({
      mode: 'full',
      event: null,
      // A label belongs to its calendar: a copy on another calendar starts without one.
      draft: calendarId === event.calendarId ? draft : { ...draft, labelId: null },
      calendarId,
      heading: 'Duplicate event',
    });
  };

  /** The compose window with the guests: a draft, sent only by its own Send. */
  const emailGuests = (event: RangeEvent) => {
    const to = guestEmails(event.attendees, ownEmails);
    if (!to.length) return;
    setSelected(null);
    setCompose({
      to: to.join(', '),
      subject: event.title === '(no title)' ? '' : event.title,
      body: '',
    });
  };

  const changeTimes = (event: RangeEvent, next: GridChange) =>
    void commitUpdate(
      event,
      {
        allDay: false,
        start: next.start.toISOString(),
        end: next.end.toISOString(),
        timeZone: event.timeZone ?? timeZone,
      },
      null,
    );

  const shiftDays = (event: RangeEvent, days: number) => {
    if (event.allDay && event.startDate) {
      const end = event.endDate ?? addDaysToKey(event.startDate, 1);
      void commitUpdate(
        event,
        {
          allDay: true,
          start: addDaysToKey(event.startDate, days),
          end: addDaysToKey(end, days),
          timeZone: event.timeZone ?? timeZone,
        },
        null,
      );
      return;
    }
    if (!event.startsAt || !event.endsAt) return;
    const move = (instant: string) => {
      const f = wallFields(instant, timeZone);
      return instantFromFields(addDaysToKey(f.date, days), f.time, timeZone);
    };
    const start = move(event.startsAt);
    const end = move(event.endsAt);
    if (start && end) changeTimes(event, { start: new Date(start), end: new Date(end) });
  };

  /* ---------------------------------------------------------- keyboard */

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (keyBelongsToOverlay(e)) return;
      const act = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      switch (e.key) {
        case 't':
          return act(() => go({ date: today }));
        case 'j':
        case 'n':
        case 'ArrowRight':
          return act(() => step(1));
        case 'k':
        case 'p':
        case 'ArrowLeft':
          return act(() => step(-1));
        case 'd':
          return act(() => go({ view: 'day' }));
        case 'w':
          return act(() => go({ view: 'week' }));
        case 'm':
          return act(() => go({ view: 'month' }));
        case 'c':
          if (canEdit) act(createNow);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ------------------------------------------------------- the toggles */

  const toggleCalendar = (calendar: CalendarInfo, on: boolean) => {
    setShown((s) => ({ ...s, [calendar.id]: on }));
    void savePrefs({ shown: { [calendar.id]: on } }).then((res) => {
      if (!res.ok) toast.error('That calendar choice could not be remembered.');
    });
  };

  /** The legend's chips: a tap shows only that label's events (several add up); remembered. */
  const saveLabelFilter = (next: string[]) => {
    setLabelFilter(next);
    void savePrefs({ labelFilter: next }).then((res) => {
      if (!res.ok) toast.error('That label filter could not be remembered.');
    });
  };
  const toggleLabel = (key: string) =>
    saveLabelFilter(
      labelFilter.includes(key) ? labelFilter.filter((k) => k !== key) : [...labelFilter, key],
    );

  /* -------------------------------------------------------------- draw */

  const visible = new Set(visibleIds);
  const legend = legendLabels(calendars, visibleIds);
  // Only keys that still name a label shown (a label renamed in Google drops out of the filter).
  const legendKeys = new Set([...legend.map((l) => l.key), UNLABELLED]);
  const activeFilter = legend.length ? labelFilter.filter((k) => legendKeys.has(k)) : [];
  const events = current.events.filter((e) => visible.has(e.calendarId));
  const inRange = events.filter((e) => {
    const span = daySpan(e, timeZone);
    return span ? range.days.some((d) => coversDay(span, d)) : false;
  });
  const inView = inRange.filter((e) => passesLabelFilter(e, activeFilter));
  const sampleColor = legend[0]?.color ??
    calendars.find((c) => c.primary)?.color ?? { background: '#4986e7', foreground: '#ffffff' };
  const selectedEvent = selected
    ? (current.events.find((e) => e.key === selected.key) ?? null)
    : null;
  const selectedCalendar = selectedEvent
    ? (calendarsById.get(selectedEvent.calendarId) ?? null)
    : null;
  const selectedOptions = selectedEvent
    ? eventOptions(selectedEvent, {
        // Still saving: nothing to change until Google has it (the card then follows it).
        editing: editing.allowed && !selectedEvent.key.startsWith(PENDING_PREFIX),
        calendarWritable: Boolean(selectedCalendar?.writable),
        ownEmails,
      })
    : null;
  const pending =
    editor?.mode === 'quick' && editor.event === null
      ? { allDay: editor.draft.allDay, start: editor.draft.start, end: editor.draft.end }
      : null;
  const openEvent = (event: RangeEvent, element: HTMLElement | null) =>
    setSelected({ key: event.key, anchor: { element } });
  const failedNames = current.failed
    .map((f) => calendarsById.get(f.calendarId)?.name)
    .filter((n): n is string => Boolean(n));
  const stepLabel = VIEW_LABEL[view].toLowerCase();
  const highlight = new Set(range.days);

  const calendarList = (
    <ul className="space-y-1">
      {calendars.map((c) => {
        const on = visible.has(c.id);
        return (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-[var(--bg-hover)]">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => toggleCalendar(c, e.target.checked)}
                className="size-4 shrink-0"
                style={{ accentColor: c.color.background }}
              />
              <span className="min-w-0 flex-1 truncate" title={c.name}>
                {c.name}
              </span>
              {!c.writable ? (
                <span className="text-micro text-[var(--fg-subtle)]">View only</span>
              ) : null}
            </label>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="space-y-3">
      <div data-tour="calendar-views" className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Button variant="secondary" size="sm" onClick={() => go({ date: today })}>
          Today
        </Button>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => step(-1)}
            aria-label={`Previous ${stepLabel}`}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => step(1)}
            aria-label={`Next ${stepLabel}`}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <h2 className="min-w-0 font-serif text-lg leading-tight font-semibold" aria-live="polite">
          {rangeLabel(view, date)}
        </h2>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Pick a date">
              <CalendarDays aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72">
            <MiniMonth
              selected={date}
              today={today}
              highlight={highlight}
              onPick={(d) => {
                // Like Google's date picker: picking a day goes there and closes it.
                setPickerOpen(false);
                go({ date: d });
              }}
            />
          </PopoverContent>
        </Popover>
        {!loaded ? (
          <Loader2 className="size-4 animate-spin text-[var(--fg-muted)]" aria-label="Loading" />
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button variant="primary" size="sm" onClick={createNow}>
              <Plus aria-hidden /> Create
            </Button>
          ) : null}
          <div
            role="group"
            aria-label="View"
            className="inline-flex rounded-md border border-[var(--border-strong)] p-0.5"
          >
            {CALENDAR_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => go({ view: v })}
                className={cn(
                  'rounded-[5px] px-2.5 py-1 text-sm',
                  v === view
                    ? 'bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
                )}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="xl:hidden">
                <Layers aria-hidden /> Calendars
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72">{calendarList}</PopoverContent>
          </Popover>
          <PreviewSwitch on openHref="/calendar" />
        </div>
      </div>

      {!editing.allowed ? (
        <Notice>
          <span>View only. {editing.reason}</span>{' '}
          {props.turnOnHref ? (
            <WebOnly fallback={<span>Turn it on from Copilot in your web browser.</span>}>
              <a href={props.turnOnHref} className="link-inline font-medium">
                Turn on calendar editing
              </a>
            </WebOnly>
          ) : null}
        </Notice>
      ) : editing.demo ? (
        <p className="text-xs text-[var(--fg-muted)]">
          Demo calendar: changes stay on this server and never reach Google.
        </p>
      ) : null}
      {current.state === 'not_connected' ? (
        <Notice tone="warn">
          No calendar is connected. Connect Google in Settings › Integrations.
        </Notice>
      ) : current.state === 'error' ? (
        <Notice tone="warn">
          {current.message ?? 'Google Calendar did not answer. Try again.'}
        </Notice>
      ) : null}
      {failure && failure.key === needKey ? <Notice tone="warn">{failure.message}</Notice> : null}
      {failedNames.length ? (
        <Notice tone="warn">Could not read {failedNames.join(', ')} this time.</Notice>
      ) : null}

      {/* The month and the calendars sit beside the grid from 1280px; on a
          laptop narrower than that they would squeeze Week's columns to
          about 60px, too narrow for two events side by side at the minimum
          width, so they move behind the Calendars button and the date
          picker instead. */}
      <div className="grid gap-4 xl:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="hidden space-y-4 xl:block">
          <MiniMonth
            selected={date}
            today={today}
            highlight={highlight}
            onPick={(d) => go({ date: d })}
          />
          <div data-tour="calendar-list">
            <p className="text-micro mb-1 px-1.5 font-medium tracking-[0.12em] text-[var(--label-gold)] uppercase">
              Calendars
            </p>
            {calendarList}
          </div>
        </aside>

        <div
          className="min-w-0 space-y-2"
          aria-busy={!loaded}
          onTouchStart={(e) => {
            const t = e.touches[0];
            if (t) swipe.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            const start = swipe.current;
            swipe.current = null;
            const t = e.changedTouches[0];
            if (!start || !t) return;
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
          }}
        >
          <div className="flex min-w-0 items-start gap-2">
            <CalendarKey labels={legend} sample={sampleColor} />
            <LabelLegend
              labels={legend}
              filter={activeFilter}
              onToggle={toggleLabel}
              onClear={() => saveLabelFilter([])}
            />
          </div>
          {view === 'month' ? (
            <MonthGrid
              weeks={monthWeeks(date)}
              monthOf={date}
              events={inView}
              timeZone={timeZone}
              today={today}
              nowMs={nowMs}
              calendars={calendarsById}
              canEdit={canEdit}
              compact={phone}
              pending={pending}
              onOpen={openEvent}
              onPickDay={(d) => go({ view: 'day', date: d })}
              onCreateAllDay={createAllDay}
              onShiftDays={shiftDays}
            />
          ) : (
            <TimeGrid
              days={range.days}
              events={inView}
              timeZone={timeZone}
              today={today}
              nowMs={nowMs}
              calendars={calendarsById}
              canEdit={canEdit}
              pending={pending}
              onOpen={openEvent}
              onCreate={createAt}
              onCreateAllDay={createAllDay}
              onChange={changeTimes}
              onShiftDays={shiftDays}
              onPickDay={(d) => go({ view: 'day', date: d })}
            />
          )}
          {loaded && current.state === 'ok' && inView.length === 0 ? (
            <p className="mt-2 text-center text-sm text-[var(--fg-subtle)]">
              {inRange.length > 0
                ? `Nothing with ${activeFilter.length === 1 ? 'that label' : 'those labels'} ${view === 'day' ? 'this day' : `this ${view}`}.`
                : `Nothing on the calendar ${view === 'day' ? 'this day' : `this ${view}`}.`}
            </p>
          ) : null}
        </div>
      </div>

      <EventPanel
        event={selectedEvent}
        anchor={selected?.anchor ?? null}
        phone={phone}
        calendar={selectedCalendar}
        palette={palette}
        options={selectedOptions}
        timeZone={timeZone}
        nowMs={nowMs}
        today={today}
        ownEmails={ownEmails}
        mailbox={props.mailbox}
        editing={editing.allowed}
        editingOffReason={editing.reason}
        turnOnHref={props.turnOnHref}
        // Only this card: one closing as another opens leaves the new one open.
        onClose={() => {
          const key = selected?.key;
          setSelected((s) => (s && s.key === key ? null : s));
        }}
        onDuplicate={duplicate}
        onColor={(event, colorId) => void recolor(event, colorId)}
        onLabel={(event, labelId) => void relabel(event, labelId)}
        onRespond={(event, response) => void respond(event, response)}
        onEmailGuests={emailGuests}
        onEdit={(event) => {
          setSelected(null);
          setEditor({
            mode: 'full',
            event,
            draft: draftFromEvent(event, timeZone, ownEmails),
            calendarId: event.calendarId,
          });
        }}
        onDelete={(event) => void remove(event)}
      />

      <EventEditor
        state={editor}
        phone={phone}
        calendars={writable}
        palette={palette}
        timeZone={timeZone}
        saving={saving}
        onCancel={() => setEditor(null)}
        onSave={(draft, calendarId) => {
          const event = editor?.event ?? null;
          if (event) void saveEdit(event, draft, calendarId);
          else void saveNew(draft, calendarId, editor?.heading);
        }}
        onMoreOptions={(draft, calendarId) =>
          setEditor({ mode: 'full', event: null, draft, calendarId })
        }
      />
      {compose ? (
        <Composer
          title="Email guests"
          initial={compose}
          canSend={props.canSend}
          onClose={() => setCompose(null)}
        />
      ) : null}
      {choiceDialog}
      {confirmDialog}
    </div>
  );
}
