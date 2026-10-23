'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  CalendarCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  ExternalLink,
  Hourglass,
  Pencil,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Notice, Skeleton } from '@/components/ui/feedback';
import { Input, Label, Switch } from '@/components/ui/form';
import { countOpen, statusChecks, type StatusCheck } from '@/lib/booking/planner-status';
import { BOOKING_PATH } from '@/lib/booking/tabs';
import { zoneName } from '@/lib/booking/public';
import { tabHref } from '@/lib/util/page-tabs';
import { cn } from '@/lib/util/cn';
import { useBookings, usePreview, useSettingsSave } from './hooks';
import { WhyNoTimes } from './reasons';

export interface OverviewPanelProps {
  enabled: boolean;
  slug: string;
  /** "https://copilot.tiptop.vc/meet/" */
  linkBase: string;
  approveFirst: boolean;
  canEdit: boolean;
  editing: { allowed: boolean; demo: boolean; connected: boolean };
  profile: { displayName: string; title: string; bio: string };
  inPersonOffered: boolean;
  today: string;
  hostZone: string;
  /** The months switched on, from this month on. */
  openMonths: string[];
  lastOpenDay: string | null;
}

const PREVIEW_DAYS = 14;

/**
 * Overview: the link (copy, open), one big on/off, Instant (the default)
 * or Approve first, the checks that would otherwise leave the page empty
 * or half set up, and "Why no times?" for the next two weeks, day by day,
 * through the same engine as the public page.
 */
export function OverviewPanel(props: OverviewPanelProps) {
  const { save, saving } = useSettingsSave();
  const [enabled, setEnabled] = React.useState(props.enabled);
  const [approveFirst, setApproveFirst] = React.useState(props.approveFirst);
  const [slug, setSlug] = React.useState(props.slug);
  const [editingSlug, setEditingSlug] = React.useState(false);
  const [draftSlug, setDraftSlug] = React.useState(props.slug);
  const preview = usePreview({ from: props.today, days: PREVIEW_DAYS }, 0);
  const upcoming = useBookings('upcoming', 0);
  const url = `${props.linkBase}${slug}`;
  const disabled = !props.canEdit || saving;

  const open = preview.data ? countOpen(preview.data.days) : null;
  const checks = statusChecks({
    enabled,
    editing: props.editing,
    profile: props.profile,
    inPersonOffered: props.inPersonOffered,
    nextTwoWeeks: open,
    openMonths: props.openMonths,
    today: props.today,
    lastOpenDay: props.lastOpenDay,
  });
  const empty = open !== null && open.calls + open.inPerson === 0;
  const upcomingCount =
    upcoming.state === 'ok'
      ? upcoming.bookings.filter(
          (b) => b.status === 'booked' || b.status === 'held' || b.status === 'pending',
        ).length
      : null;

  const toggleOn = async (next: boolean) => {
    setEnabled(next);
    const saved = await save({ enabled: next }, next ? 'The link is on' : 'The link is off');
    if (!saved) setEnabled(!next);
  };
  const setMode = async (next: boolean) => {
    if (next === approveFirst) return;
    setApproveFirst(next);
    const saved = await save(
      { config: { approveFirst: next } },
      next ? 'Bookings now wait for approval' : 'Bookings now go straight on the calendar',
    );
    if (!saved) setApproveFirst(!next);
  };
  const saveSlug = async () => {
    const saved = await save({ slug: draftSlug.trim().toLowerCase() }, 'Link name saved');
    if (saved) {
      setSlug(saved.slug);
      setEditingSlug(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* The link and the big switch. */}
      <Card data-tour="booking-link-card">
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <span
            aria-hidden="true"
            className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)] sm:flex"
          >
            <CalendarCheck className="size-5" />
          </span>
          <div className="min-w-[min(100%,18rem)] flex-1 space-y-1.5">
            <p className="text-micro font-medium tracking-[0.14em] text-[var(--label-gold)] uppercase">
              Booking link
            </p>
            {editingSlug ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="booking-slug">Link name</Label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm break-all text-[var(--fg-muted)]">
                      {props.linkBase}
                    </span>
                    <Input
                      id="booking-slug"
                      value={draftSlug}
                      maxLength={40}
                      className="w-36"
                      onChange={(e) => setDraftSlug(e.target.value.toLowerCase())}
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={saving}
                  onClick={() => void saveSlug()}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraftSlug(slug);
                    setEditingSlug(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <p className="text-base font-semibold break-all" data-testid="booking-url">
                {url}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-0.5">
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
              {props.canEdit && !editingSlug ? (
                <Button size="sm" variant="ghost" onClick={() => setEditingSlug(true)}>
                  <Pencil aria-hidden="true" />
                  Change the name
                </Button>
              ) : null}
            </div>
          </div>
          <label
            className={cn(
              'flex w-full shrink-0 items-center justify-between gap-3 rounded-[var(--radius-panel)] border px-4 py-3 sm:w-auto sm:justify-start',
              enabled
                ? 'border-[var(--ok)]/40 bg-[var(--ok-soft)]'
                : 'border-[var(--border-strong)] bg-[var(--bg-sunken)]',
            )}
          >
            <span className="text-sm">
              <span className="block font-semibold">
                {enabled ? 'Taking bookings' : 'Not taking bookings'}
              </span>
              <span className="block text-xs text-[var(--fg-muted)]">
                {enabled ? 'The page is live.' : 'The page says it is closed.'}
              </span>
            </span>
            <Switch
              checked={enabled}
              disabled={disabled}
              onCheckedChange={(v) => void toggleOn(v)}
              aria-label="Take bookings"
              className="scale-125"
            />
          </label>
        </CardContent>
      </Card>

      {/* Instant or approve first. */}
      <fieldset data-tour="booking-mode" className="space-y-2">
        <legend className="text-sm font-medium">When someone books a free time</legend>
        <div role="radiogroup" aria-label="Booking mode" className="grid gap-2 sm:grid-cols-2">
          <ModeOption
            checked={!approveFirst}
            disabled={disabled}
            icon={<Zap className="size-4" aria-hidden="true" />}
            title="Instant"
            badge="Default"
            body="It goes straight on the calendar and the invite goes out. The rules already decide what is free."
            onSelect={() => void setMode(false)}
          />
          <ModeOption
            checked={approveFirst}
            disabled={disabled}
            icon={<Hourglass className="size-4" aria-hidden="true" />}
            title="Approve first"
            body="Each booking waits on the Bookings tab until someone approves it."
            onSelect={() => void setMode(true)}
          />
        </div>
      </fieldset>

      {/* The checks. */}
      <section aria-labelledby="booking-checks" data-tour="booking-checks" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="booking-checks" className="text-title font-serif font-semibold">
            Status
          </h2>
          <p className="text-sm text-[var(--fg-muted)]">
            Upcoming bookings:{' '}
            <Link
              href={tabHref(BOOKING_PATH, 'bookings', 'overview')}
              className="link-inline tabular font-semibold"
            >
              {upcomingCount ?? '—'}
            </Link>
          </p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {checks.map((check) => (
            <CheckCard key={check.key} check={check} />
          ))}
          {preview.loading ? (
            <li className="rounded-md border border-[var(--border)] p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </li>
          ) : null}
        </ul>
      </section>

      {/* Why no times? */}
      <section aria-labelledby="booking-why" data-tour="booking-why" className="space-y-2">
        <details
          open={empty || undefined}
          className="group rounded-md border border-[var(--border)]"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-4 text-[var(--fg-subtle)] transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            <h2 id="booking-why" className="text-title font-serif font-semibold whitespace-nowrap">
              Why no times?
            </h2>
            <span className="basis-full pl-6 text-sm text-[var(--fg-muted)] sm:basis-auto sm:pl-0">
              The next 2 weeks, day by day, as visitors see them.
            </span>
          </summary>
          <div className="space-y-2 border-t border-[var(--border)] p-3">
            {preview.error ? <Notice tone="warn">{preview.error}</Notice> : null}
            {preview.data?.state === 'unavailable' && preview.data.message ? (
              <Notice tone="warn">{preview.data.message}</Notice>
            ) : null}
            {preview.data ? (
              <>
                <p className="text-xs text-[var(--fg-muted)]">
                  Times in {zoneName(preview.data.hostZone)}. Each closed day says why.
                </p>
                <WhyNoTimes days={preview.data.days} zone={preview.data.hostZone} />
              </>
            ) : preview.loading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-3/4" />
              </div>
            ) : null}
          </div>
        </details>
      </section>
    </div>
  );
}

