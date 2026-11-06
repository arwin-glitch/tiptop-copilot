import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowLeft, CalendarDays, ExternalLink, FileText, Lock, Mail, Eye } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { isDemoMode } from '@/lib/config/env';
import { googleConfigured } from '@/lib/google/oauth';
import { gmailThreadUrl } from '@/lib/deals/links';
import { getStore } from '@/lib/runtime';
import { afterResponse } from '@/lib/notes/background';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import {
  spaceLabelName,
  spaceLabelsEnabled,
  syncSpaceLabel,
} from '@/lib/services/space-gmail-labels';
import { SPACE_TABS, spaceTabHref } from '@/lib/records-tabs';
import {
  actionSuggestions,
  lastActivity,
  recentActivity,
  spaceEmailPage,
  spaceItems,
  spaceTasks,
  type SpaceEmailPage,
} from '@/lib/services/space-content';

type SpaceEmailPageMailbox = SpaceEmailPage['mailboxes'][number];
import {
  getSpaceAccess,
  spaceContributors,
  teamPeople,
  type SpaceAccess,
  type TeamPerson,
} from '@/lib/services/spaces';
import type { AuthContext } from '@/lib/auth/session';
import { resolveTab, single } from '@/lib/util/page-tabs';
import { formatDateTime, relativeTime } from '@/lib/util/time';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { ThreadLinks } from '@/components/email/thread-links';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, Notice, PlainText, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { Stat } from '@/components/ui/stat';
import { SpaceFormDialog } from '@/components/spaces/space-form';
import {
  ActionItems,
  HideItemButton,
  InviteAnswer,
  ConnectSpaceGoogle,
  MembersPanel,
  SpaceAsk,
  type MemberRow,
} from '@/components/spaces/space-controls';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ id: string }>; searchParams: Promise<Params> };

async function load(id: string) {
  if (!UUID.test(id)) notFound();
  const auth = await requireAuth();
  const store = getStore();
  const access = await getSpaceAccess(store, auth, id);
  return { auth, store, access };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: 'Space' };
  const { access } = await load(id);
  return { title: access.ok ? access.value.space.name : 'Space' };
}

/**
 * One Space, behind subtabs (never one long page): Overview, Emails, Meeting
 * log, Action items, Ask and Members. Members only: anyone else gets a 404,
 * as for a Space that does not exist. An invited person sees the invite and
 * nothing else until they accept.
 */
export default async function SpacePage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { access } = await load(id);
  if (!access.ok) {
    if (access.error.code === 'not_found') notFound();
    return (
      <PageShell>
        <PageHeader title="Spaces" />
        <Notice tone="warn">{access.error.message}</Notice>
      </PageShell>
    );
  }
  const a = access.value;
  if (a.canView) {
    // The Space's Gmail label (D-082), after the page has answered; at most
    // every ten minutes per Space. Never in the demo.
    await afterResponse('label the Space in Gmail', () =>
      syncSpaceLabel(getStore(), { space: a.space, rules: a.rules, hidden: a.hidden }),
    );
  }
  const tab = resolveTab(
    query.tab,
    SPACE_TABS.tabs.map((t) => t.key),
    SPACE_TABS.defaultKey,
  );
  const rules = [...a.set.domains, ...a.set.emails, ...a.set.keywords.map((k) => `"${k}"`)].join(
    ', ',
  );

  return (
    <PageShell>
      <Link
        href="/spaces"
        className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All Spaces
      </Link>
      <PageHeader
        title={a.space.name}
        subtitle={a.space.description ?? undefined}
        meta={
          <span className="text-xs text-[var(--fg-muted)]">Matches {rules || 'nothing yet'}</span>
        }
        actions={
          a.canManage ? (
            <SpaceFormDialog
              mode="edit"
              spaceId={a.space.id}
              initial={{
                name: a.space.name,
                description: a.space.description ?? '',
                domains: a.set.domains.join(', '),
                emails: a.set.emails.join(', '),
                keywords: a.set.keywords.join(', '),
              }}
            />
          ) : null
        }
      />
      {a.invited ? (
        <InviteCard access={a} />
      ) : (
        <>
          <PageTabs
            label={SPACE_TABS.navLabel}
            path={`/spaces/${a.space.id}`}
            tabs={SPACE_TABS.tabs.map((t) => ({ key: t.key, label: t.label }))}
            active={tab}
            defaultKey={SPACE_TABS.defaultKey}
          />
          <Suspense key={tab} fallback={<SkeletonText lines={8} />}>
            {tab === 'emails' ? (
              <EmailsTab access={a} query={query} />
            ) : tab === 'meetings' ? (
              <MeetingsTab access={a} />
            ) : tab === 'items' ? (
              <ItemsTab access={a} />
            ) : tab === 'ask' ? (
              <AskTab access={a} />
            ) : tab === 'members' ? (
              <MembersTab access={a} />
            ) : (
              <OverviewTab access={a} />
            )}
          </Suspense>
        </>
      )}
    </PageShell>
  );
}

