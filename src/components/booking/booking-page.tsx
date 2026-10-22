'use client';

import * as React from 'react';
import { CalendarCheck2, Coffee, MapPin, MessageSquare, Video } from 'lucide-react';
import { Mark } from '@/components/brand/wordmark';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input, Label, Select, Textarea } from '@/components/ui/form';
import { KIND_LABEL, type MeetingKind } from '@/lib/booking/config';
import {
  CLOSED_MESSAGE,
  SENT_MESSAGE,
  dayKeyIn,
  dayLabel,
  distinctZones,
  knownZone,
  slotLabel,
  timeLabel,
  zoneName,
  type PublicBookingPage,
  type PublicSlot,
  type PublicSlots,
} from '@/lib/booking/public';
import {
  applyFill,
  EMPTY_FORM,
  LIMITS,
  patchForm,
  type BookingFormState,
  type ChatFormFill,
} from '@/lib/booking/request';
import { SUPPORTED_TIMEZONES } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { BookingChat } from './booking-chat';

/**
 * The public booking page (/meet/<slug>): the host's card, then one form —
 * a call or an in-person coffee, lunch or dinner, a time in the visitor's
 * own zone, a place, and who they are. Sending keeps a request for Arwin to
 * confirm; nothing is booked from here. The chatbot can fill the form; the
 * visitor still presses Send.
 */

const noSubscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;
const serverNull = () => null;

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function BookingPage({ data }: { data: PublicBookingPage }) {
  const detected = React.useSyncExternalStore(noSubscribe, browserZone, serverNull);
  const [chosenZone, setChosenZone] = React.useState<string | null>(null);
  const zone = chosenZone ?? (knownZone(detected) ? detected : data.hostTimeZone);

  if (data.state !== 'open' || !data.host) {
    return (
      <Shell firmName="TipTop Ventures">
        <section className="mx-auto max-w-lg py-16 text-center">
          <CalendarCheck2 className="mx-auto size-8 text-[var(--accent)]" aria-hidden="true" />
          <h1 className="mt-4 font-serif text-2xl font-semibold">Not taking bookings</h1>
          <p className="mt-2 text-sm text-[var(--fg-muted)]">{CLOSED_MESSAGE}</p>
        </section>
      </Shell>
    );
  }
  return (
    <OpenPage
      data={data}
      visitorZone={zone}
      zonePicked={chosenZone !== null}
      onZone={setChosenZone}
      detectedZone={detected ?? null}
    />
  );
}

function Shell({ firmName, children }: { firmName: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="dark border-b border-[var(--gold-rule)] bg-[var(--bg-band)] text-[var(--fg)]">
        <div className="mx-auto flex max-w-5xl items-center gap-2.5 px-4 py-3.5 sm:px-6">
          <Mark className="text-[var(--brand-mark)]" size={18} />
          <span className="min-w-0 flex-1 truncate font-serif text-[15px] font-semibold tracking-tight">
            {firmName}
          </span>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
      <footer className="border-t border-[var(--border)] px-4 py-5 text-center text-xs text-[var(--fg-subtle)]">
        Scheduling by TipTop Copilot
      </footer>
    </div>
  );
}

