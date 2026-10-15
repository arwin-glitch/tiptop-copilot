import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { readFollowUps, readFollowUpsWithin } from '@/lib/services/follow-ups';
import {
  WeekAheadCard,
  snapshotUnavailable,
  upcomingWeekEvents,
} from '@/components/followups/relay-cards';
import { listMeetingNotes } from '@/lib/services/meetings';
import { MEETINGS_TABS, SNAPSHOT_WAIT_MS, landsOnSnapshot, openingTab } from '@/lib/records-tabs';
import {
  PAGE_PARAM,
  SHOW_PARAM,
  showMoreHref,
  shownCount,
  single,
  tabHref,
} from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { PageTabs } from '@/components/ui/page-tabs';
import { ShowMore } from '@/components/ui/show-more';
import { Stat, StatGroup } from '@/components/ui/stat';
import { MeetingNoteList } from '@/components/meetings/meeting-note-list';
import { MeetingsFilterBar } from '@/components/meetings/meetings-client';
import {
  AffinityNotes,
  NotesSourceSwitch,
  affinityNoteCount,
  type NotesSource,
} from '@/components/meetings/affinity-notes';

export const metadata: Metadata = { title: 'Meetings' };
export const dynamic = 'force-dynamic';

const NOTES_HREF = tabHref(MEETINGS_TABS.path, 'notes', MEETINGS_TABS.defaultKey);

/** Notes rendered per page. Each card carries its full note, so not all 500. */
const NOTES_STEP = 25;
/** The most notes one read returns (listMeetingNotes' cap). */
const NOTES_MAX = 500;

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';

  // The week ahead is only the routine's snapshot from Slack, and a weekly
  // one runs out by the weekend. A bare URL opens there while a meeting is
  // still to come and on Notes otherwise, never on an empty page.
  let weekShows = false;
  if (landsOnSnapshot(MEETINGS_TABS, params)) {
    const auth = await requireAuth();
    const now = new Date();
    const landing = await readFollowUpsWithin(getStore(), auth.organizationId, SNAPSHOT_WAIT_MS, {
      now,
    });
    const week = landing?.state === 'ok' ? landing.snapshot.weekAhead : null;
    weekShows = week ? upcomingWeekEvents(week, now).length > 0 : false;
  }
  const { tab, home } = openingTab(MEETINGS_TABS, params, weekShows);
  const shown = shownCount(params[SHOW_PARAM], NOTES_STEP, NOTES_MAX);
  const source: NotesSource = single(params.source) === 'affinity' ? 'affinity' : 'granola';

  return (
    <PageShell>
      <PageHeader
        title="Meetings"
        subtitle="Every note Granola has written, whether or not the company is already a deal, and every note carried over from Affinity. The record of what was actually said."
      />
      <PageTabs
        label={MEETINGS_TABS.navLabel}
        path={MEETINGS_TABS.path}
        tabs={MEETINGS_TABS.tabs.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        defaultKey={home}
      />
      <Suspense key={tab} fallback={<SkeletonText lines={10} />}>
        {tab === 'notes' ? (
          source === 'affinity' ? (
            <AffinityNotesTab q={q} page={params[PAGE_PARAM]} />
          ) : (
            <NotesTab q={q} shown={shown} />
          )
        ) : (
          <WeekTab />
        )}
      </Suspense>
    </PageShell>
  );
}

/** The week-ahead routine's snapshot: what is still to come, by day. */
async function WeekTab() {
  const auth = await requireAuth();
  const followUps = await readFollowUps(getStore(), auth.organizationId).catch(() => null);
  const empty = (title: string, description: string) => (
    <EmptyState
      title={title}
      description={description}
      action={{ label: 'See all notes', href: NOTES_HREF }}
    />
  );
  if (followUps?.state !== 'ok') {
    return empty('No week ahead to show', snapshotUnavailable(followUps?.state));
  }
  const week = followUps.snapshot.weekAhead;
  if (!week) {
    return empty('No week ahead to show', 'Shows here once the week-ahead routine has posted.');
  }
  return (
    <WeekAheadCard
      week={week}
      now={new Date()}
      tz={auth.profile.timezone}
      empty={empty('Nothing coming up', 'No meeting is left on the week ahead.')}
    />
  );
}

/** Affinity's notes, newest first, behind the same tab as Granola's. */
async function AffinityNotesTab({ q, page }: { q: string; page: string | string[] | undefined }) {
  const auth = await requireAuth();
  const [granolaCount, affinityCount] = await Promise.all([
    getStore()
      .count('meeting_notes', auth.organizationId, { eq: { provider: 'granola' } })
      .catch(() => null),
    affinityNoteCount(auth),
  ]);
  return (
    <>
      <NotesSourceSwitch
        source="affinity"
        q={q}
        granolaCount={granolaCount}
        affinityCount={affinityCount}
      />
      <AffinityNotes auth={auth} q={q} page={page} />
    </>
  );
}

async function NotesTab({ q, shown }: { q: string; shown: number }) {
  const auth = await requireAuth();
  // `notes` is one page, capped by listMeetingNotes. Reading its length as the
  // meeting count showed a flat "500" — the cap, presented as a fact — while
  // the real figure was 922. A stat that reports a limit is worse than no stat.
  const [notes, total] = await Promise.all([
    listMeetingNotes(getStore(), auth.organizationId, {
      search: q || undefined,
      limit: NOTES_MAX,
    }),
    getStore().count('meeting_notes', auth.organizationId, { eq: { provider: 'granola' } }),
  ]);
  const affinityCount = await affinityNoteCount(auth);

  const people = new Set<string>();
  const companies = new Set<string>();
  for (const note of notes) {
    for (const attendee of note.attendees) {
      const email = attendee.email.toLowerCase();
      people.add(email);
      const at = email.lastIndexOf('@');
      if (at > 0) companies.add(email.slice(at + 1));
    }
  }

  return (
    <>
      <NotesSourceSwitch
        source="granola"
        q={q}
        granolaCount={total}
        affinityCount={affinityCount}
      />
      <StatGroup className="mb-5" columns={3}>
        <Stat
          size="sm"
          label="Meetings"
          value={q ? notes.length : total}
          hint={q ? `matching, of ${total}` : 'notes from Granola'}
        />
        <Stat size="sm" label="People" value={people.size} hint="across every meeting" />
        <Stat size="sm" label="Organisations" value={companies.size} hint="by email domain" />
      </StatGroup>

      <MeetingsFilterBar q={q} />

      <div className="mt-4">
        {notes.length === 0 ? (
          <EmptyState
            title={q ? 'No meeting matches' : 'No meeting notes yet'}
            description={
              q
                ? 'Clear the search, or try part of a title, a name or an address.'
                : 'Notes arrive automatically once Granola is connected. Diagnostics shows whether it is, and the backlog can be imported in one pass.'
            }
            action={{
              label: q ? 'Clear search' : 'Check Diagnostics',
              href: q ? NOTES_HREF : '/diagnostics',
            }}
          />
        ) : (
          <>
            {/* The stats above count every note read; only a page of cards is
                rendered, newest first, and grows on request. */}
            <MeetingNoteList notes={notes.slice(0, shown)} timezone={auth.profile.timezone} />
            <ShowMore
              shown={shown}
              total={notes.length}
              step={NOTES_STEP}
              href={showMoreHref(MEETINGS_TABS.path, { tab: 'notes', q }, shown, NOTES_STEP)}
              note={
                !q && total > notes.length
                  ? `The newest ${notes.length} of ${total} are listed. Search to reach older notes.`
                  : undefined
              }
            />
          </>
        )}
      </div>
    </>
  );
}
