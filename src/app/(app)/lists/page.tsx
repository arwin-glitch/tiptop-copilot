import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Upload } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  CRM_MIGRATION_FILE,
  isCrmNotSetUp,
  listActivity,
  listCrmLists,
  type CrmListSummary,
} from '@/lib/services/crm';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, SkeletonText } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import type { CrmEntityType } from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Lists' };
export const dynamic = 'force-dynamic';

/** Affinity's opportunity, organization and person lists, in the order a VC reaches for them. */
const GROUPS: { type: CrmEntityType; label: string }[] = [
  { type: 'deal', label: 'Deals' },
  { type: 'company', label: 'Companies' },
  { type: 'person', label: 'People' },
];

export default function ListsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Lists"
        subtitle="Every list carried over from Affinity, and the ones started here: deal pipelines, LP pipelines, the portfolio, partner lists."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/lists/import">
              <Upload aria-hidden="true" />
              Import from Affinity
            </Link>
          </Button>
        }
      />
      <Suspense fallback={<SkeletonText lines={8} />}>
        <ListsContent />
      </Suspense>
    </PageShell>
  );
}

async function ListsContent() {
  const auth = await requireAuth();
  const store = getStore();
  const result = await listCrmLists(store, auth.organizationId, { includeArchived: true });

  if (isCrmNotSetUp(result)) {
    return (
      <NotConfigured
        title="Lists are not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="Everything else in Copilot — deals, portfolio, inbox and the rest — works as before."
        action={null}
      />
    );
  }
  if (!result.ok) {
    return (
      <ErrorState
        title="Lists could not be loaded"
        message={result.error.message}
        stillUsable="Everything outside Lists."
      />
    );
  }

  const lists = result.value;
  if (lists.length === 0) {
    return (
      <EmptyState
        title="No lists yet"
        description="In Affinity, open a list and choose “Export view as CSV”, and “Export all notes in view” for its notes. Drop the files into the importer and the list comes across with its companies, people, fields and notes. Repeat for each list; importing a file again updates what is here instead of duplicating it."
        action={{ label: 'Import from Affinity', href: '/lists/import' }}
      />
    );
  }

  const activity = await listActivity(store, auth.organizationId, lists);
  const lastChanged = activity.ok ? activity.value : {};
  const live = lists.filter((l) => !l.archived);
  const archived = lists.filter((l) => l.archived);
  const now = new Date();

  return (
    <div className="space-y-8">
      {GROUPS.map((group) => {
        const inGroup = live.filter((l) => l.entity_type === group.type);
        if (inGroup.length === 0) return null;
        return (
          <section key={group.type} aria-labelledby={`lists-${group.type}`}>
            <SectionHeading count={inGroup.length}>
              <span id={`lists-${group.type}`}>{group.label}</span>
            </SectionHeading>
            <ListRows lists={inGroup} lastChanged={lastChanged} now={now} />
          </section>
        );
      })}

      {archived.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]">
            Archived lists <span className="tabular">({archived.length})</span>
          </summary>
          <div className="mt-3">
            <ListRows lists={archived} lastChanged={lastChanged} now={now} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ListRows({
  lists,
  lastChanged,
  now,
}: {
  lists: CrmListSummary[];
  lastChanged: Record<string, string>;
  now: Date;
}) {
  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
      {lists.map((list) => {
        const changed = lastChanged[list.id] ?? list.updated_at;
        const status = list.fields.find((f) => f.type === 'status');
        return (
          <li key={list.id}>
            <Link
              href={`/lists/${list.id}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-[var(--bg-hover)]"
            >
              <span className="min-w-0">
                <span className="font-serif text-base font-semibold">{list.name}</span>
                <span className="text-mini mt-0.5 block text-[var(--fg-subtle)]">
                  {[
                    `${list.fields.length} ${list.fields.length === 1 ? 'field' : 'fields'}`,
                    status?.options?.length
                      ? `${status.options.length} ${status.name.toLowerCase()} options`
                      : null,
                    `updated ${relativeTime(changed, now)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="outline">{list.source === 'affinity' ? 'Affinity' : 'Copilot'}</Badge>
                <span className="tabular text-sm text-[var(--fg-muted)]">
                  {list.entry_count.toLocaleString('en-US')}{' '}
                  {list.entry_count === 1 ? 'entry' : 'entries'}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
