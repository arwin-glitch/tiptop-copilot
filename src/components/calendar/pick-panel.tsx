'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Copy, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input, Select, Switch } from '@/components/ui/form';
import { useConfirm } from '@/components/ui/confirm';
import {
  checkPickRanges,
  PICK_DURATIONS,
  PICK_HOLD_HOURS,
  PICK_HOLD_LABEL,
  PICK_NAME_MAX,
  PICKS_NOT_SET_UP,
  type PickHoldHours,
  type PickRange,
  type PickView,
} from '@/lib/booking/picks';
import { formatPickText, rangeLabel } from '@/lib/booking/picks-format';
import { dayKeyIn, dayLabel, slotLabel, zoneName } from '@/lib/booking/public';
import {
  defaultPickZone,
  freshRanges,
  holdUntilLabel,
  pickZoneOptions,
} from '@/lib/calendar/pick-selection';
import { cn } from '@/lib/util/cn';
import { copyPickAgain, createPick, revokePick, type PickListAnswer } from './picks-api';
import type { PickedSlot } from './time-grid';

/**
 * The Pick times panel (Vimcal-style): beside the Day or Week grid while
 * picking, a sheet along the bottom on a phone. Not a popover: it stays open
 * while Nick clicks the grid (and is marked data-event-card, so a press on it
 * is never taken for a press outside a card).
 *
 * It holds the meeting's length, call or in person, the other person's zone
 * and name, and whether the times are held; lists the times picked, by day in
 * their zone, with a dot where one overlaps an event; previews the words that
 * will be copied; and "Copy times and link" makes the pick on the server and
 * puts its text (plain and HTML) on the clipboard. Below, the picks still
 * open, each to copy again or cancel.
 */

export interface PickPanelProps {
  phone: boolean;
  /** Nick's profile zone: the default for theirs, and the zone "held until" is told in. */
  hostZone: string;
  /** The times picked so far, merged and in order. */
  ranges: readonly PickRange[];
  /**
   * The picked times as the grid draws them (ahead, fitting the meeting),
   * each with whether it overlaps an event and who already holds it.
   */
  slots: readonly PickedSlot[];
  duration: number;
  onDuration: (minutes: number) => void;
  /** GET /api/booking/picks, or null while it is read. */
  status: PickListAnswer | null;
  statusError: string | null;
  nowMs: number | null;
  onRemove: (start: string) => void;
  onClear: () => void;
  /** Copied: leave Pick times. */
  onDone: () => void;
  /** A pick was made or cancelled: read the open picks again. */
  onPicksChanged: () => void;
  onClose: () => void;
}

/**
 * The clipboard gets the pick's text as plain text and HTML. The content is
 * handed over as a promise, so the browser still counts the copy as the
 * click's own while the server makes the pick (Safari refuses a copy made
 * after an await otherwise). A browser without rich copy gets the plain text.
 */
async function copyRich(content: Promise<{ text: string; html: string }>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': content.then((c) => new Blob([c.text], { type: 'text/plain' })),
            'text/html': content.then((c) => new Blob([c.html], { type: 'text/html' })),
          }),
        ]);
        return true;
      } catch {
        // Falls through to the plain copy.
      }
    }
    const c = await content;
    await navigator.clipboard.writeText(c.text);
    return true;
  } catch {
    return false;
  }
}

