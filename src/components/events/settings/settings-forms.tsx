'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { eventsApi, opId } from '@/components/events/events-client';
import type { EventStatus, EventVisibility } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { SUPPORTED_TIMEZONES } from '@/lib/util/time';

/**
 * The Manage tab's forms (D-075): the event's details (title, time zone,
 * venue), the link, who can find the page, search and share text, and cancel / unpublish / archive / delete. Each
 * saves through the events API on its own; anything that changes what guests
 * see or cannot be undone asks first.
 */

function useSave() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const save = async (
    work: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ): Promise<boolean> => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return false;
    }
    toast.success(done);
    router.refresh();
    return true;
  };
  return { busy, save };
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
const RESERVED = ['edit', 'checkin', 'api', 'new', 'i', 'c'];

export function LinkForm({
  eventId,
  slug,
  origin,
}: {
  eventId: string;
  slug: string;
  origin: string;
}) {
  const [value, setValue] = React.useState(slug);
  const { busy, save } = useSave();
  const clean = value.trim().toLowerCase();
  const problem = !SLUG_RE.test(clean)
    ? 'Lowercase letters, numbers and dashes, up to 50, starting and ending with a letter or number.'
    : RESERVED.includes(clean)
      ? 'That word is reserved.'
      : null;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || clean === slug) return;
        void save(
          () => eventsApi.patch(eventId, { slug: clean }),
          'Link changed. The old one keeps working.',
        );
      }}
    >
      <Field
        label="Address"
        htmlFor="event-slug"
        hint={
          problem && clean !== slug
            ? problem
            : 'Changing it keeps the old link working: it forwards here, for good.'
        }
      >
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-sm text-[var(--fg-muted)]">{origin}/e/</span>
          <Input
            id="event-slug"
            value={value}
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="event-slug-hint"
            aria-invalid={Boolean(problem) && clean !== slug}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={Boolean(problem) || clean === slug}
      >
        Save link
      </Button>
    </form>
  );
}

export interface DetailsValues {
  title: string;
  timeZone: string;
  venue: {
    kind: 'in_person' | 'online' | 'hybrid';
    name: string | null;
    address: string | null;
    maps_url: string | null;
    online_url: string | null;
    notes: string | null;
    reveal: 'public' | 'registered' | 'going';
  };
}

const REVEAL_LABELS: Record<DetailsValues['venue']['reveal'], string> = {
  public: 'Everyone who can open the page',
  registered: 'Registered guests (Going or Maybe)',
  going: 'Going guests only',
};

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * The event's own details: its title, time zone and venue (name, address,
 * map and online links, notes, and who sees the address). Sessions can
 * override the venue in Registration; this is the event-wide one the Venue
 * section, the details line and messages use.
 */