function ModeOption({
  checked,
  disabled,
  icon,
  title,
  badge,
  body,
  onSelect,
}: {
  checked: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  body: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-panel)] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70',
        checked
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[inset_0_0_0_1px_var(--accent)]'
          : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
          checked
            ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
            : 'bg-[var(--bg-sunken)] text-[var(--fg-muted)]',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {title}
          {badge ? <Badge tone="accent">{badge}</Badge> : null}
        </span>
        <span className="mt-0.5 block text-sm text-[var(--fg-muted)]">{body}</span>
      </span>
    </button>
  );
}

function CheckCard({ check }: { check: StatusCheck }) {
  const Icon =
    check.state === 'ok' ? CircleCheck : check.state === 'warn' ? CircleAlert : CircleDashed;
  const href = check.fix
    ? check.fix.href.startsWith('/')
      ? check.fix.href
      : tabHref(BOOKING_PATH, check.fix.href, 'overview')
    : null;
  return (
    <li
      data-check={check.key}
      data-state={check.state}
      // The tour's month step lands here (only one subtab shows at a time).
      data-tour={check.key === 'months' ? 'booking-months' : undefined}
      className={cn(
        'flex items-start gap-2.5 rounded-md border p-3',
        check.state === 'warn'
          ? 'border-[var(--warn)]/30 bg-[var(--warn-soft)]'
          : 'border-[var(--border)]',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          check.state === 'ok'
            ? 'text-[var(--ok)]'
            : check.state === 'warn'
              ? 'text-[var(--warn)]'
              : 'text-[var(--fg-subtle)]',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{check.title}</p>
        {/* On a phone a check that is fine is its title alone: no long scroll. */}
        <p
          className={cn('text-sm text-[var(--fg-muted)]', check.state === 'ok' && 'max-sm:hidden')}
        >
          {check.detail}
        </p>
        {href && check.fix ? (
          href.startsWith('/api/') ? (
            // A server round trip (Google's consent screen), not a page.
            <a href={href} className="link-inline mt-1 inline-block text-sm">
              {check.fix.label} →
            </a>
          ) : (
            <Link href={href} className="link-inline mt-1 inline-block text-sm">
              {check.fix.label} →
            </Link>
          )
        ) : null}
      </div>
    </li>
  );
}