export function PickPanel(props: PickPanelProps) {
  const { phone, hostZone, ranges, slots, duration, status, nowMs } = props;
  const [meetingType, setMeetingType] = React.useState<'call' | 'in_person'>('call');
  const [zone, setZone] = React.useState(() => defaultPickZone(hostZone));
  const [name, setName] = React.useState('');
  const [hold, setHold] = React.useState(true);
  const [holdHours, setHoldHours] = React.useState<PickHoldHours>(48);
  const [copying, setCopying] = React.useState(false);
  const [busyPick, setBusyPick] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const uid = React.useId();

  const zones = React.useMemo(() => pickZoneOptions(hostZone), [hostZone]);
  // The page's clock (a minute at a time); Copy reads the time again itself.
  const now = new Date(nowMs ?? 0);
  const fresh = freshRanges(ranges, now, duration);
  const check = fresh.length ? checkPickRanges(fresh, duration, now) : null;
  const problem = check && !check.ok ? check.problem : null;
  const slotByStart = new Map(slots.map((s) => [s.start, s]));
  const anyBusy = fresh.some((r) => slotByStart.get(r.start)?.busy);
  const heldNames = [
    ...new Set(fresh.map((r) => slotByStart.get(r.start)?.heldFor).filter((n): n is string => !!n)),
  ];
  // Every picked time already held for someone else: the link would offer nothing.
  const allHeld = fresh.length > 0 && fresh.every((r) => slotByStart.get(r.start)?.heldFor);
  const preview = fresh.length
    ? formatPickText({ ranges: fresh, timeZone: zone, url: null }).text
    : '';
  const available = status?.available ?? false;
  const linkReady = status?.linkReady ?? false;
  const ready = status !== null && available && linkReady;
  const canCopy = ready && fresh.length > 0 && !problem && !allHeld && !copying;
  const openPicks = (status?.picks ?? []).filter(
    (p) => p.status === 'open' && Date.parse(p.expiresAt) > now.getTime(),
  );

  // The picked times grouped by day in their zone, days in order.
  const days: { key: string; label: string; ranges: PickRange[] }[] = [];
  for (const range of fresh) {
    const key = dayKeyIn(range.start, zone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.ranges.push(range);
    else days.push({ key, label: dayLabel(range.start, zone), ranges: [range] });
  }

  async function copy() {
    if (!canCopy) return;
    const toSend = freshRanges(ranges, new Date(), duration);
    if (!toSend.length) return;
    setCopying(true);
    const created = createPick({
      ranges: toSend,
      durationMinutes: duration,
      meetingType,
      recipientTimeZone: zone,
      recipientName: name.trim() || null,
      hold,
      holdHours,
    });
    const content = created.then((res) => {
      if (!res.ok) throw new Error(res.message);
      return { text: res.value.text, html: res.value.html };
    });
    const copied = copyRich(content);
    const res = await created;
    const ok = await copied;
    setCopying(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    props.onPicksChanged();
    if (!ok) {
      // The link exists: it waits under Open picks to copy again.
      props.onClear();
      toast.error('The link is made but could not be copied. Use Copy again below.');
      return;
    }
    toast.success('Copied. Paste it into your email.');
    if (res.value.warning) toast.message(res.value.warning);
    props.onDone();
  }

  async function copyAgain(pick: PickView) {
    setBusyPick(pick.id);
    const answer = copyPickAgain(pick.id);
    const copied = copyRich(
      answer.then((res) => {
        if (!res.ok) throw new Error(res.message);
        return { text: res.value.text, html: res.value.html };
      }),
    );
    const res = await answer;
    const ok = await copied;
    setBusyPick(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    if (ok) toast.success('Copied. Paste it into your email.');
    else toast.error('Could not copy. Try again.');
  }

  async function cancel(pick: PickView) {
    const sure = await confirm({
      title: 'Cancel these picked times?',
      description: 'The link stops working and the times are no longer held.',
      confirmLabel: 'Cancel times',
      cancelLabel: 'Keep',
      tone: 'danger',
    });
    if (!sure) return;
    setBusyPick(pick.id);
    const res = await revokePick(pick.id);
    setBusyPick(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    toast.success('Cancelled. The link no longer works.');
    props.onPicksChanged();
  }

  const header = (
    <div className="flex items-center gap-2">
      <h2 className="min-w-0 flex-1 font-serif text-base font-semibold">
        Pick times
        {fresh.length ? (
          <span className="ml-1.5 text-sm font-normal text-[var(--fg-muted)]">
            {fresh.length} picked
          </span>
        ) : null}
      </h2>
      {phone ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Show less' : 'Show more'}
        >
          {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      ) : null}
      <Button variant="ghost" size="icon" onClick={props.onClose} aria-label="Stop picking times">
        <X aria-hidden />
      </Button>
    </div>
  );

  const copyButton =
    status !== null && available && !linkReady ? null : (
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        onClick={() => void copy()}
        disabled={!canCopy}
      >
        {copying ? <Loader2 className="animate-spin" aria-hidden /> : <Copy aria-hidden />}
        Copy times and link
      </Button>
    );

  const notices =
    props.statusError && status === null ? (
      <Notice tone="warn">{props.statusError}</Notice>
    ) : status === null ? (
      <p className="text-xs text-[var(--fg-muted)]">Loading…</p>
    ) : !available ? (
      <Notice tone="warn">{PICKS_NOT_SET_UP}</Notice>
    ) : !linkReady ? (
      <Notice>
        Pick times uses your booking link. Set it up on the{' '}
        <Link href="/booking" className="link-inline font-medium">
          Booking tab
        </Link>{' '}
        first.
      </Notice>
    ) : null;

  const body = (
    <div className="space-y-4">
      {notices}

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-[var(--fg-muted)]">Length</legend>
        <div role="group" aria-label="Meeting length" className="flex flex-wrap gap-1.5">
          {PICK_DURATIONS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === duration}
              onClick={() => props.onDuration(m)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                m === duration
                  ? 'border-[var(--primary)] bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                  : 'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
              )}
            >
              {m} min
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-[var(--fg-muted)]">Meeting</legend>
        <div role="group" aria-label="Meeting type" className="flex flex-wrap gap-1.5">
          {(
            [
              ['call', 'Video call'],
              ['in_person', 'In person'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={meetingType === value}
              onClick={() => setMeetingType(value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                meetingType === value
                  ? 'border-[var(--primary)] bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                  : 'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {meetingType === 'in_person' ? (
          <p className="text-xs text-[var(--fg-muted)]">They pick the place when they book.</p>
        ) : null}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        <div className="space-y-1">
          <label htmlFor={`${uid}-zone`} className="text-xs font-medium text-[var(--fg-muted)]">
            Their time zone
          </label>
          <Select
            id={`${uid}-zone`}
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="h-8 text-xs"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {zoneName(z)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${uid}-name`} className="text-xs font-medium text-[var(--fg-muted)]">
            For (optional)
          </label>
          <Input
            id={`${uid}-name`}
            value={name}
            maxLength={PICK_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="h-8 text-xs"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch id={`${uid}-hold`} checked={hold} onCheckedChange={setHold} />
          <label htmlFor={`${uid}-hold`} className="text-sm">
            Hold these times
          </label>
        </div>
        {hold ? (
          <div
            role="group"
            aria-label="Hold for"
            className="flex flex-wrap items-center gap-1.5 pl-11"
          >
            {PICK_HOLD_HOURS.map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={holdHours === h}
                onClick={() => setHoldHours(h)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs',
                  holdHours === h
                    ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
                    : 'border-[var(--border-strong)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]',
                )}
              >
                {PICK_HOLD_LABEL[h]}
              </button>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-[var(--fg-muted)]">
          {hold
            ? 'Held times are kept off your booking link until they book or the hold ends.'
            : 'Not held: your booking link can still offer these times.'}
        </p>
      </div>

      <section aria-label="Picked times" className="space-y-1.5">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-xs font-medium text-[var(--fg-muted)]">
            Picked times, in their zone
          </h3>
          {fresh.length ? (
            <button
              type="button"
              onClick={props.onClear}
              className="text-xs text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--fg)] hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
        {days.length === 0 ? (
          <p className="text-sm text-[var(--fg-subtle)]">
            Click or drag on the calendar to pick times.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {days.map((day) => (
              <li key={day.key}>
                <p className="text-xs font-medium">{day.label}</p>
                <ul className="mt-0.5 flex flex-wrap gap-1">
                  {day.ranges.map((r) => {
                    const busy = slotByStart.get(r.start)?.busy ?? false;
                    const heldFor = slotByStart.get(r.start)?.heldFor ?? null;
                    const label = rangeLabel(r.start, r.end, zone);
                    return (
                      <li
                        key={r.start}
                        data-pick-range=""
                        className="inline-flex items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] py-0.5 pr-0.5 pl-2 text-xs tabular-nums"
                      >
                        {heldFor ? (
                          <span
                            className="size-2 shrink-0 rounded-full bg-[var(--danger)]"
                            title={`Held for ${heldFor}: not offered`}
                            aria-label={`Held for ${heldFor}: not offered`}
                            role="img"
                          />
                        ) : busy ? (
                          <span
                            className="size-2 shrink-0 rounded-full bg-[var(--warn)]"
                            title="Overlaps an event"
                            aria-label="Overlaps an event"
                            role="img"
                          />
                        ) : null}
                        {label}
                        <button
                          type="button"
                          onClick={() => props.onRemove(r.start)}
                          aria-label={`Remove ${day.label} ${label}`}
                          className="rounded-full p-0.5 text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {heldNames.length ? (
          <p className="text-xs text-[var(--fg-muted)]">
            <span
              aria-hidden
              className="mr-1 inline-block size-2 rounded-full bg-[var(--danger)] align-middle"
            />
            Held for {heldNames.join(', ')}: those times will not be offered.
          </p>
        ) : null}
        {anyBusy ? (
          <p className="text-xs text-[var(--fg-muted)]">
            <span
              aria-hidden
              className="mr-1 inline-block size-2 rounded-full bg-[var(--warn)] align-middle"
            />
            Overlaps an event: those times will not be offered.
          </p>
        ) : null}
        {problem ? <p className="text-xs text-[var(--danger)]">{problem}</p> : null}
      </section>

      {preview ? (
        <section aria-label="What gets copied" className="space-y-1">
          <h3 className="text-xs font-medium text-[var(--fg-muted)]">What gets copied</h3>
          <pre className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-[var(--fg)]">
            {preview}
          </pre>
        </section>
      ) : null}

      {!phone ? copyButton : null}

      {available && openPicks.length ? (
        <section
          aria-label="Open picks"
          className="space-y-1.5 border-t border-[var(--border)] pt-3"
        >
          <h3 className="text-xs font-medium text-[var(--fg-muted)]">Open picks</h3>
          <ul className="space-y-2">
            {openPicks.map((pick) => {
              const first = pick.ranges[0];
              const title =
                pick.recipientName ??
                (first ? slotLabel(first.start, pick.recipientTimeZone) : 'Picked times');
              return (
                <li key={pick.id} data-open-pick={pick.id} className="space-y-1">
                  <p className="truncate text-sm font-medium">{title}</p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {pick.hold ? 'Held' : 'Open'} until{' '}
                    {holdUntilLabel(pick.expiresAt, hostZone, now.getTime())}
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void copyAgain(pick)}
                      disabled={!pick.canCopyAgain || busyPick === pick.id}
                      title={
                        pick.canCopyAgain
                          ? undefined
                          : 'This link cannot be copied again. Cancel it and pick the times again.'
                      }
                    >
                      Copy again
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void cancel(pick)}
                      disabled={busyPick === pick.id}
                    >
                      Cancel
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );

  if (phone) {
    return (
      <div
        data-event-card=""
        data-pick-panel=""
        role="region"
        aria-label="Pick times"
        className="shadow-overlay fixed inset-x-0 bottom-0 z-[var(--z-overlay)] flex max-h-[min(70dvh,36rem)] flex-col rounded-t-[var(--radius-panel)] border-t border-[var(--border-strong)] bg-[var(--bg-overlay)] px-4 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
        {header}
        {expanded ? (
          <div className="-mx-4 min-h-0 flex-1 scrollbar-thin overflow-y-auto px-4 pb-3">
            {body}
          </div>
        ) : notices ? (
          // Why Copy is missing or cannot work shows without opening the sheet.
          <div className="pb-2">{notices}</div>
        ) : (
          <p className="pb-2 text-xs text-[var(--fg-muted)]">
            {problem ??
              (allHeld
                ? `Held for ${heldNames.join(', ')}: those times will not be offered.`
                : fresh.length
                  ? preview.split('\n')[0]
                  : 'Tap the calendar to pick times.')}
          </p>
        )}
        {copyButton}
        {confirmDialog}
      </div>
    );
  }

  return (
    <aside
      data-event-card=""
      data-pick-panel=""
      aria-label="Pick times"
      className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-3 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:scrollbar-thin lg:overflow-y-auto"
    >
      {header}
      {body}
      {confirmDialog}
    </aside>
  );
}