export function DetailsForm({ eventId, initial }: { eventId: string; initial: DetailsValues }) {
  const [title, setTitle] = React.useState(initial.title);
  const [zone, setZone] = React.useState(initial.timeZone);
  const [venue, setVenue] = React.useState(initial.venue);
  const { busy, save } = useSave();
  const zones = SUPPORTED_TIMEZONES.includes(zone as (typeof SUPPORTED_TIMEZONES)[number])
    ? [...SUPPORTED_TIMEZONES]
    : [zone, ...SUPPORTED_TIMEZONES];
  const set = <K extends keyof DetailsValues['venue']>(key: K, value: DetailsValues['venue'][K]) =>
    setVenue((v) => ({ ...v, [key]: value }));
  const text = (value: string) => value.trim() || null;
  const online = venue.kind !== 'in_person';
  const inPerson = venue.kind !== 'online';
  const problem = !title.trim()
    ? 'Give the event a title.'
    : venue.maps_url && !URL_RE.test(venue.maps_url.trim())
      ? 'The map link starts with https://.'
      : venue.online_url && !URL_RE.test(venue.online_url.trim())
        ? 'The online link starts with https://.'
        : null;
  const changed =
    title.trim() !== initial.title ||
    zone !== initial.timeZone ||
    JSON.stringify(venue) !== JSON.stringify(initial.venue);
  return (
    <form
      className="space-y-3"
      data-form="event-details"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !changed) return;
        void save(
          () =>
            eventsApi.patch(eventId, {
              title: title.trim(),
              time_zone: zone,
              venue: {
                kind: venue.kind,
                name: text(venue.name ?? ''),
                address: inPerson ? text(venue.address ?? '') : null,
                maps_url: inPerson ? text(venue.maps_url ?? '') : null,
                online_url: online ? text(venue.online_url ?? '') : null,
                notes: text(venue.notes ?? ''),
                reveal: venue.reveal,
              },
            }),
          'Details saved.',
        );
      }}
    >
      <Field label="Title" htmlFor="event-title">
        <Input
          id="event-title"
          value={title}
          maxLength={140}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        label="Time zone"
        htmlFor="event-zone"
        hint="Times keep the same moment; the page shows them in this zone."
      >
        <Select
          id="event-zone"
          value={zone}
          aria-describedby="event-zone-hint"
          onChange={(e) => setZone(e.target.value)}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Where" htmlFor="event-venue-kind">
        <Select
          id="event-venue-kind"
          value={venue.kind}
          onChange={(e) => set('kind', e.target.value as DetailsValues['venue']['kind'])}
        >
          <option value="in_person">In person</option>
          <option value="online">Online</option>
          <option value="hybrid">In person and online</option>
        </Select>
      </Field>
      <Field label="Venue name" htmlFor="event-venue-name">
        <Input
          id="event-venue-name"
          value={venue.name ?? ''}
          maxLength={200}
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>
      {inPerson ? (
        <>
          <Field label="Street and city" htmlFor="event-venue-address">
            <Input
              id="event-venue-address"
              value={venue.address ?? ''}
              maxLength={400}
              autoComplete="off"
              onChange={(e) => set('address', e.target.value)}
            />
          </Field>
          <Field label="Map link" htmlFor="event-venue-maps" hint="Optional. https://…">
            <Input
              id="event-venue-maps"
              type="url"
              value={venue.maps_url ?? ''}
              maxLength={2000}
              aria-describedby="event-venue-maps-hint"
              onChange={(e) => set('maps_url', e.target.value)}
            />
          </Field>
        </>
      ) : null}
      {online ? (
        <Field label="Online link" htmlFor="event-venue-online" hint="https://…">
          <Input
            id="event-venue-online"
            type="url"
            value={venue.online_url ?? ''}
            maxLength={2000}
            aria-describedby="event-venue-online-hint"
            onChange={(e) => set('online_url', e.target.value)}
          />
        </Field>
      ) : null}
      <Field
        label="Notes for guests"
        htmlFor="event-venue-notes"
        hint="Parking, entrance, dress code."
      >
        <Textarea
          id="event-venue-notes"
          value={venue.notes ?? ''}
          maxLength={2000}
          rows={2}
          aria-describedby="event-venue-notes-hint"
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>
      <Field
        label="Who sees where it is"
        htmlFor="event-venue-reveal"
        hint="Pending requests and the waitlist never see a hidden address."
      >
        <Select
          id="event-venue-reveal"
          value={venue.reveal}
          aria-describedby="event-venue-reveal-hint"
          onChange={(e) => set('reveal', e.target.value as DetailsValues['venue']['reveal'])}
        >
          {(Object.keys(REVEAL_LABELS) as DetailsValues['venue']['reveal'][]).map((r) => (
            <option key={r} value={r}>
              {REVEAL_LABELS[r]}
            </option>
          ))}
        </Select>
      </Field>
      {problem && changed ? (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {problem}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={Boolean(problem) || !changed}
      >
        Save details
      </Button>
    </form>
  );
}

