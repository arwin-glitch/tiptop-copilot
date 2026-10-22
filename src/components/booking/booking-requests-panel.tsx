'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  CalendarPlus,
  Check,
  Coffee,
  Copy,
  ExternalLink,
  MapPin,
  MessageSquare,
  Video,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Composer, type ComposeDraft } from '@/components/inbox/composer';
import { KIND_LABEL, TYPE_LABEL } from '@/lib/booking/config';
import { slotLabel, zoneName } from '@/lib/booking/public';
import { relativeTime } from '@/lib/util/time';

/**
 * The Calendar tab's "Booking requests": what visitors sent from the booking
 * link, with everything they entered, waiting for a person. Approve re-checks
 * the time and only then puts the meeting on the host's calendar (the
 * requester invited); without calendar editing it offers the Google Calendar
 * page, filled in, instead. Decline marks it declined and can open a decline
 * email in the compose window, which sends only on Send.
 *
 * A button at the top right of the page's header (over the band, out of the
 * flow, so the calendar below does not move by a pixel) opens the list in a
 * drawer. Today's line links to /calendar#booking-requests, which opens it.
 */

const HASH = '#booking-requests';

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}
const hashAsksOpen = () => window.location.hash === HASH;
const serverClosed = () => false;

export interface PanelRequest {
  id: string;
  type: 'call' | 'in_person' | 'message';
  kind: 'coffee' | 'lunch' | 'dinner' | null;
  startsAt: string | null;
  visitorZone: string | null;
  name: string;
  email: string;
  company: string | null;
  placeName: string | null;
  placeArea: string | null;
  placeMapUrl: string | null;
  placeCustom: boolean;
  note: string | null;
  deckUrl: string | null;
  source: 'form' | 'chatbot';
  createdAt: string;
}

type Outcome =
  | { kind: 'grant'; reason: string; templateUrl: string }
  | { kind: 'problem'; message: string }
  | { kind: 'declined'; draft: ComposeDraft | null };

const httpsOnly = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

