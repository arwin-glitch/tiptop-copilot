import Link from 'next/link';
import { CalendarClock, Mail, UserRound } from 'lucide-react';
import {
  STUDENT_KINDS,
  STUDENT_KIND_FILTER_LABELS,
  STUDENT_KIND_LABELS,
  STUDENT_OWNERS,
  STUDENT_OWNER_LABELS,
  STUDENT_STATUS_FILTER_LABELS,
  STUDENT_STATUS_LABELS,
  STUDENTS_CADENCE_LABEL,
  STUDENTS_STALE_AFTER_DAYS,
  daysUntilDeadline,
  deadlineDistance,
  deadlineState,
  filterStudentItems,
  isOpenStudentItem,
  onArwin,
  sortStudentItems,
  sourceEmailId,
  studentFilterParams,
  studentWho,
  studentsFreshness,
  type StudentFilters,
  type StudentItem,
  type StudentStatus,
  type StudentStatusFilter,
  type StudentsSnapshot,
} from '@/lib/portfolio/students';
import { PORTFOLIO_TABS } from '@/lib/records-tabs';
import { SHOW_PARAM, showMoreHref, shownCount } from '@/lib/util/page-tabs';
import { formatDate, formatMonthDay, relativeTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { LinkChips, pageHref, type LinkChip } from '@/components/crm/link-chips';
import { ThreadLinks } from '@/components/email/thread-links';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { ShowMore } from '@/components/ui/show-more';

/**
 * The "Students & interns" tab on Portfolio: students Nick mentors, schools
 * and programs inviting TipTop in, and people asking to intern or for
 * advice, from the twice-weekly students routine's snapshot. Filters live in
 * the URL (`kind`, `status`, `owner`, `q`) and the server renders the result,
 * like Jobs beside it.
 *
 * Every value is plain text. A source is only ever its subject and date with
 * the two places to read it (Copilot's Inbox, or Gmail): never the email's
 * text. What is on Arwin (the next step is his) carries a gold rule and its
 * own badge, and is counted at the top with a link to just those.
 */

const TAB = 'students';
const STEP = 20;

const STATUS_TONE: Record<StudentStatus, BadgeProps['tone']> = {
  new: 'info',
  awaiting_nick: 'warn',
  nick_agreed: 'ok',
  nick_declined: 'neutral',
  replied: 'ok',
  scheduled: 'ok',
  done: 'neutral',
  expired: 'neutral',
};

/** Status chips beyond Open and All, in the order a person works through them. */
const STATUS_CHIP_ORDER: readonly StudentStatus[] = [
  'awaiting_nick',
  'new',
  'nick_agreed',
  'scheduled',
  'replied',
  'done',
  'nick_declined',
  'expired',
];

function hrefFor(filters: StudentFilters): string {
  return pageHref(
    PORTFOLIO_TABS.path,
    { tab: TAB, ...studentFilterParams(filters) },
    PORTFOLIO_TABS.defaultKey,
  );
}

/** The link to the tab, optionally filtered. */
export function studentsTabHref(filters: Partial<StudentFilters> = {}): string {
  return hrefFor({ kind: null, status: 'open', owner: null, q: '', ...filters });
}

export function PortfolioStudentsView({
  snapshot,
  filters,
  mailbox,
  now,
  timeZone,
  shownRaw,
}: {
  snapshot: StudentsSnapshot;
  filters: StudentFilters;
  /** The mailbox the routine read, for Gmail links. */
  mailbox: string;
  now: Date;
  timeZone: string;
  shownRaw: string | string[] | undefined;
}) {
  const items = sortStudentItems(snapshot.items, now);
  const visible = filterStudentItems(items, filters);
  const shown = shownCount(shownRaw, STEP, Math.max(visible.length, STEP));
  const page = visible.slice(0, shown);
  const freshness = studentsFreshness(snapshot.runAt, now);
  const arwin = onArwin(items);

  // Chips: each filter's counts with the other filters applied.
  const byKind = filterStudentItems(items, filters, 'kind');
  const kindChips: LinkChip[] = [
    {
      key: 'any-kind',
      label: 'Every kind',
      count: byKind.length,
      href: hrefFor({ ...filters, kind: null }),
      active: filters.kind === null,
    },
    ...STUDENT_KINDS.map((kind) => ({
      key: kind,
      label: STUDENT_KIND_FILTER_LABELS[kind],
      count: byKind.filter((i) => i.kind === kind).length,
      href: hrefFor({ ...filters, kind }),
      active: filters.kind === kind,
    })),
  ];

  const byStatus = filterStudentItems(items, filters, 'status');
  const statusCount = (status: StudentStatusFilter) =>
    filterStudentItems(byStatus, { ...filters, status }).length;
  // Open and All always; a single status only when something has it (or it is chosen).
  const statusChips: LinkChip[] = (['open', ...STATUS_CHIP_ORDER, 'all'] as const)
    .filter(
      (status) =>
        status === 'open' ||
        status === 'all' ||
        status === filters.status ||
        statusCount(status) > 0,
    )
    .map((status) => ({
      key: status,
      label: STUDENT_STATUS_FILTER_LABELS[status],
      count: statusCount(status),
      href: hrefFor({ ...filters, status }),
      active: filters.status === status,
    }));

  const byOwner = filterStudentItems(items, filters, 'owner');
  const ownerChips: LinkChip[] = [
    {
      key: 'anyone',
      label: 'Any next step',
      count: byOwner.length,
      href: hrefFor({ ...filters, owner: null }),
      active: filters.owner === null,
    },
    ...STUDENT_OWNERS.map((owner) => ({
      key: `owner-${owner}`,
      label: `On ${STUDENT_OWNER_LABELS[owner]}`,
      count: byOwner.filter((i) => i.next_owner === owner).length,
      href: hrefFor({ ...filters, owner }),
      active: filters.owner === owner,
    })),
  ];

  const keep: Record<string, string> = {
    tab: TAB,
    ...studentFilterParams({ ...filters, q: '' }),
  };
  const filtered =
    filters.kind !== null || filters.status !== 'open' || filters.owner !== null || filters.q;

  return (
    <section aria-label="Students and interns">
      <SectionHeading count={visible.length}>Students &amp; interns</SectionHeading>
      <p className="-mt-1 mb-3 text-sm text-[var(--fg-muted)]">
        Students Nick mentors, schools and programs inviting TipTop in, and people asking to intern
        or for advice, read by a scan of the mailbox {STUDENTS_CADENCE_LABEL}. Scanned{' '}
        {relativeTime(snapshot.runAt, now)}
        {snapshot.emailsScanned !== null
          ? ` · ${snapshot.emailsScanned} ${snapshot.emailsScanned === 1 ? 'email' : 'emails'} read`
          : ''}
        {snapshot.scannedSince ? ` since ${formatDate(snapshot.scannedSince, timeZone)}` : ''}.
      </p>

      <div className="mb-4 space-y-3">
        {freshness.stale ? (
          <Notice tone="warn">
            <span className="font-medium">Overdue:</span> the scan last ran{' '}
            {formatDate(snapshot.runAt, timeZone)}, {freshness.days} days ago, so new asks may be
            missing. It runs {STUDENTS_CADENCE_LABEL} and is overdue after{' '}
            {STUDENTS_STALE_AFTER_DAYS} days.
          </Notice>
        ) : null}
        {snapshot.partial ? (
          <Notice>The latest scan is still posting. This shows the part that has arrived.</Notice>
        ) : null}
        {snapshot.dropped > 0 ? (
          <Notice>
            {snapshot.dropped} {snapshot.dropped === 1 ? 'item' : 'items'} in the scan could not be
            read and {snapshot.dropped === 1 ? 'is' : 'are'} left out.
          </Notice>
        ) : null}
        {arwin.length > 0 && filters.owner !== 'arwin' ? (
          <Notice>
            <span className="font-medium">
              {arwin.length === 1
                ? '1 open item has its next step on Arwin.'
                : `${arwin.length} open items have their next step on Arwin.`}
            </span>{' '}
            <Link
              href={studentsTabHref({ owner: 'arwin' })}
              scroll={false}
              className="text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-2 hover:decoration-current"
            >
              Show {arwin.length === 1 ? 'it' : 'them'}
            </Link>
          </Notice>
        ) : null}
        <LinkChips label="Filter by kind" chips={kindChips} />
        <LinkChips label="Filter by status" chips={statusChips} />
        <LinkChips label="Filter by next step" chips={ownerChips} />
        <LiveSearch
          path={PORTFOLIO_TABS.path}
          keep={keep}
          reset={[SHOW_PARAM]}
          value={filters.q}
          placeholder="Search name, school, program or ask"
          label="Search students and programs"
          className="max-w-sm"
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="Nothing from students or programs in the latest scan"
          description={`The scan reads the mailbox ${STUDENTS_CADENCE_LABEL} for mentoring asks, school and program invitations, and students asking to intern or for advice. New ones show here after the next run.`}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description={
            filters.status === 'open'
              ? 'Nothing open matches these filters. Try All, or clear the filters.'
              : 'Nothing matches these filters.'
          }
          action={filtered ? { label: 'Clear filters', href: studentsTabHref() } : undefined}
        />
      ) : (
        <>
          <ul className="space-y-3" aria-label="Students and programs">
            {page.map((item) => (
              <li key={item.id}>
                <StudentCard item={item} mailbox={mailbox} now={now} timeZone={timeZone} />
              </li>
            ))}
          </ul>
          <ShowMore
            shown={page.length}
            total={visible.length}
            step={STEP}
            href={showMoreHref(
              PORTFOLIO_TABS.path,
              { tab: TAB, ...studentFilterParams(filters) },
              shown,
              STEP,
            )}
          />
        </>
      )}
    </section>
  );
}

