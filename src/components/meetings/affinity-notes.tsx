import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { MEETINGS_TABS } from '@/lib/records-tabs';
import { CRM_MIGRATION_FILE, isCrmNotSetUp } from '@/lib/services/crm';
import { listAffinityNotes } from '@/lib/services/crm-pages';
import { PAGE_PARAM, pageNumber, pageWindow } from '@/lib/util/page-tabs';
import { LinkChips, pageHref } from '@/components/crm/link-chips';
import { CrmNoteList } from '@/components/lists/crm-note-list';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { Pager } from '@/components/ui/pager';

const PATH = MEETINGS_TABS.path;
const DEFAULT_TAB = MEETINGS_TABS.defaultKey;
/** Notes per page: each carries its text, so a page at a time. */
export const AFFINITY_NOTES_PER_PAGE = 25;
const AFFINITY_VIEW = { tab: 'notes', source: 'affinity' } as const;

export type NotesSource = 'granola' | 'affinity';

/** How many notes came across from Affinity; null when the CRM cannot say. */
export async function affinityNoteCount(auth: AuthContext): Promise<number | null> {
  const page = await listAffinityNotes(getStore(), auth.organizationId, { limit: 1 });
  return page.ok ? page.value.total : null;
}

/** The notes' two sources, one click apart: Granola (as before) and Affinity. */
export function NotesSourceSwitch({
  source,
  q,
  granolaCount,
  affinityCount,
}: {
  source: NotesSource;
  q: string;
  granolaCount: number | null;
  affinityCount: number | null;
}) {
  return (
    <LinkChips
      label="Notes source"
      className="mb-4"
      chips={[
        {
          key: 'granola',
          label: 'Granola',
          count: granolaCount ?? undefined,
          href: pageHref(PATH, { tab: 'notes', q: q || null }, DEFAULT_TAB),
          active: source === 'granola',
        },
        {
          key: 'affinity',
          label: 'Affinity',
          count: affinityCount ?? undefined,
          href: pageHref(PATH, { ...AFFINITY_VIEW, q: q || null }, DEFAULT_TAB),
          active: source === 'affinity',
        },
      ]}
    />
  );
}

/**
 * Meetings → Notes → Affinity: every note carried over from Affinity, newest
 * first (an undated one last), 25 to a page with previous and next, so the
 * oldest is as reachable as the newest; searchable by title, text or author.
 * Each says who it is about, linked to their profile. Rendered as text and
 * flagged when it carries instruction-shaped text, like every imported note.
 */
export async function AffinityNotes({
  auth,
  q,
  page,
}: {
  auth: AuthContext;
  q: string;
  page: string | string[] | undefined;
}) {
  const store = getStore();
  const asked = pageNumber(page);
  let offset = (asked - 1) * AFFINITY_NOTES_PER_PAGE;
  let result = await listAffinityNotes(store, auth.organizationId, {
    query: q,
    limit: AFFINITY_NOTES_PER_PAGE,
    offset,
  });
  // A page past the end (a stale link) shows the last one.
  if (result.ok && result.value.notes.length === 0 && asked > 1 && result.value.total > 0) {
    offset = pageWindow(asked, AFFINITY_NOTES_PER_PAGE, result.value.total).offset;
    result = await listAffinityNotes(store, auth.organizationId, {
      query: q,
      limit: AFFINITY_NOTES_PER_PAGE,
      offset,
    });
  }
  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Affinity notes are not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="Granola's notes are one click away."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title="Affinity's notes could not be loaded"
        message={result.error.message}
        stillUsable="Granola's notes, and the week ahead."
      />
    );
  }
  const { notes, total, about } = result.value;
  const paging = pageWindow(
    Math.floor(offset / AFFINITY_NOTES_PER_PAGE) + 1,
    AFFINITY_NOTES_PER_PAGE,
    total,
  );
  return (
    <section aria-label="Affinity notes">
      <LiveSearch
        path={PATH}
        keep={AFFINITY_VIEW}
        reset={[PAGE_PARAM]}
        value={q}
        placeholder="Search Affinity notes"
        label="Search Affinity notes"
        className="mb-4 max-w-sm"
      />
      {notes.length === 0 ? (
        <EmptyState
          title={q ? 'No note matches' : 'No notes from Affinity yet'}
          description={
            q
              ? 'Clear the search, or try part of a title, a name or what was said.'
              : 'Notes arrive with an Affinity notes export ("Export all notes in view"), imported on Knowledge.'
          }
          action={
            q
              ? { label: 'Clear search', href: pageHref(PATH, AFFINITY_VIEW, DEFAULT_TAB) }
              : { label: 'Open Affinity import', href: '/knowledge?tab=import' }
          }
        />
      ) : (
        <CrmNoteList
          notes={notes}
          timezone={auth.profile.timezone}
          about={about}
          label="Affinity notes"
        />
      )}
      <Pager
        label="Affinity notes: pages"
        page={paging.page}
        pages={paging.pages}
        total={total}
        shown={notes.length}
        offset={offset}
        hrefFor={(n) =>
          pageHref(
            PATH,
            { ...AFFINITY_VIEW, q: q || null, [PAGE_PARAM]: n > 1 ? String(n) : null },
            DEFAULT_TAB,
          )
        }
      />
    </section>
  );
}
