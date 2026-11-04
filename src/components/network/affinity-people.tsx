import type { AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { NETWORK_TABS } from '@/lib/records-tabs';
import { listCrmPeople } from '@/lib/services/crm-pages';
import { LinkChips, pageHref } from '@/components/crm/link-chips';

const PATH = NETWORK_TABS.path;
const DEFAULT_TAB = NETWORK_TABS.defaultKey;
const AFFINITY_VIEW = { tab: 'people', source: 'affinity' } as const;

/**
 * Where the people list reads from: the mailbox and calendar, or the CRM's
 * people or companies (CrmDirectory, with status, connections and last
 * contact).
 */
export type PeopleSource = 'mail' | 'affinity' | 'companies';

export function asPeopleSource(raw: string | null | undefined): PeopleSource {
  return raw === 'affinity' || raw === 'companies' ? raw : 'mail';
}

/** How many people the CRM holds (optionally matching `q`); null when it cannot say. */
export async function affinityPeopleCount(auth: AuthContext, q?: string): Promise<number | null> {
  const page = await listCrmPeople(getStore(), auth.organizationId, { query: q, limit: 1 });
  return page.ok ? page.value.total : null;
}

/**
 * The people directory's sources, one click apart: everyone in the mailbox
 * and calendar (the default, as before), the people carried over from
 * Affinity, labelled as such, and the companies.
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
    <div data-tour="people-source">
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
          {
            key: 'companies',
            label: 'Companies',
            href: pageHref(PATH, { tab: 'people', source: 'companies', q: q || null }, DEFAULT_TAB),
            active: source === 'companies',
          },
        ]}
      />
    </div>
  );
}
