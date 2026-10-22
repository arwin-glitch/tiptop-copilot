import Link from 'next/link';
import { Lock, Plus, Settings2 } from 'lucide-react';
import type { AuthContext } from '@/lib/auth/session';
import { formatOffset, meetingPagePath } from '@/lib/notes/api';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { getStore } from '@/lib/runtime';
import { listFolders } from '@/lib/services/notes';
import { listMeetings } from '@/lib/services/notes-search';
import type { ListMeetingsQuery, MeetingListItem, NotesSearchHit } from '@/lib/types/notes';
import { formatDate } from '@/lib/util/time';
import { LinkChips, pageHref } from '@/components/crm/link-chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { domainOf, lengthWords, statusWords } from '@/components/notes/helpers';

const PATH = MEETINGS_TABS.path;
const DEFAULT_TAB = MEETINGS_TABS.defaultKey;
const CHIPS = 6;

export type CopilotNotesSource = 'copilot' | 'all';

export interface CopilotNotesFilters {
  q: string;
  person: string | null;
  company: string | null;
  folder: string | null;
  actions: boolean;
  cursor: string | null;
}

function href(
  source: CopilotNotesSource,
  filters: CopilotNotesFilters,
  change: Partial<Record<keyof CopilotNotesFilters, string | null>>,
): string {
  const next = { ...filters, ...change };
  return pageHref(
    PATH,
    {
      tab: 'notes',
      source,
      q: next.q || null,
      person: next.person,
      company: next.company,
      folder: next.folder,
      actions: next.actions ? 'true' : null,
      cursor: 'cursor' in change ? (change.cursor ?? null) : null,
    },
    DEFAULT_TAB,
  );
}

function rowHref(item: MeetingListItem): string {
  return item.meetingId
    ? meetingPagePath(item.meetingId)
    : pageHref(PATH, { tab: 'notes', q: item.title }, DEFAULT_TAB);
}

/** The most frequent values first, ties by name. */
function top(values: string[], n: number): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, n);
}

/**
 * Meetings → Notes → Copilot / All (D-076): Copilot's own notes and, under
 * All, Granola's beside them, each with its source, newest first. Filters by
 * person, company, folder and "Has action items"; the search reads titles,
 * notes and transcripts, and a transcript hit opens the meeting at that
 * moment. During the parallel run a Copilot meeting paired with a Granola note
 * of the same call shows once.
 */