async function InviteCard({ access }: { access: SpaceAccess }) {
  const auth = await requireAuth();
  const team = await teamPeople(getStore(), auth.organizationId);
  const owner = team.find((p) => p.userId === access.space.created_by)?.name ?? 'A colleague';
  return (
    <div className="max-w-xl rounded-[var(--radius-card)] border border-l-2 border-[var(--border)] border-l-[var(--gold)] bg-[var(--note-soft)] px-4 py-4">
      <p className="font-serif text-base font-semibold">{owner} invited you to this Space</p>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        Accept to see its emails, meetings and action items. If you have your own Google connected,
        your emails and meetings about it come in too, and only those. You can hide any of yours at
        any time. Nothing of yours comes in before you accept.
      </p>
      <div className="mt-3">
        <InviteAnswer spaceId={access.space.id} />
      </div>
    </div>
  );
}

const canHide = (access: SpaceAccess, auth: Pick<AuthContext, 'userId'>, owner: string) =>
  access.isOwner || owner === auth.userId;

/** "Riley's" from a teammate's name; "your" for the viewer. */
function whose(owner: string, team: TeamPerson[], auth: Pick<AuthContext, 'userId'>): string {
  if (owner === auth.userId) return 'your';
  const name = team.find((p) => p.userId === owner)?.name ?? 'a member';
  return `${name.split(/\s+/)[0] ?? name}'s`;
}

/**
 * The two places to read a contributor's email (D-081): Kraken's read-only
 * viewer, scoped to this Space, and Gmail in their own account (authuser =
 * their address). Never the Inbox, which reads the main mailbox alone.
 */
