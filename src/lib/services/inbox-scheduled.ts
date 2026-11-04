import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { LiveThreadRow } from './inbox-live';

/**
 * Schedule send for the Inbox tab. Filled in with the scheduled-send table;
 * until then the Scheduled folder is empty and says it needs a database update.
 */

export async function listScheduledRows(
  _store: DataStore,
  _organizationId: string,
): Promise<{ state: 'ok' | 'needs_migration'; rows: LiveThreadRow[] }> {
  return { state: 'needs_migration', rows: [] };
}

export async function countScheduled(
  _store: DataStore,
  _organizationId: string,
): Promise<number | null> {
  return null;
}