export async function CopilotNotes({
  auth,
  source,
  filters,
}: {
  auth: AuthContext;
  source: CopilotNotesSource;
  filters: CopilotNotesFilters;
}) {
  const store = getStore();
  const ctx = { store, auth };
  const query: ListMeetingsQuery = {
    q: filters.q || undefined,
    person: filters.person ?? undefined,
    company: filters.company ?? undefined,
    folder: filters.folder ?? undefined,
    source,
    hasActionItems: filters.actions ? true : undefined,
    cursor: filters.cursor ?? undefined,
  };
  const [listed, folders] = await Promise.all([listMeetings(ctx, query), listFolders(ctx)]);

  if (!listed.ok) {
    return listed.error.code === 'not_configured' ? (
      <NotConfigured
        title="Copilot Notes is not set up yet"
        description={listed.error.message}
        stillWorks={listed.error.stillUsable}
        action={null}
      />
    ) : (
      <ErrorState
        title="Notes could not be loaded"
        message={listed.error.message}
        stillUsable="Granola's notes, one click away."
      />
    );
  }

  const { meetings, hits, nextCursor } = listed.value;
  const people = top(
    meetings.flatMap((m) => m.attendees.map((a) => a.email.toLowerCase())),
    CHIPS,
  ).filter((p) => p.value !== auth.profile.email?.toLowerCase());
  const companies = top(
    meetings.flatMap((m) =>
      m.attendees.map((a) => domainOf(a.email)).filter((d): d is string => Boolean(d)),
    ),
    CHIPS,
  ).filter((c) => c.value !== domainOf(auth.profile.email));
  const nameOf = new Map(
    meetings.flatMap((m) => m.attendees.map((a) => [a.email.toLowerCase(), a.name ?? a.email])),
  );
  const folderList = folders.ok ? folders.value : [];
  const filtered = Boolean(
    filters.q || filters.person || filters.company || filters.folder || filters.actions,
  );

  return (
    <section aria-label={source === 'copilot' ? 'Copilot notes' : 'All notes'}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LiveSearch
          path={PATH}
          keep={{ tab: 'notes', source }}
          reset={['cursor']}
          value={filters.q}
          placeholder="Search titles, notes and transcripts"
          label="Search meetings"
          className="w-full max-w-sm"
        />
      </div>

      <div className="mb-4 space-y-2">
        {people.length > 0 || filters.person ? (
          <LinkChips
            label="Filter by person"
            chips={(filters.person && !people.some((p) => p.value === filters.person)
              ? [{ value: filters.person, count: 0 }]
              : people
            ).map((p) => ({
              key: p.value,
              label: nameOf.get(p.value) ?? p.value,
              href: href(source, filters, { person: filters.person === p.value ? null : p.value }),
              active: filters.person === p.value,
            }))}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {companies.length > 0 || filters.company ? (
            <LinkChips
              label="Filter by company"
              chips={(filters.company && !companies.some((c) => c.value === filters.company)
                ? [{ value: filters.company, count: 0 }]
                : companies
              ).map((c) => ({
                key: c.value,
                label: c.value,
                href: href(source, filters, {
                  company: filters.company === c.value ? null : c.value,
                }),
                active: filters.company === c.value,
              }))}
            />
          ) : null}
          {folderList.length > 0 ? (
            <LinkChips
              label="Filter by folder"
              chips={folderList.map((f) => ({
                key: f.id,
                label: f.isPrivate ? `${f.name} (private)` : f.name,
                count: f.meetingCount,
                href: href(source, filters, { folder: filters.folder === f.id ? null : f.id }),
                active: filters.folder === f.id,
              }))}
            />
          ) : null}
          <LinkChips
            label="Action items"
            chips={[
              {
                key: 'actions',
                label: 'Has action items',
                href: href(source, filters, { actions: filters.actions ? null : 'true' }),
                active: filters.actions,
              },
            ]}
          />
        </div>
      </div>

      {filters.q && hits.length > 0 ? (
        <SearchHits hits={hits} timeZone={auth.profile.timezone} />
      ) : null}

      {meetings.length === 0 ? (
        <EmptyState
          title={filtered ? 'No meeting matches' : 'No Copilot notes yet'}
          description={
            filtered
              ? 'Clear a filter, or search for part of a title, a name or something that was said.'
              : 'Open a meeting on the Calendar and press Take notes, or start a note for a call that is not on it.'
          }
          action={
            filtered
              ? {
                  label: 'Clear filters',
                  href: href(
                    source,
                    { ...filters, q: '' },
                    { person: null, company: null, folder: null, actions: null },
                  ),
                }
              : { label: 'New note', href: '/meetings/new' }
          }
        />
      ) : (
        <ul className="space-y-2" aria-label="Meetings">
          {meetings.map((m) => (
            <MeetingRow key={m.qualifiedId} item={m} timeZone={auth.profile.timezone} />
          ))}
        </ul>
      )}

      {nextCursor || filters.cursor ? (
        <nav aria-label="More notes" className="mt-4 flex gap-2">
          {filters.cursor ? (
            <Button asChild size="sm" variant="ghost">
              <Link href={href(source, filters, { cursor: null })}>Newest</Link>
            </Button>
          ) : null}
          {nextCursor ? (
            <Button asChild size="sm" variant="secondary">
              <Link href={href(source, filters, { cursor: nextCursor })}>Older notes</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}

function SearchHits({ hits, timeZone }: { hits: NotesSearchHit[]; timeZone: string }) {
  return (
    <section aria-label="Where it was said" className="mb-5">
      <h2 className="text-micro mb-2 font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
        Found in
      </h2>
      <ol className="space-y-1.5" data-search-hits="">
        {hits.slice(0, 12).map((h, i) => {
          const target =
            h.meetingId && h.field === 'transcript'
              ? meetingPagePath(h.meetingId, h.startMs)
              : h.meetingId
                ? meetingPagePath(h.meetingId)
                : pageHref(PATH, { tab: 'notes', q: h.title }, DEFAULT_TAB);
          return (
            <li key={`${h.qualifiedId}-${h.field}-${h.seq ?? i}`}>
              <Link
                href={target}
                className="block rounded-md border border-[var(--border)] px-3 py-2 hover:border-[var(--gold)] hover:bg-[var(--bg-hover)]"
                data-search-hit={h.field}
              >
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{h.title}</span>
                  <Badge tone="outline">
                    {h.field === 'transcript'
                      ? `Transcript ${h.startMs !== null ? formatOffset(h.startMs) : ''}`.trim()
                      : h.field === 'notes'
                        ? 'Notes'
                        : 'Title'}
                  </Badge>
                  <span className="text-xs text-[var(--fg-subtle)]">
                    {formatDate(h.occurredAt, timeZone)}
                  </span>
                </span>
                {h.field !== 'title' ? (
                  <span className="mt-0.5 block text-sm text-[var(--fg-muted)]">{h.snippet}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function MeetingRow({ item, timeZone }: { item: MeetingListItem; timeZone: string }) {
  const length = lengthWords(item.recordedMs);
  return (
    <li className="rounded-md border border-[var(--border)] p-3" data-note-source={item.source}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={rowHref(item)} className="text-sm font-medium hover:underline">
          {item.title}
        </Link>
        <span className="text-mini shrink-0 text-[var(--fg-subtle)]">
          {formatDate(item.occurredAt, timeZone)}
        </span>
      </div>
      <p className="text-mini mt-1 flex flex-wrap items-center gap-1.5 text-[var(--fg-subtle)]">
        <Badge tone={item.source === 'copilot' ? 'accent' : 'neutral'}>
          {item.source === 'copilot' ? 'Copilot' : 'Granola'}
        </Badge>
        {item.source === 'copilot' ? <span>{statusWords(item.status)}</span> : null}
        {length ? <span>· {length}</span> : null}
        {item.hasActionItems ? <span>· Action items</span> : null}
        {item.visibility === 'private' ? (
          <span className="inline-flex items-center gap-0.5">
            · <Lock className="size-3" aria-hidden /> Private
          </span>
        ) : null}
        {item.pairedWith ? <span>· Also in Granola</span> : null}
      </p>
      {item.attendees.length > 0 ? (
        <p className="text-mini mt-0.5 text-[var(--fg-muted)]">
          {item.attendees.map((a) => a.name ?? a.email).join(', ')}
        </p>
      ) : null}
    </li>
  );
}

/** The two buttons beside the source chips while Copilot Notes is on. */
export function NotesActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild size="sm" variant="primary">
        <Link href="/meetings/new">
          <Plus aria-hidden /> New note
        </Link>
      </Button>
      <Button asChild size="sm" variant="ghost">
        <Link href="/meetings/settings">
          <Settings2 aria-hidden /> Notes settings
        </Link>
      </Button>
    </div>
  );
}
