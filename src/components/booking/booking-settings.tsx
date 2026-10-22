'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Copy, ExternalLink, Plus, Trash2, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input, Label, Switch, Textarea } from '@/components/ui/form';
import {
  ALLOWED_WEEKDAYS,
  BOOKING_HOURS_HINT,
  CALL_BOUNDS,
  KIND_LABEL,
  KIND_START_BOUNDS,
  MEETING_KINDS,
  WEEKDAY_NAME,
  inPersonOffered,
  type BookingConfig,
  type MeetingKind,
  type Place,
  type TimeWindow,
} from '@/lib/booking/config';
import { cn } from '@/lib/util/cn';

/**
 * Settings > Booking link: the public page's on/off switch and address, the
 * card it shows, where the host meets people, the rules every slot is
 * checked against, and the public chatbot. One save for all of it. Split into
 * small sections so it never becomes one long scroll.
 */

export interface BookingSettingsProps {
  available: boolean;
  enabled: boolean;
  slug: string;
  config: BookingConfig;
  linkBase: string;
  canEdit: boolean;
  hostZone: string;
  demo: boolean;
  notSetUpMessage: string;
  /** The section shown first (the Link section unless named). */
  initialSection?: SectionKey;
}

const SECTIONS = [
  { key: 'link', label: 'Link' },
  { key: 'profile', label: 'Profile' },
  { key: 'places', label: 'Places' },
  { key: 'times', label: 'Times' },
  { key: 'rules', label: 'Rules' },
  { key: 'chatbot', label: 'Chatbot' },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];