function StudentCard({
  item,
  mailbox,
  now,
  timeZone,
}: {
  item: StudentItem;
  mailbox: string;
  now: Date;
  timeZone: string;
}) {
  const who = studentWho(item);
  const where = [item.person ? item.school_or_org : null, item.program].filter((p): p is string =>
    Boolean(p),
  );
  const deadline = deadlineState(item, now);
  const days = daysUntilDeadline(item, now);
  // Arwin's to do: the next step is his and the item is still open.
  const mine = item.next_owner === 'arwin' && isOpenStudentItem(item);
  const [latest, ...earlier] = item.sources;

  return (
    <Card
      className={cn(
        // What is on Arwin: a gold rule down the card's edge, and its own badge below.
        mine && 'border-l-[3px] border-l-[var(--gold)] bg-[var(--note-soft)]',
      )}
    >
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-serif text-base font-semibold break-words">{who}</h3>
            {where.length > 0 ? (
              <p className="text-sm break-words text-[var(--fg-muted)]">{where.join(' · ')}</p>
            ) : null}
          </div>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">{STUDENT_KIND_LABELS[item.kind]}</Badge>
            <Badge tone={STATUS_TONE[item.status]}>{STUDENT_STATUS_LABELS[item.status]}</Badge>
          </span>
        </div>

        <p className="mt-2 text-sm break-words">
          <span className="text-[var(--fg-subtle)]">Ask: </span>
          {item.ask}
        </p>
        {item.commitment ? (
          <p className="mt-1 text-sm break-words">
            <span className="text-[var(--fg-subtle)]">Nick agreed to: </span>
            {item.commitment}
          </p>
        ) : null}

        {item.deadline && days !== null ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
            <CalendarClock className="size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
            <span className="text-[var(--fg-subtle)]">Deadline:</span>
            <span className={cn(deadline !== 'later' && 'font-medium')}>
              {formatMonthDay(item.deadline, timeZone)}
            </span>
            {deadline === 'soon' ? (
              <Badge tone="warn">Due {deadlineDistance(days)}</Badge>
            ) : deadline === 'passed' ? (
              <Badge tone="danger">Passed {deadlineDistance(days)}</Badge>
            ) : (
              <span className="text-xs text-[var(--fg-subtle)]">{deadlineDistance(days)}</span>
            )}
          </p>
        ) : null}

        {item.next_step || item.next_owner ? (
          <p
            className={cn(
              'mt-2 flex flex-wrap items-center gap-1.5 text-sm break-words',
              mine && 'font-medium',
            )}
          >
            <UserRound className="size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden />
            <span className="text-[var(--fg-subtle)]">Next step:</span>
            {item.next_step ? <span className="min-w-0">{item.next_step}</span> : null}
            {item.next_owner === 'arwin' ? (
              <Badge tone="outline" className="border-[var(--gold-rule)] text-[var(--label-gold)]">
                On Arwin
              </Badge>
            ) : item.next_owner === 'nick' ? (
              <Badge tone="outline">On Nick</Badge>
            ) : null}
          </p>
        ) : null}

        <p className="mt-2 text-xs text-[var(--fg-subtle)]">
          {item.nick_replied
            ? `Nick replied${item.last_reply_date ? ` ${formatMonthDay(item.last_reply_date, timeZone)}` : ''}`
            : 'No reply from Nick yet'}{' '}
          · First seen {formatMonthDay(item.first_seen, timeZone)} · Last seen{' '}
          {formatMonthDay(item.last_seen, timeZone)}
        </p>

        {latest ? (
          <div className="mt-3 space-y-2">
            <SourceRow source={latest} mailbox={mailbox} timeZone={timeZone} who={who} />
            {earlier.length > 0 ? (
              <details>
                <summary className="cursor-pointer text-sm text-[var(--accent)]">
                  {earlier.length === 1 ? 'Earlier email' : `Earlier emails (${earlier.length})`}
                </summary>
                <ul className="mt-2 space-y-2" aria-label={`Earlier emails about ${who}`}>
                  {earlier.map((s) => (
                    <li key={`${sourceEmailId(s)}-${s.date}`}>
                      <SourceRow source={s} mailbox={mailbox} timeZone={timeZone} who={who} />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One source: its subject and date, and the two places to read it. Never its text. */
function SourceRow({
  source,
  mailbox,
  timeZone,
  who,
}: {
  source: StudentItem['sources'][number];
  mailbox: string;
  timeZone: string;
  who: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-sm">
      <span className="flex min-w-0 items-start gap-2">
        <Mail className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {source.subject}
          <span className="text-xs text-[var(--fg-subtle)]">
            {' '}
            · {formatDate(source.date, timeZone)}
          </span>
        </span>
      </span>
      <ThreadLinks
        id={sourceEmailId(source)}
        mailbox={mailbox}
        label={`${source.subject} (${who})`}
      />
    </div>
  );
}
