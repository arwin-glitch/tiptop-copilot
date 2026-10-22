'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/form';
import { filterChipClassName } from '@/components/ui/toolbar';
import { eventsApi } from '@/components/events/events-client';
import type { StarterCard, ThemeCard } from '@/components/events/library/gallery-data';
import { cn } from '@/lib/util/cn';
import { SUPPORTED_TIMEZONES, addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';

/**
 * New event: a starter (the sections), then a theme (the look), then the
 * name, date and time zone. Creates a DRAFT through POST /api/events and
 * opens it; nothing is public until someone publishes it from Studio.
 *
 * The starters and themes come from WS2's presets (lib/events/starters,
 * lib/events/themes) as small cards built on the server (gallery-data.ts).
 */

type Step = 'starter' | 'theme' | 'details';
const STEPS: { key: Step; label: string }[] = [
  { key: 'starter', label: 'Starter' },
  { key: 'theme', label: 'Theme' },
  { key: 'details', label: 'Details' },
];

const VIBE_LABELS: Record<string, string> = {
  formal: 'Formal',
  modern: 'Modern',
  playful: 'Playful',
  golf: 'Golf',
  night: 'Night',
  seasonal: 'Seasonal',
};

function slugPreview(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '') || 'your-event'
  );
}

function parseTime(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

/** The wall-clock end a starter's sessions reach from a start time ("13:00" + 480 → "21:00"). */
function endAfter(start: string, minutes: number | null | undefined): string | null {
  const t = parseTime(start);
  if (!t || !minutes) return null;
  const total = (((t.h * 60 + t.m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function NewEventDialog({
  starters,
  themes,
  timeZone,
  open: controlledOpen,
  onOpenChange,
  initialStarterId,
  showTrigger = true,
}: {
  starters: StarterCard[];
  themes: ThemeCard[];
  /** The signed-in member's zone: the default for a new event. */
  timeZone: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialStarterId?: string | null;
  showTrigger?: boolean;
}) {
  const router = useRouter();
  const [ownOpen, setOwnOpen] = React.useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (controlledOpen === undefined) setOwnOpen(next);
  };

  const firstStarter = starters.find((s) => s.id === initialStarterId) ?? starters[0] ?? null;
  const [step, setStep] = React.useState<Step>('starter');
  const [starterId, setStarterId] = React.useState<string | null>(firstStarter?.id ?? null);
  const [themeId, setThemeId] = React.useState<string | null>(
    firstStarter?.themePresetId ?? themes[0]?.id ?? null,
  );
  const [vibe, setVibe] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState('');
  const [date, setDate] = React.useState('');
  // A starter suggests its start (the AGM's meeting at 1 PM) and its sessions set the end.
  const firstStart = firstStarter?.startTime ?? '18:00';
  const [start, setStart] = React.useState(firstStart);
  const [end, setEnd] = React.useState(endAfter(firstStart, firstStarter?.spanMinutes) ?? '21:00');
  const [zone, setZone] = React.useState(timeZone);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  // Opening from a starter card in the empty library preselects that starter.
  const [lastInitial, setLastInitial] = React.useState(initialStarterId);
  if (initialStarterId !== lastInitial) {
    setLastInitial(initialStarterId);
    const chosen = starters.find((s) => s.id === initialStarterId);
    if (chosen) {
      setStarterId(chosen.id);
      setThemeId(chosen.themePresetId);
      const from = chosen.startTime ?? start;
      setStart(from);
      setEnd(endAfter(from, chosen.spanMinutes) ?? end);
      setStep('theme');
    }
  }

  const zones = SUPPORTED_TIMEZONES.includes(zone as (typeof SUPPORTED_TIMEZONES)[number])
    ? [...SUPPORTED_TIMEZONES]
    : [zone, ...SUPPORTED_TIMEZONES];
  const vibes = [...new Set(themes.flatMap((t) => t.vibes))];
  const shownThemes = vibe ? themes.filter((t) => t.vibes.includes(vibe as never)) : themes;

  const spanOf = (id: string | null) => starters.find((s) => s.id === id)?.spanMinutes ?? null;

  const pickStarter = (s: StarterCard) => {
    setStarterId(s.id);
    // A starter brings its own look; the theme step can still change it.
    setThemeId(s.themePresetId);
    const from = s.startTime ?? start;
    if (s.startTime) setStart(s.startTime);
    const reached = endAfter(from, s.spanMinutes);
    if (reached) setEnd(reached);
  };

  const changeStart = (value: string) => {
    setStart(value);
    const reached = endAfter(value, spanOf(starterId));
    if (reached) setEnd(reached);
  };

  const create = async () => {
    setProblem(null);
    const name = title.trim();
    if (!name) {
      setProblem('Give the event a name.');
      return;
    }
    let startsAt: string | null = null;
    let endsAt: string | null = null;
    if (date) {
      const s = parseTime(start);
      const e = parseTime(end);
      const startAt = s ? wallTimeToUtc(date, s.h, s.m, zone) : null;
      if (!startAt) {
        setProblem('That date or start time is not valid.');
        return;
      }
      startsAt = startAt.toISOString();
      if (e) {
        let endAt = wallTimeToUtc(date, e.h, e.m, zone);
        // An end before the start runs past midnight into the next day.
        if (endAt && endAt <= startAt) endAt = wallTimeToUtc(addDaysToKey(date, 1), e.h, e.m, zone);
        endsAt = endAt ? endAt.toISOString() : null;
      }
    }
    setBusy(true);
    const result = await eventsApi.create({
      title: name,
      timeZone: zone,
      startsAt,
      endsAt,
      ...(starterId ? { starterId } : {}),
      ...(themeId ? { themePresetId: themeId } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    toast.success('Draft created. Nothing is public until you publish it.');
    setOpen(false);
    router.push(`/events/${encodeURIComponent(result.data.id)}`);
  };

  const index = STEPS.findIndex((s) => s.key === step);

  return (
    <>
      {showTrigger ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-tour="events-new"
          onClick={() => setOpen(true)}
        >
          <Plus aria-hidden="true" />
          New event
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="New event"
          description="Pick a starter and a theme, then name it. It starts as a private draft."
          className="max-w-3xl"
        >
          <ol aria-label="Steps" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep(s.key)}
                  aria-current={s.key === step ? 'step' : undefined}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
                    s.key === step
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium'
                      : 'border-[var(--border)] text-[var(--fg-muted)]',
                  )}
                >
                  <span className="tabular text-xs">{i + 1}</span>
                  {s.label}
                </button>
                {i < STEPS.length - 1 ? (
                  <span aria-hidden="true" className="h-px w-4 bg-[var(--border-strong)]" />
                ) : null}
              </li>
            ))}
          </ol>

          {step === 'starter' ? (
            <div role="radiogroup" aria-label="Starter" className="grid gap-3 sm:grid-cols-2">
              {starters.map((s) => {
                const chosen = s.id === starterId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    onClick={() => pickStarter(s)}
                    className={cn(
                      'relative rounded-[var(--radius-card)] border p-3 text-left transition-colors',
                      chosen
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    {chosen ? (
                      <Check
                        className="absolute top-3 right-3 size-4 text-[var(--accent)]"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="block font-serif text-base font-semibold">{s.name}</span>
                    <span className="mt-1 block text-sm text-[var(--fg-muted)]">
                      {s.description}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1">
                      {s.sections.slice(0, 5).map((label, i) => (
                        <span
                          key={`${label}-${i}`}
                          className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]"
                        >
                          {label}
                        </span>
                      ))}
                      {s.sections.length > 5 ? (
                        <span className="px-1 text-[11px] text-[var(--fg-subtle)]">
                          +{s.sections.length - 5}
                        </span>
                      ) : null}
                    </span>
                    {s.sessions.length > 1 ? (
                      <span className="mt-1.5 block text-xs text-[var(--fg-subtle)]">
                        Sessions: {s.sessions.join(', ')}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {step === 'theme' ? (
            <div className="space-y-3">
              {vibes.length > 1 ? (
                <div role="group" aria-label="Filter themes" className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={vibe === null}
                    onClick={() => setVibe(null)}
                    className={filterChipClassName(vibe === null)}
                  >
                    Every theme
                  </button>
                  {vibes.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={vibe === v}
                      onClick={() => setVibe(v)}
                      className={filterChipClassName(vibe === v)}
                    >
                      {VIBE_LABELS[v] ?? v}
                    </button>
                  ))}
                </div>
              ) : null}
              <div
                role="radiogroup"
                aria-label="Theme"
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
              >
                {shownThemes.map((t) => {
                  const chosen = t.id === themeId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={chosen}
                      onClick={() => setThemeId(t.id)}
                      className={cn(
                        'rounded-[var(--radius-card)] border p-2 text-left transition-colors',
                        chosen
                          ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/40'
                          : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <ThemeSwatchArt theme={t} />
                      <span className="mt-2 block text-sm font-medium">{t.name}</span>
                      <span className="block text-xs text-[var(--fg-subtle)]">{t.display}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-[var(--fg-muted)]">
                Colours, fonts and effects stay yours to change in Studio.
              </p>
            </div>
          ) : null}

          {step === 'details' ? (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <Field
                label="Name"
                htmlFor="new-event-title"
                hint={`Link: /e/${slugPreview(title)} (you can change it later)`}
                className="sm:col-span-2"
              >
                <Input
                  id="new-event-title"
                  value={title}
                  maxLength={140}
                  autoComplete="off"
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Annual Meeting 2027"
                  aria-describedby="new-event-title-hint"
                  required
                />
              </Field>
              <Field
                label="Date"
                htmlFor="new-event-date"
                hint="Optional now; sessions can differ."
              >
                <Input
                  id="new-event-date"
                  type="date"
                  value={date}
                  min={localDateKey(new Date(), zone)}
                  onChange={(e) => setDate(e.target.value)}
                  aria-describedby="new-event-date-hint"
                />
              </Field>
              <Field label="Time zone" htmlFor="new-event-zone">
                <Select id="new-event-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Starts" htmlFor="new-event-start">
                <Input
                  id="new-event-start"
                  type="time"
                  value={start}
                  onChange={(e) => changeStart(e.target.value)}
                />
              </Field>
              <Field label="Ends" htmlFor="new-event-end">
                <Input
                  id="new-event-end"
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
              {problem ? (
                <p role="alert" className="text-sm text-[var(--danger)] sm:col-span-2">
                  {problem}
                </p>
              ) : null}
              {/* Enter submits from any field. */}
              <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
            </form>
          ) : null}

          <DialogFooter>
            {index > 0 ? (
              <Button type="button" variant="ghost" onClick={() => setStep(STEPS[index - 1]!.key)}>
                Back
              </Button>
            ) : null}
            {step !== 'details' ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => setStep(STEPS[index + 1]!.key)}
              >
                Next: {STEPS[index + 1]!.label.toLowerCase()}
              </Button>
            ) : (
              <Button type="button" variant="primary" loading={busy} onClick={() => void create()}>
                Create draft
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A theme's look in miniature: its light page with the accent and gold, and a dark strip. */
export function ThemeSwatchArt({ theme, className }: { theme: ThemeCard; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative block aspect-[16/10] overflow-hidden rounded-md border border-[var(--border)]',
        className,
      )}
      style={{ backgroundColor: theme.light.bg }}
    >
      <span
        className="absolute inset-x-[12%] top-[18%] h-[22%] rounded-sm"
        style={{ backgroundColor: theme.light.surface }}
      />
      <span
        className="absolute top-[24%] left-[18%] h-[6%] w-[40%] rounded-full"
        style={{ backgroundColor: theme.light.text }}
      />
      <span
        className="absolute top-[48%] left-[12%] h-[3%] w-[24%] rounded-full"
        style={{ backgroundColor: theme.light.highlight }}
      />
      <span
        className="absolute top-[58%] left-[12%] h-[12%] w-[30%] rounded-full"
        style={{ backgroundColor: theme.light.accent }}
      />
      <span
        className="absolute inset-x-0 bottom-0 h-[22%]"
        style={{ backgroundColor: theme.dark.bg }}
      />
      <span
        className="absolute right-[12%] bottom-[7%] h-[8%] w-[22%] rounded-full"
        style={{ backgroundColor: theme.dark.accent }}
      />
    </span>
  );
}
