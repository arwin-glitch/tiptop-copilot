import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { hasRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { CRM_DESTINATION_INFO, groupByPage, type CrmDestinationPage } from '@/lib/crm/destinations';
import { AFFINITY_IMPORT_HREF } from '@/lib/records-tabs';
import { CRM_MIGRATION_FILE, isCrmNotSetUp, listActivity } from '@/lib/services/crm';
import { listsWithDestinations, type CrmDestinationList } from '@/lib/services/crm-destinations';
import type { CrmEntityType } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';
import { SectionHeading } from '@/components/shell/page-header';
import { EmptyState, ErrorState } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { NotConfigured } from '@/components/ui/not-configured';
import { DestinationSelect } from '@/components/lists/destination-select';

const KIND: Record<CrmEntityType, string> = {
  deal: 'Deal list',
  company: 'Company list',
  person: 'Person list',
};

/** The filter box stays on this tab. */
const LISTS_KEEP = { tab: 'lists' } as const;

/**
 * Knowledge → Affinity lists: every list carried over from Affinity, grouped
 * by the page its rows feed (Deals, Fund II, Portfolio, Network), so it reads
 * as "what went where" rather than a second CRM to browse. Condensed for a
 * reader who scans: one short card per list, two to a row on a wide screen,
 * and the menu on each card both says what the list is and moves it.
 */
export async function AffinityLists({ auth, q }: { auth: AuthContext; q: string }) {
  const store = getStore();
  const result = await listsWithDestinations(store, auth.organizationId, {
    includeArchived: true,
  });

  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Affinity lists are not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="Documents, contacts and everything else in Copilot work as before."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title="The Affinity lists could not be loaded"
        message={result.error.message}
        stillUsable="Documents, contacts and everything outside the Affinity lists."
      />
    );
  }

  const all = result.value;
  if (all.length === 0) {
    return (
      <EmptyState
        title="Nothing imported from Affinity yet"
        description="In Affinity, open a list and choose “Export view as CSV”, and “Export all notes in view” for its notes. Drop the files on Affinity import and each list lands on the page that uses it."
        action={{ label: 'Open Affinity import', href: AFFINITY_IMPORT_HREF }}
      />
    );
  }

  const needle = q.trim().toLowerCase();
  const matching = needle ? all.filter((l) => l.name.toLowerCase().includes(needle)) : all;
  const live = matching.filter((l) => !l.archived);
  const archived = matching.filter((l) => l.archived);
  const activity = await listActivity(store, auth.organizationId, matching);
  const lastChanged = activity.ok ? activity.value : {};
  const canWrite = hasRole(auth, 'member');
  const now = new Date();
  const pages = groupByPage(live, (l) => l.destination.destination);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The groups at a glance, each a jump to its section. */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--fg-muted)]">
          <span>
            {all.length.toLocaleString('en-US')} {all.length === 1 ? 'list' : 'lists'} from
            Affinity:
          </span>
          {pages.map((page) => (
            <a
              key={page.page}
              href={`#affinity-${slug(page.page)}`}
              className="whitespace-nowrap underline-offset-2 hover:text-[var(--fg)] hover:underline"
            >
              {page.heading}{' '}
              <span className="tabular text-[var(--fg-subtle)]">{page.items.length}</span>
            </a>
          ))}
        </p>
        <LiveSearch
          path="/knowledge"
          keep={LISTS_KEEP}
          value={q}
          placeholder="Filter by list name"
          label="Filter Affinity lists"
          className="w-full max-w-xs"
        />
      </div>

      {matching.length === 0 ? (
        <EmptyState
          title="No list matches"
          description="Clear the filter, or try part of a list's name."
          action={{ label: 'Clear filter', href: '/knowledge?tab=lists' }}
        />
      ) : null}

      {pages.map((page) => {
        const id = `affinity-${slug(page.page)}`;
        return (
          <section key={page.page} aria-labelledby={id} className="scroll-mt-28">
            <SectionHeading count={page.items.length} action={<FeedsLink page={page} />}>
              <span id={id}>{page.heading}</span>
            </SectionHeading>
            <ListCards lists={page.items} lastChanged={lastChanged} now={now} canWrite={canWrite} />
          </section>
        );
      })}

      {archived.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]">
            Archived lists <span className="tabular">({archived.length})</span>
          </summary>
          <div className="mt-3">
            <ListCards lists={archived} lastChanged={lastChanged} now={now} canWrite={canWrite} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Where a group's rows show up, as a link to that page. */
function FeedsLink({ page }: { page: CrmDestinationPage }) {
  if (page.destinations.includes('archive')) {
    return <span className="text-xs text-[var(--fg-subtle)]">Feeds no other page</span>;
  }
  return (
    <Link
      href={page.href}
      className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-[var(--accent)] underline-offset-2 hover:underline"
    >
      Open {page.page}
      <ArrowUpRight className="size-3" aria-hidden="true" />
    </Link>
  );
}

function ListCards({
  lists,
  lastChanged,
  now,
  canWrite,
}: {
  lists: CrmDestinationList[];
  lastChanged: Record<string, string>;
  now: Date;
  canWrite: boolean;
}) {
  return (
    <ul className="grid gap-2 xl:grid-cols-2">
      {lists.map((list) => {
        const { destination } = list;
        const changed = lastChanged[list.id] ?? list.updated_at;
        return (
          <li
            key={list.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-3.5 py-2.5 transition-colors hover:border-[var(--border-strong)]"
          >
            <Link href={`/lists/${list.id}`} className="group min-w-0 flex-1 basis-44">
              <span className="font-serif font-semibold group-hover:underline">{list.name}</span>
              <span className="text-mini mt-0.5 block text-[var(--fg-subtle)]">
                {[
                  KIND[list.entity_type],
                  `${list.entry_count.toLocaleString('en-US')} ${list.entry_count === 1 ? 'entry' : 'entries'}`,
                  `updated ${relativeTime(changed, now)}`,
                  destination.source === 'override' ? 'moved by hand' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </Link>
            {canWrite ? (
              <DestinationSelect
                key={`${destination.source}:${destination.destination}`}
                listId={list.id}
                listName={list.name}
                chosen={destination.source === 'override' ? destination.destination : null}
                auto={destination.auto}
                className="max-w-[15rem]"
              />
            ) : (
              <span className="text-xs text-[var(--fg-muted)]">
                {CRM_DESTINATION_INFO[destination.destination].label}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
