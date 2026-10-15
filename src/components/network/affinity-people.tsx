import Link from 'next/link';
import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { NETWORK_TABS } from '@/lib/records-tabs';
import { CRM_MIGRATION_FILE, isCrmNotSetUp } from '@/lib/services/crm';
import { listCrmPeople } from '@/lib/services/crm-pages';
import type { CrmRecord } from '@/lib/types/domain';
import { PAGE_PARAM, pageNumber, pageWindow } from '@/lib/util/page-tabs';
import { LinkChips, pageHref } from '@/components/crm/link-chips';
import { SectionHeading } from '@/components/shell/page-header';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { Pager } from '@/components/ui/pager';

const PATH = NETWORK_TABS.path;
const DEFAULT_TAB = NETWORK_TABS.defaultKey;
/** People per page. */
const PER_PAGE = 50;
const AFFINITY_VIEW = { tab: 'people', source: 'affinity' } as const;

export type PeopleSource = 'mail' | 'affinity';

/** How many people the CRM holds (optionally matching `q`); null when it cannot say. */
export async function affinityPeopleCount(auth: AuthContext, q?: string): Promise<number | null> {
  const page = await listCrmPeople(getStore(), auth.organizationId, { query: q, limit: 1 });
  return page.ok ? page.value.total : null;
}

/**
 * The people directory's two sources, one click apart: everyone in the
 * mailbox and calendar (the default, as before) and the people carried over
 * from Affinity, labelled as such.
 */
export function PeopleSourceSwitch({
  source,
  q,
  mailCount,
  affinityCount,
}: {
  source: PeopleSource;
  q: string;
  mailCount: number | null;
  affinityCount: number | null;
}) {
  return (
    <LinkChips
      label="People source"
      className="mb-4"
      chips={[
        {
          key: 'mail',
          label: 'From mail and calendar',
          count: mailCount ?? undefined,
          href: pageHref(PATH, { tab: 'people', q: q || null }, DEFAULT_TAB),
          active: source === 'mail',
        },
        {
          key: 'affinity',
          label: 'From Affinity',
          count: affinityCount ?? undefined,
          href: pageHref(PATH, { ...AFFINITY_VIEW, q: q || null }, DEFAULT_TAB),
          active: source === 'affinity',
        },
      ]}
    />
  );
}

function titleOf(record: CrmRecord): string | null {
  for (const key of ['Job Title', 'Title', 'Role', 'Position']) {
    const v = record.fields[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function organizationOf(record: CrmRecord): string | null {
  for (const key of ['Organization', 'Organizations', 'Company', 'Current Organization']) {
    const v = record.fields[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) return v.join(', ');
  }
  return null;
}

/**
 * Network → People → From Affinity: every person record carried over from
 * Affinity, A to Z, searchable by name or email, 50 to a page with previous
 * and next, so everyone is reachable however many there are. Each opens
 * their profile: every list they are on, and every note.
 */
export async function AffinityPeople({
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
  let offset = (asked - 1) * PER_PAGE;
  let result = await listCrmPeople(store, auth.organizationId, {
    query: q,
    limit: PER_PAGE,
    offset,
  });
  // A page past the end (a stale link) shows the last one.
  if (result.ok && result.value.people.length === 0 && asked > 1 && result.value.total > 0) {
    offset = pageWindow(asked, PER_PAGE, result.value.total).offset;
    result = await listCrmPeople(store, auth.organizationId, { query: q, limit: PER_PAGE, offset });
  }
  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Affinity data is not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="The people from your mail and calendar are one click away."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title="Affinity's people could not be loaded"
        message={result.error.message}
        stillUsable="The people from your mail and calendar, and the other tabs."
      />
    );
  }
  const { people, total } = result.value;
  const paging = pageWindow(Math.floor(offset / PER_PAGE) + 1, PER_PAGE, total);
  return (
    <section aria-label="People from Affinity">
      <SectionHeading count={total}>People from Affinity</SectionHeading>
      <LiveSearch
        path={PATH}
        keep={AFFINITY_VIEW}
        reset={[PAGE_PARAM]}
        value={q}
        placeholder="Search name or email"
        label="Search Affinity people"
        className="mb-4 max-w-sm"
      />
      {people.length === 0 ? (
        <EmptyState
          title={q ? 'Nobody matches' : 'No people from Affinity yet'}
          description={
            q
              ? 'Clear the search, or try part of a name or address.'
              : 'People arrive with Affinity person lists and notes, imported on Knowledge.'
          }
          action={
            q
              ? { label: 'Clear search', href: pageHref(PATH, AFFINITY_VIEW, DEFAULT_TAB) }
              : { label: 'Open Affinity import', href: '/knowledge?tab=import' }
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">People from Affinity</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const title = titleOf(person);
                const org = organizationOf(person);
                return (
                  <tr key={person.id} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/lists/records/${person.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {person.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--fg-muted)]">
                      {person.primary_email ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--fg-muted)]">
                      {[title, org].filter(Boolean).join(', ') || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label="People from Affinity: pages"
        page={paging.page}
        pages={paging.pages}
        total={total}
        shown={people.length}
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
