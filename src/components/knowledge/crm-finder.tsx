import Link from 'next/link';
import { hasRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { describeFinder, parseFinderParams } from '@/lib/crm/finder';
import { formatSmartValue } from '@/lib/network/strength';
import { CRM_MIGRATION_FILE, isCrmNotSetUp, listCrmLists } from '@/lib/services/crm';
import { CRM_FINDER_SCAN_MAX, CRM_FINDER_SHOW, findCrmRecords } from '@/lib/services/crm-finder';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { relationshipScope } from '@/lib/services/relationships';
import { SectionHeading } from '@/components/shell/page-header';
import { EmptyState, ErrorState, Notice } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { NewRecordDialog } from '@/components/lists/record-dialogs';
import {
  FinderActions,
  FinderForm,
  type FinderListOption,
} from '@/components/knowledge/crm-finder-client';

type Params = Record<string, string | string[] | undefined>;

/**
 * Knowledge → Find & save: every company and person in the CRM by name,
 * place and how recently you were in touch — "people in Austin I talked to
 * in the last three years" — then saved as a list (for a campaign, say) or
 * added to one. New companies and people are added here too.
 *
 * The criteria are the URL (lib/crm/finder.ts) and the search runs on the
 * server across the whole CRM (lib/services/crm-finder.ts); the page shows
 * the first matches and saving takes every one.
 */
export async function CrmFinderTab({ auth, params }: { auth: AuthContext; params: Params }) {
  const criteria = parseFinderParams(params);
  const store = getStore();
  const canWrite = hasRole(auth, 'member');
  const [lists, integration] = await Promise.all([
    listCrmLists(store, auth.organizationId),
    getPrimaryIntegration(store, auth.organizationId).catch(() => null),
  ]);
  if (isCrmNotSetUp(lists)) {
    return (
      <NotConfigured
        title="The CRM is not set up yet"
        description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
        stillWorks="Documents, contacts and everything else in Kraken work as before."
        action={null}
      />
    );
  }
  const options: FinderListOption[] = lists.ok
    ? lists.value.map((l) => ({ id: l.id, name: l.name, entityType: l.entity_type }))
    : [];
  const found = await findCrmRecords(store, auth.organizationId, criteria, {
    scope: relationshipScope(auth.profile.email, integration),
  });
  const timezone = auth.profile.timezone;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-[var(--fg-muted)]">
          Find people and companies across the whole CRM by name, place and last contact, then save
          them as a list for a campaign or add them to one.
        </p>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <NewRecordDialog kind="person" />
            <NewRecordDialog kind="company" />
          </div>
        ) : null}
      </div>

      <FinderForm
        // A new search starts the form from what the URL now says.
        key={JSON.stringify(criteria)}
        criteria={criteria}
        lists={options}
      />

      {!found.ok ? (
        found.error.code === 'not_found' ? (
          <EmptyState
            title="That list is gone"
            description="It was archived or removed. Search without it."
          />
        ) : (
          <ErrorState
            title="The search could not run"
            message={found.error.message}
            stillUsable="The Affinity lists and everything else in Kraken."
          />
        )
      ) : found.value.needsNarrowing ? (
        <EmptyState
          title="Search by a name, a place or a list"
          description="Type part of a name, a city (Austin), or pick a list, and add how recently you were in touch if it matters."
        />
      ) : (
        <section aria-labelledby="finder-results">
          <SectionHeading
            count={found.value.total}
            action={
              canWrite && found.value.total > 0 ? (
                <FinderActions
                  criteria={criteria}
                  total={found.value.total}
                  suggestedName={describeFinder(criteria, found.value.list?.name)}
                />
              ) : null
            }
          >
            <span id="finder-results">{describeFinder(criteria, found.value.list?.name)}</span>
          </SectionHeading>
          {found.value.truncated ? (
            <Notice className="mb-3">
              The search read the first {CRM_FINDER_SCAN_MAX.toLocaleString('en-US')}{' '}
              {criteria.kind === 'company' ? 'companies' : 'people'} it could. Add a name or a place
              to narrow it and see the rest.
            </Notice>
          ) : null}
          {found.value.mail === 'unavailable' && criteria.years ? (
            <Notice tone="warn" className="mb-3">
              Your mail and calendar could not be read just now, so last contact uses Affinity’s
              dates only.
            </Notice>
          ) : null}
          {found.value.total === 0 ? (
            <EmptyState
              title="Nobody matches"
              description="Try fewer words, a wider place, or a longer time since you were in touch."
            />
          ) : (
            <>
              <Table caption="Search results">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>
                      {criteria.kind === 'company' ? 'Website' : 'Email'}
                    </TableHeaderCell>
                    <TableHeaderCell>Location</TableHeaderCell>
                    <TableHeaderCell numeric>Last contact</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {found.value.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableRowHeader>
                        <Link
                          href={`/lists/records/${row.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {row.name}
                        </Link>
                      </TableRowHeader>
                      <TableCell className="text-[var(--fg-muted)]">
                        {(criteria.kind === 'company' ? row.domain : row.primary_email) ?? '—'}
                      </TableCell>
                      <TableCell className="text-[var(--fg-muted)]">
                        {row.location ?? '—'}
                      </TableCell>
                      <TableCell numeric className="text-mini whitespace-nowrap">
                        {row.lastContact ? (
                          <span
                            title={
                              row.lastContact.source === 'affinity'
                                ? 'From Affinity'
                                : 'From your mail and calendar'
                            }
                          >
                            {formatSmartValue(row.lastContact, timezone)}
                            {row.lastContact.source === 'affinity' ? (
                              <span className="ml-1 text-[var(--label-gold)]">· Affinity</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-[var(--fg-subtle)]">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {found.value.total > found.value.rows.length ? (
                <p className="text-mini mt-2 text-[var(--fg-muted)]">
                  Showing the first {CRM_FINDER_SHOW.toLocaleString('en-US')} of{' '}
                  {found.value.total.toLocaleString('en-US')}. Saving or adding to a list takes all
                  of them.
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </div>
  );
}