const VISIBILITY: { value: EventVisibility; label: string; detail: string }[] = [
  {
    value: 'public',
    label: 'Public',
    detail: 'Anyone with the link, and search engines can list it.',
  },
  {
    value: 'unlisted',
    label: 'Unlisted',
    detail: 'Anyone with the link. Hidden from search engines.',
  },
  {
    value: 'private',
    label: 'Private',
    detail: 'Only guests with their personal link. Hidden from search engines.',
  },
];

export function VisibilityForm({
  eventId,
  visibility,
}: {
  eventId: string;
  visibility: EventVisibility;
}) {
  const [value, setValue] = React.useState<EventVisibility>(visibility);
  const { busy, save } = useSave();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(() => eventsApi.patch(eventId, { visibility: value }), 'Visibility saved.');
      }}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Who can find the page</legend>
        {VISIBILITY.map((v) => (
          <label
            key={v.value}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2',
              value === v.value
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border)]',
            )}
          >
            <input
              type="radio"
              name="event-visibility"
              value={v.value}
              checked={value === v.value}
              onChange={() => setValue(v.value)}
              className="mt-1 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-medium">{v.label}</span>
              <span className="block text-xs text-[var(--fg-muted)]">{v.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        loading={busy}
        disabled={value === visibility}
      >
        Save visibility
      </Button>
    </form>
  );
}

export interface SeoValues {
  seoTitle: string;
  seoDescription: string;
  ogLayout: 'cover' | 'type' | 'ticket';
  rev: number;
}

/** Search and share text lives in the draft page (doc meta): live after the next publish. */
export function SeoForm({
  eventId,
  draftVersion,
  initial,
  title,
}: {
  eventId: string;
  draftVersion: number;
  initial: SeoValues;
  title: string;
}) {
  const [seoTitle, setSeoTitle] = React.useState(initial.seoTitle);
  const [seoDescription, setSeoDescription] = React.useState(initial.seoDescription);
  const [ogLayout, setOgLayout] = React.useState(initial.ogLayout);
  const { busy, save } = useSave();
  const changed =
    seoTitle !== initial.seoTitle ||
    seoDescription !== initial.seoDescription ||
    ogLayout !== initial.ogLayout;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(async () => {
          const result = await eventsApi.draftOps(eventId, {
            baseVersion: draftVersion,
            ops: [
              {
                kind: 'page.update',
                opId: opId('seo'),
                baseRev: initial.rev,
                set: { seoTitle: seoTitle.trim(), seoDescription: seoDescription.trim(), ogLayout },
              },
            ],
          });
          if (!result.ok) return result;
          const conflict = result.data.conflicts[0];
          return conflict
            ? { ok: false as const, message: `${conflict.message} Reload to see it.` }
            : { ok: true as const };
        }, 'Saved to the draft. It goes live when you publish.');
      }}
    >
      <Field
        label="Title in search and link previews"
        htmlFor="event-seo-title"
        hint={`Empty: “${title}”. Up to 70 characters.`}
      >
        <Input
          id="event-seo-title"
          value={seoTitle}
          maxLength={70}
          aria-describedby="event-seo-title-hint"
          onChange={(e) => setSeoTitle(e.target.value)}
        />
      </Field>
      <Field
        label="Description"
        htmlFor="event-seo-description"
        hint="One or two sentences, up to 200 characters."
      >
        <Textarea
          id="event-seo-description"
          value={seoDescription}
          maxLength={200}
          rows={3}
          aria-describedby="event-seo-description-hint"
          onChange={(e) => setSeoDescription(e.target.value)}
        />
      </Field>
      <Field label="Share card layout" htmlFor="event-og-layout">
        <Select
          id="event-og-layout"
          value={ogLayout}
          onChange={(e) => setOgLayout(e.target.value as SeoValues['ogLayout'])}
        >
          <option value="cover">Cover photo</option>
          <option value="type">Big type</option>
          <option value="ticket">Ticket</option>
        </Select>
      </Field>
      <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!changed}>
        Save to draft
      </Button>
    </form>
  );
}

