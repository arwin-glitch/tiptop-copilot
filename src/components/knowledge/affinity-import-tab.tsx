import { hasRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import type { AffinityExistingList } from '@/lib/crm/affinity-csv';
import { getAffinitySyncStatus } from '@/lib/services/affinity-sync';
import { CRM_MIGRATION_FILE, getCrmSetup, listCrmLists } from '@/lib/services/crm';
import { SectionHeading } from '@/components/shell/page-header';
import { NotConfigured } from '@/components/ui/not-configured';
import { AffinityImport } from '@/components/lists/affinity-import';
import { AffinitySyncPanel } from '@/components/knowledge/affinity-sync-panel';

/**
 * Knowledge → Affinity import: everything in Affinity, brought into Copilot.
 *
 * First the daily sync (lib/services/affinity-sync.ts), which copies Affinity
 * in every morning through its API once AFFINITY_API_KEY is set: its status,
 * and "Sync now" for the owner. Below it, the CSV import for files exported by
 * hand: read and mapped in the browser, shown for checking, then sent in
 * chunks to /api/crm/import. Before the CRM migration has been applied the
 * tab still reads and previews files, and says why nothing can be imported.
 * (This was /lists/import, which now redirects here.)
 */
export async function AffinityImportTab({ auth }: { auth: AuthContext }) {
  const store = getStore();
  const [setup, sync] = await Promise.all([
    getCrmSetup(store, auth.organizationId),
    getAffinitySyncStatus(store, auth.organizationId),
  ]);
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
    <section aria-labelledby="affinity-import-heading">
      <SectionHeading>
        <span id="affinity-import-heading">Import from Affinity</span>
      </SectionHeading>
      <AffinitySyncPanel
        status={{
          configured: sync.configured,
          demo: sync.demo,
          running: sync.running,
          phase: sync.phase,
          listsDone: sync.listsDone,
          listsTotal: sync.listsTotal,
          lastRun: sync.lastRun,
          lastError: sync.lastError,
        }}
        canSync={setup.ready && hasRole(auth, 'owner')}
      />
      <p className="mb-5 max-w-2xl text-sm text-[var(--fg-muted)]">
        Or by hand: export each list from Affinity (Export → Export view as CSV) and its notes
        (Export → Export all notes in view), then drop the files here. Each list&apos;s rows go to
        the page that uses them; Affinity lists shows where.
      </p>
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
    </section>
  );
}