function placeId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'place';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function BookingSettings(props: BookingSettingsProps) {
  const [enabled, setEnabled] = React.useState(props.enabled);
  const [slug, setSlug] = React.useState(props.slug);
  const [config, setConfig] = React.useState<BookingConfig>(props.config);
  const [section, setSection] = React.useState<SectionKey>(props.initialSection ?? 'link');
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const uid = React.useId();
  const disabled = !props.canEdit || !props.available;
  const url = `${props.linkBase}${slug}`;

  const set = <K extends keyof BookingConfig>(key: K, value: BookingConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(true);
    setProblem(null);
  };

  const save = async () => {
    setSaving(true);
    setProblem(null);
    const res = await fetch('/api/booking/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, slug, config }),
    }).catch(() => null);
    setSaving(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      settings?: { enabled: boolean; slug: string; config: BookingConfig };
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok || !json.settings) {
      setProblem(json?.error?.message ?? 'The settings did not save. Try again.');
      return;
    }
    setEnabled(json.settings.enabled);
    setSlug(json.settings.slug);
    setConfig(json.settings.config);
    setDirty(false);
    toast.success('Booking link saved');
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    const body = new FormData();
    body.append('photo', file);
    const res = await fetch('/api/booking/photo', { method: 'POST', body }).catch(() => null);
    setUploading(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      settings?: { config: BookingConfig };
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok || !json.settings) {
      toast.error(json?.error?.message ?? 'The photo did not upload.');
      return;
    }
    setConfig((c) => ({ ...c, photo: json.settings!.config.photo }));
    toast.success('Photo saved');
  };

  const removePhoto = async () => {
    const res = await fetch('/api/booking/photo', { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      toast.error('The photo was not removed.');
      return;
    }
    setConfig((c) => ({ ...c, photo: null }));
    toast.success('Photo removed');
  };

  if (!props.available) {
    return <Notice tone="warn">{props.notSetUpMessage}</Notice>;
  }

  return (
    <div className="space-y-4">
      {!props.canEdit ? (
        <Notice>Only an admin or the owner can change the booking link.</Notice>
      ) : null}
      <div
        role="tablist"
        aria-label="Booking link settings"
        className="flex flex-wrap gap-1.5 border-b border-[var(--border)] pb-3"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            id={`${uid}-tab-${s.key}`}
            aria-selected={section === s.key}
            aria-controls={`${uid}-panel`}
            onClick={() => setSection(s.key)}
            className={cn(
              'h-9 rounded-full border px-3.5 text-sm font-medium transition-colors',
              section === s.key
                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div
        id={`${uid}-panel`}
        role="tabpanel"
        aria-labelledby={`${uid}-tab-${section}`}
        className="space-y-5"
      >
        {section === 'link' ? (
          <>
            <Row
              title="Take bookings"
              body={
                enabled
                  ? 'On. Anyone with the link can ask for a time; every request waits for Approve.'
                  : 'Off. The page says it is not taking bookings.'
              }
            >
              <Switch
                checked={enabled}
                disabled={disabled}
                onCheckedChange={(v) => {
                  setEnabled(v);
                  setDirty(true);
                }}
                aria-label="Take bookings"
              />
            </Row>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-slug`}>Link</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-[var(--fg-muted)]">{props.linkBase}</span>
                <Input
                  id={`${uid}-slug`}
                  value={slug}
                  disabled={disabled}
                  maxLength={40}
                  className="w-40"
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setDirty(true);
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void navigator.clipboard?.writeText(url).then(
                      () => toast.success('Link copied'),
                      () => toast.error('Copy did not work.'),
                    )
                  }
                >
                  <Copy aria-hidden="true" />
                  Copy link
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <a href={`/meet/${slug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open the page
                  </a>
                </Button>
              </div>
            </div>
            <TextField
              id={`${uid}-call-link`}
              label="Video link for calls"
              hint="Goes in every call invite instead of a Google Meet link. Only people who book see it."
              value={config.callLink}
              max={500}
              disabled={disabled}
              onChange={(v) => set('callLink', v)}
            />
            <Notice>
              Open times come from every calendar Copilot shows for the host, personal ones too. The
              page and its chatbot see busy times only, never titles or guests. Nothing reaches the
              calendar until someone presses Approve on the Calendar tab, and Copilot sends no email
              of its own.
            </Notice>
          </>
        ) : null}

        {section === 'profile' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`${uid}-name`}
                label="Name shown"
                value={config.displayName}
                max={80}
                disabled={disabled}
                onChange={(v) => set('displayName', v)}
              />
              <TextField
                id={`${uid}-title`}
                label="Title"
                value={config.title}
                max={120}
                disabled={disabled}
                onChange={(v) => set('title', v)}
              />
              <TextField
                id={`${uid}-firm`}
                label="Firm"
                value={config.firmName}
                max={80}
                disabled={disabled}
                onChange={(v) => set('firmName', v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-bio`}>Short bio</Label>
              <Textarea
                id={`${uid}-bio`}
                value={config.bio}
                maxLength={600}
                disabled={disabled}
                onChange={(e) => set('bio', e.target.value)}
              />
              <p className="text-xs text-[var(--fg-muted)]">{config.bio.length}/600</p>
            </div>
            <Row
              title="Photo"
              body={
                config.photo
                  ? 'Shown on the page. JPG, PNG or WebP under 3 MB.'
                  : 'None yet: the page shows initials. JPG, PNG or WebP under 3 MB.'
              }
              lead={
                config.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served by this app's own signed-in route
                  <img
                    src={`/api/booking/photo?v=${encodeURIComponent(config.photo.version)}`}
                    alt="The photo on the booking page"
                    width={48}
                    height={48}
                    className="size-12 shrink-0 rounded-full border-2 border-[var(--gold)] object-cover"
                  />
                ) : null
              }
            >
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="secondary">
                  <label
                    className={cn(
                      'cursor-pointer',
                      (disabled || uploading) && 'pointer-events-none opacity-50',
                    )}
                  >
                    <Upload aria-hidden="true" />
                    {uploading ? 'Uploading…' : config.photo ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      disabled={disabled || uploading}
                      onChange={(e) => {
                        void upload(e.target.files?.[0] ?? null);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </Button>
                {config.photo ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void removePhoto()}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </Row>
          </>
        ) : null}

        {section === 'places' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`${uid}-city`}
                label="Home city"
                hint="In person is offered only on days the host is here."
                value={config.homeCity}
                max={80}
                disabled={disabled}
                onChange={(v) => set('homeCity', v)}
              />
              <TextField
                id={`${uid}-aliases`}
                label="Other names for home"
                hint="Neighbourhoods or suburbs, separated by commas."
                value={config.homeAliases.join(', ')}
                max={600}
                disabled={disabled}
                onChange={(v) =>
                  set(
                    'homeAliases',
                    v
                      .split(',')
                      .map((a) => a.trim())
                      .filter(Boolean)
                      .slice(0, 10),
                  )
                }
              />
            </div>
            {!inPersonOffered(config) ? (
              <Notice>Set a home city and at least one place to offer in-person meetings.</Notice>
            ) : null}
            <div className="space-y-2">
              <p className="text-sm font-medium">Places near the host</p>
              {config.places.map((p, i) => (
                <PlaceRow
                  key={p.id}
                  place={p}
                  index={i}
                  disabled={disabled}
                  onChange={(next) =>
                    set(
                      'places',
                      config.places.map((x, j) => (j === i ? next : x)),
                    )
                  }
                  onRemove={() =>
                    set(
                      'places',
                      config.places.filter((_, j) => j !== i),
                    )
                  }
                />
              ))}
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || config.places.length >= 20}
                onClick={() =>
                  set('places', [
                    ...config.places,
                    {
                      id: placeId(
                        `place-${config.places.length + 1}`,
                        config.places.map((p) => p.id),
                      ),
                      name: '',
                      area: '',
                      mapUrl: null,
                    },
                  ])
                }
              >
                <Plus aria-hidden="true" />
                Add a place
              </Button>
            </div>
            <Row
              title="Visitors may suggest a place"
              body="Shown as “Suggest a place” beside the list."
            >
              <Switch
                checked={config.allowCustomPlace}
                disabled={disabled}
                onCheckedChange={(v) => set('allowCustomPlace', v)}
                aria-label="Visitors may suggest a place"
              />
            </Row>
          </>
        ) : null}

        {section === 'times' ? (
          <>
            <p className="text-sm text-[var(--fg-muted)]">
              {BOOKING_HOURS_HINT} All in the host&apos;s time zone, {props.hostZone}.
            </p>
            <WindowRow
              label="Calls (30 minutes) between"
              window={config.callWindow}
              bounds={CALL_BOUNDS}
              disabled={disabled}
              onChange={(w) => set('callWindow', w)}
            />
            {MEETING_KINDS.map((kind) => (
              <KindWindows
                key={kind}
                kind={kind}
                windows={config.kindWindows[kind]}
                disabled={disabled}
                onChange={(list) => set('kindWindows', { ...config.kindWindows, [kind]: list })}
              />
            ))}
          </>
        ) : null}

        {section === 'rules' ? (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Days offered</legend>
              <p className="text-xs text-[var(--fg-muted)]">Never Monday, Friday or the weekend.</p>
              <div className="flex flex-wrap gap-3">
                {ALLOWED_WEEKDAYS.map((d) => (
                  <label key={d} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={config.weekdays.includes(d)}
                      onChange={(e) =>
                        set(
                          'weekdays',
                          e.target.checked
                            ? [...new Set([...config.weekdays, d])].sort()
                            : config.weekdays.filter((x) => x !== d),
                        )
                      }
                    />
                    {WEEKDAY_NAME[d]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField
                id={`${uid}-cb`}
                label="Buffer around meetings for a call (min)"
                min={15}
                max={120}
                value={config.callBufferMinutes}
                disabled={disabled}
                onChange={(v) => set('callBufferMinutes', v)}
              />
              <NumberField
                id={`${uid}-ib`}
                label="Buffer for in person, travel (min)"
                min={30}
                max={180}
                value={config.inPersonBufferMinutes}
                disabled={disabled}
                onChange={(v) => set('inPersonBufferMinutes', v)}
              />
              <NumberField
                id={`${uid}-notice`}
                label="Notice (hours)"
                min={24}
                max={336}
                value={config.noticeHours}
                disabled={disabled}
                onChange={(v) => set('noticeHours', v)}
              />
              <NumberField
                id={`${uid}-horizon`}
                label="Months open after this one"
                min={0}
                max={8}
                value={config.rollingMonths}
                disabled={disabled}
                onChange={(v) => set('rollingMonths', v)}
              />
              <NumberField
                id={`${uid}-perday`}
                label="Link bookings a day, at most"
                min={0}
                max={10}
                value={config.maxLinkBookingsPerDay}
                disabled={disabled}
                onChange={(v) => set('maxLinkBookingsPerDay', v)}
              />
              <NumberField
                id={`${uid}-full`}
                label="No new times once a day has (meetings)"
                min={1}
                max={15}
                value={config.maxMeetingsPerDay}
                disabled={disabled}
                onChange={(v) => set('maxMeetingsPerDay', v)}
              />
              <NumberField
                id={`${uid}-stack`}
                label="Back-to-back run of (meetings)"
                min={2}
                max={8}
                value={config.stackSize}
                disabled={disabled}
                onChange={(v) => set('stackSize', v)}
              />
              <NumberField
                id={`${uid}-gap`}
                label="Back to back means gaps under (min)"
                min={0}
                max={60}
                value={config.stackGapMinutes}
                disabled={disabled}
                onChange={(v) => set('stackGapMinutes', v)}
              />
              <NumberField
                id={`${uid}-cool`}
                label="Free time after such a run (min)"
                min={0}
                max={240}
                value={config.stackCooldownMinutes}
                disabled={disabled}
                onChange={(v) => set('stackCooldownMinutes', v)}
              />
              <NumberField
                id={`${uid}-lead`}
                label="Free time before such a run (min)"
                min={15}
                max={120}
                value={config.stackLeadMinutes}
                disabled={disabled}
                onChange={(v) => set('stackLeadMinutes', v)}
              />
            </div>
            <Row
              title="Approve each booking first"
              body="Off by default: a free time that passes every rule is booked at once and the invitation goes out from the calendar. On, each booking waits in the Calendar tab's Booking requests until someone approves it."
            >
              <Switch
                checked={config.approveFirst}
                disabled={disabled}
                onCheckedChange={(v) => set('approveFirst', v)}
                aria-label="Approve each booking first"
              />
            </Row>
          </>
        ) : null}

        {section === 'chatbot' ? (
          <>
            <Row
              title="Chatbot on the page"
              body="“Arwin”, the host's AI scheduling assistant, tagged AI. It finds open times, answers from the FAQ below only, and fills the form; the visitor presses Send."
            >
              <Switch
                checked={config.chatbotEnabled}
                disabled={disabled}
                onCheckedChange={(v) => set('chatbotEnabled', v)}
                aria-label="Chatbot on the page"
              />
            </Row>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-faq`}>Public FAQ for the chatbot</Label>
              <Textarea
                id={`${uid}-faq`}
                rows={8}
                maxLength={4000}
                value={config.faq}
                disabled={disabled}
                onChange={(e) => set('faq', e.target.value)}
              />
              <p className="text-xs text-[var(--fg-muted)]">
                The only facts about the firm it may give. Anything else gets “I can take a
                message.” Public: write nothing private here. {config.faq.length}/4000
              </p>
            </div>
            <NumberField
              id={`${uid}-cap`}
              label="Monthly AI cost cap (US$)"
              min={0}
              max={500}
              value={config.monthlyAiCapUsd}
              disabled={disabled}
              onChange={(v) => set('monthlyAiCapUsd', v)}
            />
            <p className="text-xs text-[var(--fg-muted)]">
              Past the cap, with no API key{props.demo ? ' (as in the demo)' : ''}, or for a visitor
              sending too many messages, the chatbot becomes three buttons: Find a time, About the
              firm, Leave a message.
            </p>
          </>
        ) : null}
      </div>

      {problem ? (
        <div role="alert">
          <Notice tone="warn">{problem}</Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
        <Button
          variant="primary"
          onClick={() => void save()}
          loading={saving}
          disabled={disabled || !dirty}
        >
          Save booking link
        </Button>
        {dirty ? <Badge tone="warn">Unsaved changes</Badge> : null}
      </div>
    </div>
  );
}

function Row({
  title,
  body,
  lead,
  children,
}: {
  title: string;
  body: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] p-3">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-[var(--fg-muted)]">{body}</p>
      </div>
      {children}
    </div>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  max,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  max: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        maxLength={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-xs text-[var(--fg-muted)]">{hint}</p> : null}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function WindowRow({
  label,
  window,
  bounds,
  disabled,
  onChange,
  onRemove,
}: {
  label: string;
  window: TimeWindow;
  /** The hard bounds the window must keep inside (config.ts). */
  bounds: TimeWindow;
  disabled: boolean;
  onChange: (window: TimeWindow) => void;
  onRemove?: () => void;
}) {
  const uid = React.useId();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-from`}>{label}</Label>
        <Input
          id={`${uid}-from`}
          type="time"
          min={bounds.from}
          max={bounds.to}
          value={window.from}
          disabled={disabled}
          className="w-32"
          onChange={(e) => onChange({ ...window, from: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-to`}>and</Label>
        <Input
          id={`${uid}-to`}
          type="time"
          min={bounds.from}
          max={bounds.to}
          value={window.to}
          disabled={disabled}
          className="w-32"
          onChange={(e) => onChange({ ...window, to: e.target.value })}
        />
      </div>
      {onRemove ? (
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={onRemove}
          aria-label="Remove these hours"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function KindWindows({
  kind,
  windows,
  disabled,
  onChange,
}: {
  kind: MeetingKind;
  windows: TimeWindow[];
  disabled: boolean;
  onChange: (windows: TimeWindow[]) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <legend className="px-1 text-sm font-medium">{KIND_LABEL[kind]}: starts between</legend>
      {windows.length === 0 ? <p className="text-sm text-[var(--fg-muted)]">Not offered.</p> : null}
      {windows.map((w, i) => (
        <WindowRow
          key={i}
          label="From"
          window={w}
          bounds={KIND_START_BOUNDS[kind]}
          disabled={disabled}
          onChange={(next) => onChange(windows.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(windows.filter((_, j) => j !== i))}
        />
      ))}
      {windows.length < 4 ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...windows,
              kind === 'dinner' ? { ...KIND_START_BOUNDS.dinner } : { from: '09:00', to: '10:00' },
            ])
          }
        >
          <Plus aria-hidden="true" />
          Add hours
        </Button>
      ) : null}
    </fieldset>
  );
}

function PlaceRow({
  place,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  place: Place;
  index: number;
  disabled: boolean;
  onChange: (place: Place) => void;
  onRemove: () => void;
}) {
  const uid = React.useId();
  return (
    <div className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-n`}>Place {index + 1}</Label>
        <Input
          id={`${uid}-n`}
          value={place.name}
          maxLength={80}
          disabled={disabled}
          placeholder="Name"
          onChange={(e) => onChange({ ...place, name: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-a`}>Area</Label>
        <Input
          id={`${uid}-a`}
          value={place.area}
          maxLength={80}
          disabled={disabled}
          placeholder="Neighbourhood"
          onChange={(e) => onChange({ ...place, area: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-m`}>Map link (optional)</Label>
        <Input
          id={`${uid}-m`}
          type="url"
          value={place.mapUrl ?? ''}
          maxLength={500}
          disabled={disabled}
          placeholder="https://"
          onChange={(e) =>
            onChange({ ...place, mapUrl: e.target.value.trim() ? e.target.value : null })
          }
        />
      </div>
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove place ${index + 1}`}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}