export function DangerZone({
  eventId,
  title,
  status,
  cancelMessage,
}: {
  eventId: string;
  title: string;
  status: EventStatus;
  cancelMessage: string | null;
}) {
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [message, setMessage] = React.useState(cancelMessage ?? '');
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (
    key: string,
    question: Parameters<typeof confirm>[0] | null,
    work: () => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>,
    done: string,
    after?: (data: unknown) => void,
  ) => {
    if (question && !(await confirm(question))) return;
    setBusy(key);
    const result = await work();
    setBusy(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(done);
    if (after) after(result.data);
    else router.refresh();
  };

  const openCopy = (data: unknown) => {
    const id = (data as { id?: unknown })?.id;
    if (typeof id === 'string') router.push(`/events/${encodeURIComponent(id)}`);
    else router.refresh();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={busy === 'duplicate'}
          onClick={() =>
            void act(
              'duplicate',
              null,
              () => eventsApi.duplicate(eventId, { shiftDays: 0 }),
              'Duplicated as a new draft.',
              openCopy,
            )
          }
        >
          Duplicate
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={busy === 'next-year'}
          onClick={() =>
            void act(
              'next-year',
              null,
              () => eventsApi.duplicate(eventId, { shiftDays: 364 }),
              'Duplicated as next year’s draft, dates moved on a year (same weekday).',
              openCopy,
            )
          }
        >
          Duplicate as next year
        </Button>
      </div>

      {status === 'published' ? (
        <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
          <p className="text-sm font-medium">Cancel the event</p>
          <p className="text-xs text-[var(--fg-muted)]">
            The link stays up as a cancelled notice with your message. Then you can draft a
            cancellation email to guests from Messages. Nothing is sent for you.
          </p>
          <Field label="Message on the page" htmlFor="event-cancel-message">
            <Textarea
              id="event-cancel-message"
              rows={2}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="We are sorry to cancel. We will share a new date soon."
            />
          </Field>
          <Button
            type="button"
            size="sm"
            variant="danger"
            loading={busy === 'cancel'}
            onClick={() =>
              void act(
                'cancel',
                {
                  title: `Cancel ${title}?`,
                  description:
                    'The page shows that it is cancelled. Guests are kept, and nobody is emailed until you send a notice.',
                  confirmLabel: 'Cancel the event',
                  cancelLabel: 'Keep it',
                  tone: 'danger',
                },
                () => eventsApi.cancel(eventId, message.trim() || null),
                'Cancelled. Draft the notice to guests from Messages.',
              )
            }
          >
            Cancel the event
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === 'published' ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === 'unpublish'}
            onClick={() =>
              void act(
                'unpublish',
                {
                  title: `Unpublish ${title}?`,
                  description:
                    'The public link stops working until you publish again. Every guest and answer is kept.',
                  confirmLabel: 'Unpublish',
                  tone: 'danger',
                },
                () => eventsApi.unpublish(eventId),
                'Unpublished. The link is off; guests are kept.',
              )
            }
          >
            Unpublish
          </Button>
        ) : null}
        {status !== 'draft' && status !== 'archived' ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={busy === 'archive'}
            onClick={() =>
              void act(
                'archive',
                {
                  title: `Archive ${title}?`,
                  description: 'It moves to Past. Guests, messages and the page are kept.',
                  confirmLabel: 'Archive',
                },
                () => eventsApi.archive(eventId),
                'Archived.',
              )
            }
          >
            Archive
          </Button>
        ) : null}
        {status === 'draft' ? (
          <Button
            type="button"
            size="sm"
            variant="danger"
            loading={busy === 'delete'}
            onClick={() =>
              void act(
                'delete',
                {
                  title: `Delete the draft ${title}?`,
                  description:
                    'The draft and its page are deleted for good. This cannot be undone.',
                  confirmLabel: 'Delete draft',
                  tone: 'danger',
                },
                () => eventsApi.remove(eventId),
                'Draft deleted.',
                () => router.push('/events?tab=drafts'),
              )
            }
          >
            Delete draft
          </Button>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  );
}
