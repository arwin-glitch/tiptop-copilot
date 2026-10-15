import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { hasRole, requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import type { AffinityExistingList } from '@/lib/crm/affinity-csv';
import { CRM_MIGRATION_FILE, getCrmSetup, listCrmLists } from '@/lib/services/crm';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { NotConfigured } from '@/components/ui/not-configured';
import { AffinityImport } from '@/components/lists/affinity-import';

export const metadata: Metadata = { title: 'Import from Affinity' };
export const dynamic = 'force-dynamic';

/**
 * Bring Affinity's CSV exports into Copilot's lists. The files are read and
 * mapped in the browser, shown for checking, then sent in chunks to
 * /api/crm/import. Before the CRM migration has been applied the page still
 * reads and previews files, and says why nothing can be imported yet.
 */
export default async function AffinityImportPage() {
  const auth = await requireAuth();
  const store = getStore();
  const setup = await getCrmSetup(store, auth.organizationId);
  const canImport = hasRole(auth, 'member');
  // The lists a file can go into. A failed read only loses the choice: a
  // file then goes into the list with its name, as it would without one.
  const found = setup.ready
    ? await listCrmLists(store, auth.organizationId, { includeArchived: true })
    : null;
  const lists: AffinityExistingList[] = found?.ok
    ? found.value.map((l) => ({
        id: l.id,
        name: l.name,
        entityType: l.entity_type,
        archived: l.archived,
        entryCount: l.entry_count,
      }))
    : [];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Lists"
        title="Import from Affinity"
        subtitle="Export each list from Affinity (Export → Export view as CSV) and its notes (Export → Export all notes in view), then drop the files here."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/lists">
              <ArrowLeft aria-hidden="true" />
              All lists
            </Link>
          </Button>
        }
      />
      {!setup.ready ? (
        <NotConfigured
          className="mb-6"
          title="Importing is not available yet"
          description={`The CRM tables have not been created in the database, so nothing can be saved. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
          stillWorks="You can still drop files here to check how they will be read."
          action={null}
        />
      ) : null}
      <AffinityImport ready={setup.ready} canImport={canImport} lists={lists} />
    </PageShell>
  );
}
