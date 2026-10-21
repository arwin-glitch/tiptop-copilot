import Link from 'next/link';
import { hasRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import type { AffinityExitSettings } from '@/lib/crm/affinity-exit';
import { affinityExitCountdown } from '@/lib/crm/affinity-exit';
import type { AffinityExistingList } from '@/lib/crm/affinity-csv';
import {
  AFFINITY_EXIT_HREF,
  AFFINITY_IMPORT_HREF,
  type AffinityImportView,
} from '@/lib/records-tabs';
import { getAffinityExitStatus, readAffinityExitSettings } from '@/lib/services/affinity-exit';
import { getAffinitySyncStatus } from '@/lib/services/affinity-sync';
import { CRM_MIGRATION_FILE, getCrmSetup, listCrmLists } from '@/lib/services/crm';
import { SectionHeading } from '@/components/shell/page-header';
import { NotConfigured } from '@/components/ui/not-configured';
import { filterChipClassName } from '@/components/ui/toolbar';
import { AffinityImport } from '@/components/lists/affinity-import';
import { AffinityExitPanel } from '@/components/knowledge/affinity-exit-panel';
import { AffinitySyncPanel } from '@/components/knowledge/affinity-sync-panel';

/**
 * Knowledge → Affinity import: everything in Affinity, brought into Copilot,
 * and everything leaving it needs.
 *
 * Two views behind a pair of chips, so neither is a long scroll (`?view=exit`
 * is the second; the bare tab is the first, as it always was):
 *
 *   - Sync & import. First the daily sync (lib/services/affinity-sync.ts),
 *     which copies Affinity in every morning through its API once
 *     AFFINITY_API_KEY is set: its status, and "Sync now" for the owner.
 *     Below it, the CSV import for files exported by hand: read and mapped in
 *     the browser, shown for checking, then sent in chunks to /api/crm/import.
 *     Before the CRM migration has been applied the tab still reads and
 *     previews files, and says why nothing can be imported. (This was
 *     /lists/import, which now redirects here.)
 *   - Exit checklist (components/knowledge/affinity-exit-panel.tsx): the
 *     countdown to the notice date, what is and is not copied, the outside
 *     tools still on Affinity, and the final archive.
 */
export async function AffinityImportTab({
  auth,
  view = 'import',
}: {
  auth: AuthContext;
  view?: AffinityImportView;
}) {
  return view === 'exit' ? <ExitView auth={auth} /> : <ImportView auth={auth} />;
}

/** The chip that opens the checklist carries the countdown, so it is seen from the import too. */
function exitChipSuffix(settings: AffinityExitSettings, timeZone: string): string | null {
  if (settings.cancelled) return 'cancelled';
  const countdown = affinityExitCountdown(settings, new Date(), timeZone);
  if (!countdown) return null;
  const d = countdown.daysLeft;
  if (d < 0) return 'date passed';
  return d === 0 ? 'due today' : `${d} ${d === 1 ? 'day' : 'days'}`;
}

function ViewChips({ active, suffix }: { active: AffinityImportView; suffix: string | null }) {
  // A nav of two links, like the subtab bar: the URL is the state, and the
  // server renders only the view that is open.
  return (
    <nav aria-label="Affinity import views" className="mb-4 flex flex-wrap gap-1.5">
      <Link
        href={AFFINITY_IMPORT_HREF}
        prefetch={false}
        aria-current={active === 'import' ? 'page' : undefined}
        className={filterChipClassName(active === 'import')}
      >
        Sync &amp; import
      </Link>
      <Link
        href={AFFINITY_EXIT_HREF}
        prefetch={false}
        aria-current={active === 'exit' ? 'page' : undefined}
        className={filterChipClassName(active === 'exit')}
      >
        Exit checklist
        {suffix ? (
          <>
            {' '}
            <span className="tabular text-[var(--fg-subtle)]">· {suffix}</span>
          </>
        ) : null}
      </Link>
    </nav>
  );
}

async function ImportView({ auth }: { auth: AuthContext }) {
  const store = getStore();
  const [setup, sync, exit] = await Promise.all([
    getCrmSetup(store, auth.organizationId),
    getAffinitySyncStatus(store, auth.organizationId),
    readAffinityExitSettings(store, auth.organizationId),
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
      <ViewChips active="import" suffix={exitChipSuffix(exit, auth.profile.timezone)} />
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
          stopped: sync.stopped,
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

async function ExitView({ auth }: { auth: AuthContext }) {
  const now = new Date();
  const status = await getAffinityExitStatus(getStore(), auth.organizationId, {
    now,
    timeZone: auth.profile.timezone,
  });
  const owner = hasRole(auth, 'owner');
  return (
    <>
      <ViewChips active="exit" suffix={exitChipSuffix(status.settings, auth.profile.timezone)} />
      <AffinityExitPanel
        status={{
          settings: status.settings,
          crmReady: status.crmReady,
          lists: status.lists,
          companies: status.companies,
          people: status.people,
          notes: status.notes,
          introductions: status.introductions,
          sync: status.sync,
          imports: status.imports,
        }}
        timeZone={auth.profile.timezone}
        nowIso={now.toISOString()}
        canEdit={hasRole(auth, 'member')}
        canImport={owner && status.sync.state !== 'key_missing'}
        canArchive={owner}
      />
    </>
  );
}