function ContributorThreadLinks({
  spaceId,
  itemId,
  threadId,
  mailbox,
  label,
}: {
  spaceId: string;
  itemId: string;
  threadId: string;
  mailbox: string | null;
  label: string;
}) {
  const gmail = gmailThreadUrl(threadId, mailbox);
  const icon =
    'inline-flex size-8 items-center justify-center rounded-md text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] sm:size-7';
  return (
    <span className="inline-flex items-center gap-0.5">
      <Link
        href={`/spaces/${spaceId}/email?item=${encodeURIComponent(itemId)}`}
        aria-label={`Open in Kraken: ${label}`}
        title="Read it here (read-only)"
        className={icon}
      >
        <Eye className="size-4" aria-hidden="true" />
      </Link>
      {gmail ? (
        <a
          href={gmail}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open in Gmail: ${label}`}
          title="Open in their Gmail"
          className={icon}
        >
          <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  );
}

/** Whose mailbox a row came from, once more than one mailbox is read. */
function SourceTag({ text }: { text: string }) {
  return (
    <span className="ml-1.5 rounded-full border border-[var(--border)] bg-[var(--accent-soft)] px-1.5 py-px text-[10px] font-medium text-[var(--accent)]">
      {text}
    </span>
  );
}

/* -------------------------------------------------------------- overview */

async function OverviewTab({ access }: { access: SpaceAccess }) {
  const auth = await requireAuth();
  const store = getStore();
  const now = new Date();
  const [items, tasks, team] = await Promise.all([
    spaceItems(store, access, now),
    spaceTasks(store, access),
    teamPeople(store, auth.organizationId),
  ]);
  const recent = recentActivity(items);
  // Invited people see nothing until they accept: until then it is only the owner's.
  const others = access.members.filter(
    (m) => m.status === 'accepted' && m.user_id !== access.space.created_by,
  ).length;
  const last = lastActivity(items, now);
  const tz = auth.profile.timezone;
  const primary = isDemoMode()
    ? null
    : await getPrimaryIntegration(store, auth.organizationId).catch(() => null);
  const gmailLabel = spaceLabelName(access.space.name);
  return (
    <div className="space-y-5" data-tour="space-overview">
      {others === 0 ? (
        <Notice>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5" aria-hidden="true" />
            Only you can see what is in this Space for now. Invite colleagues on Members.
          </span>
        </Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Emails" value={items.threads.length} size="sm" />
        <Stat
          label="Meetings"
          value={items.meetings.filter((m) => !m.upcoming).length}
          hint={`${items.meetings.filter((m) => m.upcoming).length} coming up`}
          size="sm"
        />
        <Stat label="Notes" value={items.notes.length} size="sm" />
        <Stat
          label="Open items"
          value={tasks.filter((t) => t.status === 'open').length}
          size="sm"
        />
      </div>
      <p className="text-xs text-[var(--fg-muted)]">
        {last ? `Last activity ${relativeTime(last, now)}.` : 'No activity yet.'} Counts are from
        the mail and calendar Kraken has synced
        {items.threads.some((t) => t.member) || items.meetings.some((m) => m.fromMember)
          ? ", and members' own connected mailboxes"
          : ''}
        {items.hiddenCount ? `; ${items.hiddenCount} hidden by members` : ''}.
      </p>
      {primary ? (
        <p className="inline-flex flex-wrap items-center gap-1.5 text-xs text-[var(--fg-muted)]">
          <Mail className="size-3.5 text-[var(--accent)]" aria-hidden="true" />
          {spaceLabelsEnabled(primary) ? (
            <>
              In Gmail, its mail is filed under the label
              <a
                href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(primary.account_email ?? '')}#label/${encodeURIComponent(gmailLabel).replace(/%20/g, '+')}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-[#16a766] px-2 py-0.5 font-medium text-white hover:opacity-90"
              >
                {gmailLabel}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
              , kept up to date every half hour.
            </>
          ) : (
            <>
              To file this Space&apos;s mail under a Gmail label too, turn on sending for the main
              mailbox in Settings → Integrations.
            </>
          )}
        </p>
      ) : null}
      <section aria-labelledby="space-summary">
        <h2 id="space-summary" className="sr-only">
          Summary
        </h2>
        <SpaceAsk spaceId={access.space.id} mode="summary" />
      </section>
      <section aria-labelledby="space-recent">
        <h2 id="space-recent" className="font-serif text-base font-semibold">
          Recent activity
        </h2>
        {recent.length ? (
          <ul className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)]">
            {recent.map((r) => (
              <li key={`${r.kind}:${r.id}`} className="flex items-start gap-3 px-3 py-2.5">
                {r.kind === 'email' ? (
                  <Mail
                    className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                ) : r.kind === 'meeting' ? (
                  <CalendarDays
                    className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                ) : (
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.title}</p>
                  <p className="truncate text-xs text-[var(--fg-muted)]">
                    {r.kind === 'meeting' && r.upcoming ? 'Coming up · ' : null}
                    {formatDateTime(r.at, tz)} · {r.detail}
                  </p>
                </div>
                {r.kind === 'email' && r.member ? (
                  <ContributorThreadLinks
                    spaceId={access.space.id}
                    itemId={r.id}
                    threadId={r.member.threadId}
                    mailbox={r.member.mailbox}
                    label={`${r.title} (from ${whose(r.owner, team, auth)} mail)`}
                  />
                ) : r.kind === 'email' ? (
                  <ThreadLinks id={r.id} mailbox={null} label={r.title} variant="icons" />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing matches yet"
            description="No synced emails, meetings or notes match this Space's rules. Edit the Space to add a domain, an address or a keyword."
            className="mt-2"
          />
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- emails */

async function EmailsTab({ access, query }: { access: SpaceAccess; query: Params }) {
  const auth = await requireAuth();
  const store = getStore();
  const [page, team] = await Promise.all([
    spaceEmailPage(store, access, {
      pageToken: single(query.page) ?? null,
      mailbox: single(query.mailbox) ?? null,
    }),
    teamPeople(store, auth.organizationId),
  ]);
  const several = page.mailboxes.length > 1;
  const chipLabel = (m: SpaceEmailPageMailbox) =>
    m.key === 'all'
      ? 'All mailboxes'
      : m.key === 'primary'
        ? `Main mailbox (${m.label})`
        : `${whose(m.userId ?? '', team, auth).replace(/^your$/, 'Your')} mail`;
  const base = spaceTabHref(access.space.id, 'emails');
  const href = (extra: Record<string, string>) => {
    const qs = new URLSearchParams(extra);
    return `${base}${base.includes('?') ? '&' : '?'}${qs.toString()}`;
  };
  return (
    <div className="space-y-3" data-tour="space-emails">
      {page.mailboxes.length > 1 ? (
        <nav aria-label="Mailboxes" className="flex flex-wrap gap-2">
          {page.mailboxes.map((m) => (
            <Link
              key={m.key}
              href={m.key === page.mailboxes[0]!.key ? base : href({ mailbox: m.key })}
              aria-current={m.key === page.mailbox ? 'page' : undefined}
              className="rounded-full border border-[var(--border)] px-3 py-1 text-xs aria-[current=page]:border-[var(--accent)] aria-[current=page]:text-[var(--accent)]"
            >
              {chipLabel(m)}
            </Link>
          ))}
        </nav>
      ) : null}
      {page.state === 'no_rules' ? (
        <EmptyState
          title="No rules to search with"
          description="Edit the Space to add a domain, an address or a keyword."
        />
      ) : page.state === 'not_connected' ? (
        <Notice tone="warn">
          Gmail is not connected, so the Space&apos;s mail cannot be searched. Connect Google in
          Settings.
        </Notice>
      ) : page.state === 'error' ? (
        <ErrorState
          title="Gmail could not be searched just now"
          message={page.message ?? 'Try again in a minute.'}
          stillUsable="The Overview, Meeting log and Action items."
        />
      ) : page.rows.length ? (
        <>
          {page.unavailable.length ? (
            <Notice tone="warn">
              {page.unavailable.map((u) => whose(u, team, auth)).join(', ')} mailbox could not be
              read just now; the rest is here.
            </Notice>
          ) : null}
          <p className="text-xs text-[var(--fg-muted)]">
            {page.total !== null
              ? `About ${page.total.toLocaleString('en-US')} conversations in Gmail`
              : 'Conversations in Gmail'}
            {page.hidden ? ` · ${page.hidden} hidden on this page` : ''}. Nothing here changes your
            mail; the main mailbox only gets the Space&apos;s own Gmail label.
          </p>
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)]">
            {page.rows.map((row) => (
              <li key={row.itemId} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className={row.unread ? 'font-semibold' : 'font-medium'}>{row.who}</span>
                    {row.count && row.count > 1 ? (
                      <span className="text-[var(--fg-muted)]"> {row.count}</span>
                    ) : null}
                    <span className="text-[var(--fg-muted)]"> · {row.subject}</span>
                    {!row.primary ? (
                      <SourceTag text={`from ${whose(row.owner, team, auth)} mail`} />
                    ) : several ? (
                      <SourceTag text="main mailbox" />
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-[var(--fg-muted)]">
                    {row.at ? `${relativeTime(row.at)} · ` : null}
                    {row.snippet}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {row.primary ? (
                    <ThreadLinks
                      id={row.threadId}
                      mailbox={null}
                      label={row.subject}
                      variant="icons"
                    />
                  ) : (
                    <ContributorThreadLinks
                      spaceId={access.space.id}
                      itemId={row.itemId}
                      threadId={row.threadId}
                      mailbox={row.mailbox}
                      label={`${row.subject} (from ${whose(row.owner, team, auth)} mail)`}
                    />
                  )}
                  {canHide(access, auth, row.owner) ? (
                    <HideItemButton
                      spaceId={access.space.id}
                      kind="email"
                      id={row.itemId}
                      label={row.subject}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {page.morePrimary ? (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="secondary">
                <Link href={href({ page: page.morePrimary, mailbox: 'primary' })}>
                  More from the main mailbox
                </Link>
              </Button>
            </div>
          ) : null}
          {page.nextPageToken ? (
            <div className="flex justify-end">
              <Button asChild size="sm" variant="secondary">
                <Link
                  href={href({
                    page: page.nextPageToken,
                    ...(page.mailbox !== 'primary' ? { mailbox: page.mailbox } : {}),
                  })}
                >
                  Next page
                </Link>
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState
          title="No emails match"
          description="Gmail has no conversations from or to this Space's domains and addresses, or with its keywords."
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- meetings */

async function MeetingsTab({ access }: { access: SpaceAccess }) {
  const auth = await requireAuth();
  const store = getStore();
  const [items, team] = await Promise.all([
    spaceItems(store, access),
    teamPeople(store, auth.organizationId),
  ]);
  const tz = auth.profile.timezone;
  const upcoming = items.meetings.filter((m) => m.upcoming).reverse();
  const past = items.meetings.filter((m) => !m.upcoming).slice(0, 50);
  return (
    <div className="grid gap-5 lg:grid-cols-2" data-tour="space-meetings">
      <section aria-labelledby="space-meetings-heading" className="min-w-0">
        <h2 id="space-meetings-heading" className="font-serif text-base font-semibold">
          Calendar
        </h2>
        {upcoming.length + past.length ? (
          <ul className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)]">
            {[...upcoming, ...past].map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {m.title}
                    {m.fromMember ? (
                      <SourceTag text={`from ${whose(m.owner, team, auth)} calendar`} />
                    ) : null}
                  </p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {m.upcoming ? 'Coming up · ' : null}
                    {formatDateTime(m.at, tz)}
                    {m.people.length ? ` · ${m.people.join(', ')}` : ''}
                  </p>
                </div>
                {canHide(access, auth, m.owner) ? (
                  <HideItemButton
                    spaceId={access.space.id}
                    kind="meeting"
                    id={m.id}
                    label={m.title}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">No meetings match this Space.</p>
        )}
      </section>
      <section aria-labelledby="space-notes-heading" className="min-w-0">
        <h2 id="space-notes-heading" className="font-serif text-base font-semibold">
          Meeting notes
        </h2>
        {items.notes.length ? (
          <ul className="mt-2 space-y-2">
            {items.notes.slice(0, 50).map((n) => (
              <li
                key={n.id}
                className="rounded-[var(--radius-card)] border border-[var(--border)] px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {n.href ? (
                        <Link
                          href={n.href}
                          className="underline decoration-[color:var(--link-underline)]"
                        >
                          {n.title}
                        </Link>
                      ) : (
                        n.title
                      )}
                    </p>
                    <p className="text-xs text-[var(--fg-muted)]">
                      {formatDateTime(n.at, tz)} ·{' '}
                      {n.provider === 'copilot' ? 'Kraken note' : 'Granola note'}
                      {n.people.length ? ` · ${n.people.join(', ')}` : ''}
                    </p>
                  </div>
                  {canHide(access, auth, n.owner) ? (
                    <HideItemButton
                      spaceId={access.space.id}
                      kind="note"
                      id={n.id}
                      label={n.title}
                    />
                  ) : null}
                </div>
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-[var(--accent)]">
                    Show note
                  </summary>
                  <PlainText text={n.preview} className="mt-1.5 text-sm" />
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">No meeting notes match this Space.</p>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------- action items */

async function ItemsTab({ access }: { access: SpaceAccess }) {
  const auth = await requireAuth();
  const store = getStore();
  const [tasks, suggestions, team] = await Promise.all([
    spaceTasks(store, access),
    actionSuggestions(store, access),
    teamPeople(store, auth.organizationId),
  ]);
  const inSpace = new Set([
    access.space.created_by,
    ...access.members.filter((m) => m.status === 'accepted').map((m) => m.user_id),
  ]);
  const name = (id: string | null) =>
    id ? (team.find((p) => p.userId === id)?.name ?? null) : null;
  return (
    <div data-tour="space-items">
      <ActionItems
        spaceId={access.space.id}
        tasks={tasks.map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail,
          dueAt: t.dueAt,
          owner: name(t.assignedTo),
          done: t.status === 'complete',
          suggested: t.suggested,
        }))}
        suggestions={suggestions.map((s) => ({
          id: s.id,
          title: s.title,
          owner: s.owner,
          detail: s.detail,
        }))}
        people={team
          .filter((p) => inSpace.has(p.userId))
          .map((p) => ({ userId: p.userId, name: p.name }))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- ask */

function AskTab({ access }: { access: SpaceAccess }) {
  return (
    <div className="max-w-2xl space-y-3" data-tour="space-ask">
      <p className="text-sm text-[var(--fg-muted)]">
        Answers come only from this Space&apos;s emails and meeting notes, leaving out anything a
        member hid. Nothing is sent or changed.
      </p>
      <SpaceAsk spaceId={access.space.id} />
    </div>
  );
}

/* --------------------------------------------------------------- members */

async function MembersTab({ access }: { access: SpaceAccess }) {
  const auth = await requireAuth();
  const store = getStore();
  const [team, who] = await Promise.all([
    teamPeople(store, auth.organizationId),
    spaceContributors(store, access),
  ]);
  const byId = new Map(team.map((p) => [p.userId, p]));
  const rows: MemberRow[] = access.members
    .filter((m) => m.status !== 'left')
    .sort((x, y) => Number(y.role === 'owner') - Number(x.role === 'owner'))
    .map((m) => ({
      userId: m.user_id,
      name: byId.get(m.user_id)?.name ?? 'Former teammate',
      email: byId.get(m.user_id)?.email ?? null,
      role: m.role,
      status: m.status,
      // Only someone in the Space contributes anything.
      contribution:
        m.status === 'accepted' || m.role === 'owner'
          ? (who.status.get(m.user_id) ?? 'none')
          : null,
      isMe: m.user_id === auth.userId,
    }));
  const canConnect = !isDemoMode() && googleConfigured() && who.memberReady;
  const active = new Set(
    access.members
      .filter((m) => m.status === 'invited' || m.status === 'accepted')
      .map((m) => m.user_id),
  );
  active.add(access.space.created_by);
  const invitable = team
    .filter((p) => !active.has(p.userId))
    .map((p) => ({ userId: p.userId, name: p.name }));
  const mine = access.hidden.filter(
    (h) => h.user_id === auth.userId && h.item_kind !== 'suggestion',
  );
  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]" data-tour="space-members">
      <section aria-labelledby="space-members-heading" className="min-w-0">
        <h2 id="space-members-heading" className="sr-only">
          Members
        </h2>
        <MembersPanel
          spaceId={access.space.id}
          members={rows}
          invitable={invitable}
          canManage={access.canManage}
          canConnect={canConnect}
        />
      </section>
      <section aria-labelledby="space-privacy-heading" className="min-w-0 space-y-3">
        <h2 id="space-privacy-heading" className="font-serif text-base font-semibold">
          Who sees what
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">
          Only emails and meetings about the Space are shared, and only with people in it. Each
          person accepts before anything of theirs comes in. Anyone can hide their own emails and
          meetings, and removing someone takes their items out.
        </p>
        <p className="text-sm text-[var(--fg-muted)]">
          Connecting your own Google is read-only: Kraken reads only the mail and meetings matching
          the Spaces you accepted, shows them only to those Spaces&apos; members, and never puts
          them in the Inbox, Today, Tasks, Ask Arwin or search. Leave a Space or disconnect and they
          are gone at once.
        </p>
        {who.withoutMailbox.includes(auth.userId) ? (
          <Notice>
            <span className="block">
              Connect your Google to contribute your own emails and meetings. Until then you can see
              everything in the Space.
            </span>
            {canConnect ? (
              <span className="mt-2 block">
                <ConnectSpaceGoogle spaceId={access.space.id} />
              </span>
            ) : !who.memberReady && !isDemoMode() ? (
              <span className="mt-1 block text-xs">
                Contributing needs a database update first. Nothing else changes.
              </span>
            ) : null}
          </Notice>
        ) : null}
        <div>
          <h3 className="text-sm font-medium">Hidden by you</h3>
          {mine.length ? (
            <ul className="mt-1.5 space-y-1.5">
              {mine.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-[var(--fg-muted)]">
                    {h.item_kind === 'email'
                      ? 'Email'
                      : h.item_kind === 'meeting'
                        ? 'Meeting'
                        : 'Note'}
                    {h.item_id.startsWith('m.') ? " from a member's mailbox" : ''} ·{' '}
                    {relativeTime(h.created_at)}
                  </span>
                  <HideItemButton
                    spaceId={access.space.id}
                    kind={h.item_kind as 'email' | 'meeting' | 'note'}
                    id={h.item_id}
                    label={`${h.item_kind} hidden ${relativeTime(h.created_at)}`}
                    hidden
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-[var(--fg-muted)]">Nothing hidden.</p>
          )}
        </div>
      </section>
    </div>
  );
}