function HostCard({
  host,
  inPerson,
}: {
  host: NonNullable<PublicBookingPage['host']>;
  inPerson: boolean;
}) {
  return (
    <section
      aria-label="Who you are meeting"
      className="shadow-raised rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-5"
    >
      <div className="flex items-center gap-4 lg:flex-col lg:items-start">
        {host.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by this app's own photo route
          <img
            src={host.photoUrl}
            alt={host.displayName}
            width={96}
            height={96}
            className="size-20 shrink-0 rounded-full border-2 border-[var(--gold)] object-cover lg:size-24"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-20 shrink-0 items-center justify-center rounded-full border-2 border-[var(--gold)] bg-[var(--jewel)] font-serif text-2xl font-semibold text-[var(--jewel-fg)] lg:size-24"
          >
            {initials(host.displayName)}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-micro font-medium tracking-[0.16em] text-[var(--label-gold)] uppercase">
            Meet with
          </p>
          <h1 className="font-serif text-2xl leading-tight font-semibold">{host.displayName}</h1>
          {host.title ? (
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{host.title}</p>
          ) : null}
        </div>
      </div>
      {host.bio ? (
        <p className="text-read mt-4 whitespace-pre-line text-[var(--fg-muted)]">{host.bio}</p>
      ) : null}
      <ul className="mt-5 space-y-2 border-t border-[var(--border)] pt-4 text-sm text-[var(--fg-muted)]">
        <li className="flex items-center gap-2">
          <Video className="size-4 text-[var(--accent)]" aria-hidden="true" />
          30-minute call on Google Meet
        </li>
        {inPerson ? (
          <li className="flex items-center gap-2">
            <Coffee className="size-4 text-[var(--accent)]" aria-hidden="true" />
            Or an hour in person: coffee, lunch or dinner
          </li>
        ) : null}
        <li className="flex items-center gap-2">
          <CalendarCheck2 className="size-4 text-[var(--accent)]" aria-hidden="true" />
          Arwin confirms every request by email
        </li>
      </ul>
    </section>
  );
}

type SlotState = { loading: boolean; data: PublicSlots | null; error: string | null };

function slotKey(form: Pick<BookingFormState, 'type' | 'kind'>): string | null {
  if (form.type === 'call') return 'call';
  if (form.type === 'in_person' && form.kind) return `in_person:${form.kind}`;
  return null;
}

function OpenPage({
  data,
  visitorZone,
  zonePicked,
  onZone,
  detectedZone,
}: {
  data: PublicBookingPage;
  visitorZone: string;
  /** The visitor chose a zone in the picker: it wins everywhere. */
  zonePicked: boolean;
  onZone: (zone: string) => void;
  detectedZone: string | null;
}) {
  const host = data.host!;
  const [form, setForm] = React.useState<BookingFormState>(EMPTY_FORM);
  // In person the visitor will be in the host's city, so its times read in
  // the host's own clock (coffee at 8:30 AM, not 9:30 PM in Manila) unless
  // they pick another zone. Calls stay in the visitor's zone.
  const hostClock = form.type === 'in_person' && !zonePicked;
  const zone = hostClock ? data.hostTimeZone : visitorZone;
  const [slots, setSlots] = React.useState<Record<string, SlotState>>({});
  const [day, setDay] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<BookingFormState | null>(null);
  const [filledByChat, setFilledByChat] = React.useState(false);
  const [website, setWebsite] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const formRef = React.useRef<HTMLDivElement>(null);
  const uid = React.useId();

  const key = slotKey(form);
  React.useEffect(() => {
    if (!key) return;
    let live = true;
    const [type, kind] = key.split(':');
    const params = new URLSearchParams({ type: type! });
    if (kind) params.set('kind', kind);
    fetch(`/api/meet/${encodeURIComponent(data.slug)}/slots?${params.toString()}`, {
      cache: 'no-store',
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as
          (PublicSlots & { ok: boolean; error?: { message?: string } }) | null;
        if (!live) return;
        if (!res.ok || !json?.ok) {
          setSlots((s) => ({
            ...s,
            [key]: {
              loading: false,
              data: null,
              error: json?.error?.message ?? 'Open times could not be loaded.',
            },
          }));
          return;
        }
        setSlots((s) => ({ ...s, [key]: { loading: false, data: json, error: null } }));
      })
      .catch(() => {
        if (live) {
          setSlots((s) => ({
            ...s,
            [key]: { loading: false, data: null, error: 'Open times could not be loaded.' },
          }));
        }
      });
    return () => {
      live = false;
    };
  }, [key, data.slug, reload]);

  const current: SlotState | null = key
    ? (slots[key] ?? { loading: true, data: null, error: null })
    : null;
  const loaded = current?.data?.slots;
  const list: PublicSlot[] = React.useMemo(() => loaded ?? [], [loaded]);
  const days = React.useMemo(() => {
    const groups = new Map<string, PublicSlot[]>();
    for (const s of list) {
      const k = dayKeyIn(s.start, zone);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    return [...groups.entries()];
  }, [list, zone]);
  const pickedDay =
    (form.start ? dayKeyIn(form.start, zone) : null) ??
    (day && days.some(([k]) => k === day) ? day : null) ??
    days[0]?.[0] ??
    null;
  const dayTimes = days.find(([k]) => k === pickedDay)?.[1] ?? [];

  const update = (patch: Partial<BookingFormState>) => {
    setProblem(null);
    setForm((f) => patchForm(f, patch));
  };

  const fillFromChat = (fill: ChatFormFill) => {
    setProblem(null);
    setForm((f) => applyFill(f, fill));
    setFilledByChat(true);
    if (fill.start) setDay(dayKeyIn(fill.start, zone));
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    if (!form.name.trim() || !form.email.trim()) {
      setProblem('Add your name and email.');
      return;
    }
    if (form.type !== 'message' && !form.start) {
      setProblem('Pick a time.');
      return;
    }
    setSending(true);
    setProblem(null);
    const res = await fetch(`/api/meet/${encodeURIComponent(data.slug)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        email: form.email,
        company: form.company,
        type: form.type,
        kind: form.type === 'in_person' ? form.kind : null,
        start: form.type === 'message' ? null : form.start,
        placeId: form.type === 'in_person' && form.placeId !== 'custom' ? form.placeId : null,
        customPlace: form.type === 'in_person' && form.placeId === 'custom' ? form.customPlace : '',
        note: form.note,
        deckUrl: form.deckUrl,
        timeZone: zone,
        source: filledByChat ? 'chatbot' : 'form',
        website,
      }),
    }).catch(() => null);
    setSending(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    } | null;
    if (res?.ok && json?.ok) {
      setSent(form);
      return;
    }
    setProblem(json?.error?.message ?? 'The request did not go through. Try again.');
    if (json?.error?.code === 'conflict') {
      setForm((f) => ({ ...f, start: null }));
      setReload((n) => n + 1);
    }
  };

  if (sent) {
    const place =
      sent.type === 'in_person'
        ? sent.placeId === 'custom'
          ? sent.customPlace
          : data.places.find((p) => p.id === sent.placeId)?.name
        : null;
    return (
      <Shell firmName={host.firmName || 'TipTop Ventures'}>
        <section
          className="shadow-raised mx-auto max-w-lg rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-6 text-center"
          aria-live="polite"
        >
          <CalendarCheck2 className="mx-auto size-9 text-[var(--accent)]" aria-hidden="true" />
          <h1 className="mt-3 font-serif text-2xl font-semibold">{SENT_MESSAGE}</h1>
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            {sent.type === 'message'
              ? `Your message is with ${host.displayName}'s team.`
              : `${sent.type === 'call' ? '30-minute call' : `${KIND_LABEL[sent.kind as MeetingKind]}, 1 hour`} · ${slotLabel(sent.start!, zone)} (${zoneName(zone, new Date(sent.start!))})${place ? ` · ${place}` : ''}`}
          </p>
          <p className="mt-4 text-xs text-[var(--fg-subtle)]">
            Nothing is booked until Arwin confirms. Watch for an email from the team.
          </p>
          <Button
            className="mt-5"
            variant="secondary"
            onClick={() => {
              setSent(null);
              setForm(EMPTY_FORM);
              setFilledByChat(false);
              setReload((n) => n + 1);
            }}
          >
            Send another request
          </Button>
        </section>
      </Shell>
    );
  }

  const zones = distinctZones([zone, detectedZone, data.hostTimeZone, ...SUPPORTED_TIMEZONES]);

  return (
    <Shell firmName={host.firmName || 'TipTop Ventures'}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
        <div className="lg:sticky lg:top-6">
          <HostCard host={host} inPerson={data.offers.inPerson} />
        </div>

        <div ref={formRef} className="scroll-mt-4">
          <form
            onSubmit={send}
            noValidate
            aria-labelledby={`${uid}-title`}
            className="shadow-raised space-y-6 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-5 sm:p-6"
          >
            <div>
              <h2 id={`${uid}-title`} className="font-serif text-xl font-semibold">
                {form.type === 'message' ? 'Leave a message' : 'Ask for a time'}
              </h2>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                {form.type === 'message'
                  ? `Arwin will pass it to ${host.displayName} and reply by email.`
                  : 'Pick what suits you. Arwin confirms by email; nothing is booked until then.'}
              </p>
              {filledByChat ? (
                <Notice className="mt-3">
                  Arwin filled in the form for you. Check it, then press Send request.
                </Notice>
              ) : null}
            </div>

            {form.type !== 'message' ? (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">What kind of meeting?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <TypeOption
                    selected={form.type === 'call'}
                    onSelect={() => update({ type: 'call' })}
                    icon={<Video className="size-4" aria-hidden="true" />}
                    title="30-minute call"
                    body="Google Meet, link in the invite"
                  />
                  {data.offers.inPerson ? (
                    <TypeOption
                      selected={form.type === 'in_person'}
                      onSelect={() =>
                        update({ type: 'in_person', kind: form.kind ?? data.kinds[0] ?? null })
                      }
                      icon={<Coffee className="size-4" aria-hidden="true" />}
                      title="1 hour in person"
                      body="Coffee, lunch or dinner nearby"
                    />
                  ) : null}
                </div>
                {form.type === 'in_person' ? (
                  <div
                    role="radiogroup"
                    aria-label="Coffee, lunch or dinner"
                    className="flex flex-wrap gap-2"
                  >
                    {data.kinds.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={form.kind === k}
                        onClick={() => update({ kind: k })}
                        className={cn(
                          'h-11 rounded-full border px-4 text-sm font-medium transition-colors',
                          form.kind === k
                            ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                            : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
                        )}
                      >
                        {KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </fieldset>
            ) : null}

            {form.type !== 'message' ? (
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">Pick a time</legend>
                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-muted)]">
                  <label htmlFor={`${uid}-zone`}>Times shown in</label>
                  <Select
                    id={`${uid}-zone`}
                    value={zone}
                    onChange={(e) => onZone(e.target.value)}
                    className="h-8 w-full max-w-full text-xs sm:w-auto"
                  >
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {zoneName(z)}
                        {z === detectedZone
                          ? ' (your time zone)'
                          : z === data.hostTimeZone && hostClock
                            ? ' (where you will meet)'
                            : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                {hostClock && zone !== detectedZone ? (
                  <p className="text-xs text-[var(--fg-muted)]">
                    In-person times are local time where you will meet.
                  </p>
                ) : null}
                {current?.loading ? (
                  <p className="text-sm text-[var(--fg-muted)]" aria-live="polite">
                    Finding open times…
                  </p>
                ) : current?.error ? (
                  <Notice tone="warn">{current.error}</Notice>
                ) : current?.data?.state === 'unavailable' ? (
                  <Notice tone="warn">{current.data.message}</Notice>
                ) : list.length === 0 ? (
                  <Notice>
                    No open times in the next few weeks for this. Try another kind of meeting, or
                    leave a message.
                  </Notice>
                ) : (
                  <>
                    <div role="radiogroup" aria-label="Day" className="flex flex-wrap gap-2">
                      {days.map(([k, times]) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={pickedDay === k}
                          onClick={() => {
                            setDay(k);
                            if (form.start && dayKeyIn(form.start, zone) !== k)
                              update({ start: null });
                          }}
                          className={cn(
                            'min-h-11 rounded-[var(--radius-card)] border px-3 py-1.5 text-left text-sm transition-colors',
                            pickedDay === k
                              ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
                              : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
                          )}
                        >
                          <span className="block">{dayLabel(times[0]!.start, zone)}</span>
                          <span className="block text-[11px] text-[var(--fg-subtle)]">
                            {times.length} open
                          </span>
                        </button>
                      ))}
                    </div>
                    <div
                      role="radiogroup"
                      aria-label="Time"
                      className="grid grid-cols-3 gap-2 sm:grid-cols-4"
                    >
                      {dayTimes.map((s) => (
                        <button
                          key={s.start}
                          type="button"
                          role="radio"
                          aria-checked={form.start === s.start}
                          onClick={() => update({ start: s.start })}
                          className={cn(
                            'h-11 rounded-md border text-sm font-medium tabular-nums transition-colors',
                            form.start === s.start
                              ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                              : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
                          )}
                        >
                          {timeLabel(s.start, zone)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </fieldset>
            ) : null}

            {form.type === 'in_person' ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Where?</legend>
                <p className="text-xs text-[var(--fg-muted)]">Places near {host.displayName}.</p>
                <div className="space-y-2">
                  {data.places.map((p) => (
                    <label
                      key={p.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors',
                        form.placeId === p.id
                          ? 'border-[var(--primary)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${uid}-place`}
                        className="mt-1"
                        checked={form.placeId === p.id}
                        onChange={() => update({ placeId: p.id })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{p.name}</span>
                        {p.area ? (
                          <span className="block text-xs text-[var(--fg-muted)]">{p.area}</span>
                        ) : null}
                      </span>
                      {p.mapUrl ? (
                        <a
                          href={p.mapUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="link-inline inline-flex shrink-0 items-center gap-1 text-xs"
                        >
                          <MapPin className="size-3.5" aria-hidden="true" />
                          Map<span className="sr-only"> for {p.name}</span>
                        </a>
                      ) : null}
                    </label>
                  ))}
                  {data.allowCustomPlace ? (
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-3 transition-colors',
                        form.placeId === 'custom'
                          ? 'border-[var(--primary)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <input
                        type="radio"
                        name={`${uid}-place`}
                        className="mt-1"
                        checked={form.placeId === 'custom'}
                        onChange={() => update({ placeId: 'custom' })}
                      />
                      <span className="min-w-0 flex-1 text-sm font-medium">Suggest a place</span>
                    </label>
                  ) : null}
                  {form.placeId === 'custom' ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`${uid}-custom`}>Your suggestion</Label>
                      <Input
                        id={`${uid}-custom`}
                        value={form.customPlace}
                        maxLength={LIMITS.customPlace}
                        placeholder="A café or restaurant, and the area"
                        onChange={(e) => update({ customPlace: e.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
              </fieldset>
            ) : null}

            <fieldset className="space-y-4">
              <legend className="text-sm font-medium">About you</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-name`}>Name</Label>
                  <Input
                    id={`${uid}-name`}
                    autoComplete="name"
                    required
                    maxLength={LIMITS.name}
                    value={form.name}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${uid}-email`}>Email</Label>
                  <Input
                    id={`${uid}-email`}
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={LIMITS.email}
                    value={form.email}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-company`}>
                  Company <span className="font-normal text-[var(--fg-subtle)]">(optional)</span>
                </Label>
                <Input
                  id={`${uid}-company`}
                  autoComplete="organization"
                  maxLength={LIMITS.company}
                  value={form.company}
                  onChange={(e) => update({ company: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-note`}>
                  {form.type === 'message' ? 'Your message' : 'What would you like to talk about?'}
                </Label>
                <Textarea
                  id={`${uid}-note`}
                  maxLength={LIMITS.note}
                  rows={4}
                  value={form.note}
                  onChange={(e) => update({ note: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-deck`}>
                  Deck link <span className="font-normal text-[var(--fg-subtle)]">(optional)</span>
                </Label>
                <Input
                  id={`${uid}-deck`}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  maxLength={LIMITS.deckUrl}
                  value={form.deckUrl}
                  onChange={(e) => update({ deckUrl: e.target.value })}
                />
              </div>
              {/* A field no person sees: form-filling robots fill it, and the server keeps nothing. */}
              <div
                aria-hidden="true"
                className="absolute -left-[10000px] h-px w-px overflow-hidden"
              >
                <label htmlFor={`${uid}-website`}>Leave this empty</label>
                <input
                  id={`${uid}-website`}
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
            </fieldset>

            {problem ? (
              <div role="alert">
                <Notice tone="warn">{problem}</Notice>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-5">
              <Button type="submit" variant="primary" size="lg" loading={sending}>
                {form.type === 'message' ? 'Send message' : 'Send request'}
              </Button>
              {form.type === 'message' ? (
                <Button type="button" variant="link" onClick={() => update({ type: 'call' })}>
                  Ask for a time instead
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => update({ type: 'message', start: null })}
                >
                  <MessageSquare aria-hidden="true" />
                  Leave a message instead
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>

      {data.chatbot.enabled ? (
        <BookingChat
          slug={data.slug}
          mode={data.chatbot.mode}
          hostName={host.displayName}
          firmName={host.firmName}
          kinds={data.offers.inPerson ? data.kinds : []}
          zone={visitorZone}
          onFill={fillFromChat}
        />
      ) : null}
    </Shell>
  );
}

function TypeOption({
  selected,
  onSelect,
  icon,
  title,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-14 items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left transition-colors',
        selected
          ? 'border-[var(--primary)] bg-[var(--accent-soft)]'
          : 'border-[var(--border-strong)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
          selected
            ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
            : 'bg-[var(--accent-soft)] text-[var(--accent)]',
        )}
      >
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs text-[var(--fg-muted)]">{body}</span>
      </span>
    </button>
  );
}
