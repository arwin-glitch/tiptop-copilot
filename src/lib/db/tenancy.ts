import 'server-only';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import type { Organization } from '@/lib/types/domain';

/**
 * The organization a machine endpoint should act on.
 *
 * Some callers arrive with no session and no organization: a Pub/Sub push
 * naming only a mailbox, a Granola delivery naming only a note. They still
 * have to write into some tenant's data.
 *
 * This deployment is single-tenant, so the answer is "the only organization
 * there is" — and if that is ever untrue, the answer is nothing at all. A
 * webhook must never guess which fund a meeting note or a mailbox belongs to;
 * getting that wrong files one client's private notes in another's record,
 * which is worse than dropping the delivery.
 *
 * `organizations` is a scopeless table, so listing it without an organization
 * is legitimate rather than the mistake `assertScoped` exists to catch.
 */
export async function soleOrganizationId(context: string): Promise<string | null> {
  try {
    const organizations = (await getStore().list('organizations', '', {})) as Organization[];
    if (organizations.length !== 1) {
      log.warn('Ambiguous organization for a machine endpoint', {
        context,
        count: organizations.length,
      });
      return null;
    }
    return organizations[0]?.id ?? null;
  } catch (error) {
    log.error('Could not read organizations', {
      context,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
}