export function BookingRequestsPanel({
  requests: initial,
  timeZone,
  hostName,
  bookingUrl,
  enabled,
  instant,
  turnOnHref,
  canSend,
}: {
  requests: PanelRequest[];
  timeZone: string;
  hostName: string;
  bookingUrl: string | null;
  enabled: boolean;
  instant: boolean;
  turnOnHref: string | null;
  canSend: boolean;
}) {
  const router = useRouter();
  const [requests, setRequests] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [outcomes, setOutcomes] = React.useState<Record<string, Outcome>>({});
  const [compose, setCompose] = React.useState<ComposeDraft | null>(null);
  const fromLink = React.useSyncExternalStore(subscribeHash, hashAsksOpen, serverClosed);
  const [chosen, setChosen] = React.useState<boolean | null>(null);
  const open = chosen ?? fromLink;
  const setOpen = (next: boolean) => {
    setChosen(next);
    // Closing forgets the link's #booking-requests, so a reload does not reopen it.
    if (!next && window.location.hash === HASH) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };
  const host = hostName.split(/\s+/)[0] || 'the host';

  const act = async (id: string, action: 'approve' | 'decline' | 'handled' | 'added_by_hand') => {
    setBusy(`${id}:${action}`);
    const res = await fetch(`/api/booking/requests/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(null);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      outcome?: {
        state?: string;
        reason?: string;
        templateUrl?: string;
        draft?: { to: string; subject: string; body: string } | null;
      };
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok) {
      setOutcomes((o) => ({
        ...o,
        [id]: { kind: 'problem', message: json?.error?.message ?? 'That did not work. Try again.' },
      }));
      return;
    }
    const outcome = json.outcome ?? {};
    if (action === 'approve' && outcome.state === 'needs_grant') {
      setOutcomes((o) => ({
        ...o,
        [id]: {
          kind: 'grant',
          reason: outcome.reason ?? 'Calendar editing is off.',
          templateUrl: outcome.templateUrl ?? '',
        },
      }));
      return;
    }
    if (action === 'decline') {
      const draft = outcome.draft
        ? {
            ...outcome.draft,
            hints: [
              'Written as Arwin: pick Arwin’s signature before you send. Nothing sends on its own.',
            ],
          }
        : null;
      setOutcomes((o) => ({ ...o, [id]: { kind: 'declined', draft } }));
      toast.success('Declined. Nothing was sent.');
      router.refresh();
      return;
    }
    setRequests((list) => list.filter((r) => r.id !== id));
    toast.success(
      action === 'approve'
        ? `Added to ${host}'s calendar. The invitation went to the requester.`
        : action === 'handled'
          ? 'Marked handled.'
          : 'Marked approved.',
    );
    router.refresh();
  };

  const visible = requests;
  const waiting = requests.filter((r) => outcomes[r.id]?.kind !== 'declined').length;
  const description = `From the booking link. Approve checks the time again, then puts it on ${host}'s calendar and invites them. Times in ${zoneName(timeZone)}.`;

  return (
    <>
      <button
        type="button"
        id="booking-requests"
        data-tour="calendar-bookings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="dark shadow-raised absolute top-0 right-0 z-10 inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--gold-rule)] bg-[var(--bg-raised)] px-3 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--bg-hover)]"
      >
        <CalendarPlus className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
        <span className="max-sm:hidden">Booking requests</span>
        <span className="sm:hidden">Requests</span>
        {waiting ? (
          <span className="tabular rounded-full bg-[var(--primary)] px-1.5 text-[11px] leading-[18px] font-semibold text-[var(--primary-fg)]">
            {waiting}
            <span className="sr-only"> waiting</span>
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <Drawer title="Booking requests" description={description}>
          {bookingUrl ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'Link on' : 'Link off'}</Badge>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(bookingUrl).then(
                    () => toast.success('Link copied'),
                    () => toast.error('Copy did not work.'),
                  );
                }}
              >
                <Copy aria-hidden="true" />
                Copy link
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/settings?tab=booking">Settings</Link>
              </Button>
            </div>
          ) : null}
          {visible.length === 0 ? (
            <p className="text-sm text-[var(--fg-muted)]">No booking requests waiting.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {visible.map((r) => {
                const outcome = outcomes[r.id];
                const declined = outcome?.kind === 'declined';
                const icon =
                  r.type === 'call' ? (
                    <Video className="size-4" aria-hidden="true" />
                  ) : r.type === 'in_person' ? (
                    <Coffee className="size-4" aria-hidden="true" />
                  ) : (
                    <MessageSquare className="size-4" aria-hidden="true" />
                  );
                const what =
                  r.type === 'message'
                    ? 'Message'
                    : r.type === 'call'
                      ? TYPE_LABEL.call
                      : `${KIND_LABEL[r.kind ?? 'coffee']}, 1 hour in person`;
                const deck = httpsOnly(r.deckUrl);
                const map = httpsOnly(r.placeMapUrl);
                return (
                  <li
                    key={r.id}
                    className="py-4 first:pt-0 last:pb-0"
                    aria-label={`Request from ${r.name}`}
                  >
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
                        {icon}
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold">
                          {r.name}
                          {r.company ? (
                            <span className="font-normal text-[var(--fg-muted)]">
                              {' '}
                              · {r.company}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-sm">
                          {what}
                          {r.startsAt ? (
                            <>
                              {' · '}
                              <span className="font-medium">{slotLabel(r.startsAt, timeZone)}</span>
                              {r.visitorZone && r.visitorZone !== timeZone ? (
                                <span className="text-[var(--fg-muted)]">
                                  {' '}
                                  ({slotLabel(r.startsAt, r.visitorZone)} their time)
                                </span>
                              ) : null}
                            </>
                          ) : null}
                        </p>
                        {r.type === 'in_person' && r.placeName ? (
                          <p className="flex flex-wrap items-center gap-1 text-sm text-[var(--fg-muted)]">
                            <MapPin className="size-3.5" aria-hidden="true" />
                            {r.placeName}
                            {r.placeArea ? `, ${r.placeArea}` : ''}
                            {r.placeCustom ? ' (their suggestion)' : ''}
                            {map ? (
                              <a
                                href={map}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link-inline ml-1"
                              >
                                Map
                              </a>
                            ) : null}
                          </p>
                        ) : null}
                        <p className="text-sm text-[var(--fg-muted)]">
                          <a href={`mailto:${r.email}`} className="link-inline">
                            {r.email}
                          </a>
                          {' · '}asked {relativeTime(r.createdAt)}
                        </p>
                        {r.note ? (
                          <p className="text-read rounded-md bg-[var(--bg-sunken)] px-3 py-2 whitespace-pre-line">
                            {r.note}
                          </p>
                        ) : null}
                        {deck ? (
                          <p className="text-sm">
                            <a
                              href={deck}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link-inline inline-flex items-center gap-1"
                            >
                              Deck <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5">
                          {r.source === 'chatbot' ? (
                            <Badge tone="neutral">Filled with the chatbot</Badge>
                          ) : null}
                          {instant && r.type !== 'message' ? (
                            <Badge tone="info">Instant</Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {outcome?.kind === 'problem' ? (
                      <div role="alert" className="mt-3">
                        <Notice tone="warn">{outcome.message}</Notice>
                      </div>
                    ) : null}
                    {outcome?.kind === 'grant' ? (
                      <Notice tone="warn" className="mt-3">
                        <p>{outcome.reason}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {turnOnHref ? (
                            <Button asChild size="sm" variant="primary">
                              <a href={turnOnHref}>Turn on calendar editing</a>
                            </Button>
                          ) : null}
                          <Button asChild size="sm" variant="secondary">
                            <a href={outcome.templateUrl} target="_blank" rel="noopener noreferrer">
                              <CalendarPlus aria-hidden="true" />
                              Open in Google Calendar
                            </a>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === `${r.id}:added_by_hand`}
                            onClick={() => void act(r.id, 'added_by_hand')}
                          >
                            I added it in Google Calendar
                          </Button>
                        </div>
                      </Notice>
                    ) : null}

                    {declined ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-[var(--fg-muted)]">
                        <span>Declined. Nothing was sent.</span>
                        {outcome.draft ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              // The compose window sits on the page, not in the drawer.
                              setOpen(false);
                              setCompose(outcome.draft);
                            }}
                          >
                            Write a decline email
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRequests((list) => list.filter((x) => x.id !== r.id))}
                        >
                          Done
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2 sm:pl-11">
                        {r.type === 'message' ? (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busy === `${r.id}:handled`}
                            onClick={() => void act(r.id, 'handled')}
                          >
                            <Check aria-hidden="true" />
                            Mark handled
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busy === `${r.id}:approve`}
                            disabled={busy !== null}
                            onClick={() => void act(r.id, 'approve')}
                          >
                            <Check aria-hidden="true" />
                            Approve
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy === `${r.id}:decline`}
                          disabled={busy !== null}
                          onClick={() => void act(r.id, 'decline')}
                        >
                          <X aria-hidden="true" />
                          Decline
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Drawer>
      </Dialog>
      {compose ? (
        <Composer
          title="Decline email"
          initial={compose}
          canSend={canSend}
          onClose={() => setCompose(null)}
        />
      ) : null}
    </>
  );
}
