import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import type {
  CrmList,
  Deal,
  KnowledgeDocument,
  MeetingNote,
  NetworkContact,
  PortfolioCompany,
  Task,
} from '@/lib/types/domain';
import { searchRecords } from './crm';
import { readFollowUps } from './follow-ups';

/**
 * One search box across the app: deals, portfolio companies, Fund II LPs,
 * people, meetings, tasks, documents, and the CRM's lists and the companies
 * and people on them. Each source is a small substring match (ILIKE through
 * the store), capped per source, so a keystroke never scans a whole table.
 * Results carry an in-app href only.
 *
 * The CRM results come last and the palette shows them as their own "Lists"
 * group. Their tables arrive by a hand-applied migration; until then those
 * sources simply return nothing, like any other source that fails.
 */

export type SearchKind =
  | 'deal'
  | 'portfolio'
  | 'lp'
  | 'person'
  | 'meeting'
  | 'task'
  | 'document'
  | 'crm_list'
  | 'crm_company'
  | 'crm_person';

export interface SearchResult {
  kind: SearchKind;
  label: string;
  sub: string | null;
  href: string;
}

const PER_SOURCE = 6;

const CRM_LIST_KIND: Record<CrmList['entity_type'], string> = {
  deal: 'Deal list',
  company: 'Company list',
  person: 'Person list',
};
const MAX_QUERY = 80;

export async function searchEverything(
  store: DataStore,
  organizationId: string,
  rawQuery: string,
): Promise<SearchResult[]> {
  const query = rawQuery.trim().slice(0, MAX_QUERY);
  if (query.length < 2) return [];
  const needle = query.toLowerCase();
  const like = (columns: string[]) => ({ textSearch: { columns, query } });

  const safe = async <T>(label: string, run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch {
      log.warn('Search source failed', { source: label });
      return [];
    }
  };

  const [deals, portfolio, people, meetings, tasks, documents, followUps, crmLists, crmRecords] =
    await Promise.all([
      safe(
        'deals',
        () =>
          store.list('deals', organizationId, like(['company_name']), {
            limit: PER_SOURCE,
          }) as Promise<Deal[]>,
      ),
      safe(
        'portfolio',
        () =>
          store.list('portfolio_companies', organizationId, like(['name']), {
            limit: PER_SOURCE,
          }) as Promise<PortfolioCompany[]>,
      ),
      safe(
        'people',
        () =>
          store.list('network_contacts', organizationId, like(['full_name', 'company', 'email']), {
            limit: PER_SOURCE,
          }) as Promise<NetworkContact[]>,
      ),
      safe(
        'meetings',
        () =>
          store.list('meeting_notes', organizationId, like(['title']), {
            limit: PER_SOURCE,
            orderBy: [{ field: 'occurred_at', direction: 'desc' }],
          }) as Promise<MeetingNote[]>,
      ),
      safe(
        'tasks',
        () =>
          store.list('tasks', organizationId, like(['title']), { limit: PER_SOURCE }) as Promise<
            Task[]
          >,
      ),
      safe(
        'documents',
        () =>
          store.list('knowledge_documents', organizationId, like(['title', 'filename']), {
            limit: PER_SOURCE,
          }) as Promise<KnowledgeDocument[]>,
      ),
      readFollowUps(store, organizationId).catch(() => null),
      safe(
        'crm lists',
        () =>
          store.list('crm_lists', organizationId, like(['name']), {
            limit: PER_SOURCE,
            orderBy: [{ field: 'position', direction: 'asc' }],
          }) as Promise<CrmList[]>,
      ),
      // Ranked (exact name, then prefixes); a Result, so a missing table is an
      // empty source rather than a throw.
      searchRecords(store, organizationId, query, PER_SOURCE).then((r) => (r.ok ? r.value : [])),
    ]);

  const results: SearchResult[] = [];
  for (const d of deals) {
    results.push({
      kind: 'deal',
      label: d.company_name,
      sub: d.product_summary ?? null,
      href: `/deals/${d.id}`,
    });
  }
  for (const p of portfolio) {
    results.push({
      kind: 'portfolio',
      label: p.name,
      sub: 'Portfolio company',
      href: `/portfolio/${p.id}`,
    });
  }
  const lps = followUps?.state === 'ok' ? (followUps.snapshot.lpPipeline?.lps ?? []) : [];
  for (const lp of lps
    .filter((l) => `${l.who} ${l.firm ?? ''}`.toLowerCase().includes(needle))
    .slice(0, PER_SOURCE)) {
    results.push({
      kind: 'lp',
      label: lp.who,
      sub: [lp.firm, `Fund II · ${lp.stage.replace('_', ' ')}`].filter(Boolean).join(' · '),
      href: '/fund-ii',
    });
  }
  for (const c of people) {
    results.push({
      kind: 'person',
      label: c.full_name,
      sub: [c.title, c.company].filter(Boolean).join(' · ') || null,
      href: `/network?q=${encodeURIComponent(c.full_name)}`,
    });
  }
  for (const m of meetings) {
    results.push({
      kind: 'meeting',
      label: m.title,
      sub: m.occurred_at.slice(0, 10),
      href: `/meetings?q=${encodeURIComponent(m.title)}`,
    });
  }
  for (const t of tasks) {
    results.push({
      kind: 'task',
      label: t.title,
      sub: t.status === 'complete' ? 'Completed task' : 'Task',
      href: '/tasks',
    });
  }
  for (const doc of documents) {
    results.push({
      kind: 'document',
      label: doc.title,
      sub: doc.filename,
      href: `/knowledge?q=${encodeURIComponent(doc.title)}`,
    });
  }
  for (const list of crmLists) {
    results.push({
      kind: 'crm_list',
      label: list.name,
      sub: [CRM_LIST_KIND[list.entity_type], list.archived ? 'archived' : null]
        .filter(Boolean)
        .join(' · '),
      href: `/lists/${list.id}`,
    });
  }
  for (const record of crmRecords) {
    results.push({
      kind: record.kind === 'company' ? 'crm_company' : 'crm_person',
      label: record.name,
      sub: (record.kind === 'company' ? record.domain : record.primary_email) ?? null,
      href: `/lists/records/${record.id}`,
    });
  }
  return results;
}
