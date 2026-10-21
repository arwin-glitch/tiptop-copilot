import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { AuditEvent, CrmRecord, Deal, PortfolioCompany, Task } from '@/lib/types/domain';
import {
  taskCompanyHref,
  type TaskCompany,
  type TaskCompanyKind,
  type TaskCompanyOption,
} from '@/lib/tasks/task-company';
import { err, ok, type Result } from '@/lib/util/result';
import { searchRecords } from './crm';

/**
 * The company a task is about, shown as a small chip on its row: "Send the
 * data-room checklist (Brightkiln)".
 *
 * The links already exist: `tasks.deal_id` and `tasks.portfolio_company_id`.
 * A CRM company has no column on a task, so choosing one is kept as a
 * `task.company_set` audit row beside the task, `{v, kind, id, name}` (the
 * newest wins, and only while neither column is set), in the same way the
 * money and legal marks are kept (D-060): no migration, and a read that fails
 * shows no chip rather than an error. Choosing a deal or a portfolio company
 * writes its column (and clears the other); choosing a CRM company or "None"
 * clears both. Every choice is also a `task.company_set` row. None of it is
 * a "person touched it" action for the task-closer: which company a task is
 * about says nothing about whether it is done.
 */

export const TASK_COMPANY_ACTION = 'task.company_set';

export type { TaskCompany, TaskCompanyKind, TaskCompanyOption };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listByIds<T>(
  store: DataStore,
  table: 'deals' | 'portfolio_companies' | 'crm_records',
  organizationId: string,
  ids: readonly string[],
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)])) {
    out.push(...((await store.list(table, organizationId, { in: { id: part } })) as T[]));
  }
  return out;
}

/** The newest CRM choice for each task, among tasks with neither column set. */
async function crmChoices(
  store: DataStore,
  organizationId: string,
  taskIds: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  const newest = new Map<string, AuditEvent>();
  for (const part of chunk([...new Set(taskIds)])) {
    const rows = (await listAllPages(store, 'audit_events', organizationId, {
      eq: { entity_type: 'task', action: TASK_COMPANY_ACTION },
      in: { entity_id: part },
      notNull: ['user_id'],
    })) as AuditEvent[];
    for (const row of rows) {
      if (!row.entity_id) continue;
      const seen = newest.get(row.entity_id);
      if (!seen || Date.parse(row.created_at) > Date.parse(seen.created_at)) {
        newest.set(row.entity_id, row);
      }
    }
  }
  const out = new Map<string, { id: string; name: string }>();
  for (const [taskId, row] of newest) {
    const m = row.metadata ?? {};
    if (m.kind !== 'crm' || typeof m.id !== 'string' || !UUID_RE.test(m.id)) continue;
    out.set(taskId, { id: m.id, name: typeof m.name === 'string' ? m.name : '' });
  }
  return out;
}

/**
 * Each linked task's company. Never throws: a fault shows no chips, and a
 * missing CRM table shows no CRM chips.
 */
export async function readTaskCompanies(
  store: DataStore,
  organizationId: string,
  tasks: readonly Pick<Task, 'id' | 'deal_id' | 'portfolio_company_id'>[],
): Promise<Map<string, TaskCompany>> {
  const out = new Map<string, TaskCompany>();
  try {
    const dealIds = tasks.map((t) => t.deal_id).filter((id): id is string => !!id);
    const portfolioIds = tasks
      .filter((t) => !t.deal_id)
      .map((t) => t.portfolio_company_id)
      .filter((id): id is string => !!id);
    const unlinked = tasks.filter((t) => !t.deal_id && !t.portfolio_company_id).map((t) => t.id);
    const [deals, portfolio, crm] = await Promise.all([
      dealIds.length > 0 ? listByIds<Deal>(store, 'deals', organizationId, dealIds) : [],
      portfolioIds.length > 0
        ? listByIds<PortfolioCompany>(store, 'portfolio_companies', organizationId, portfolioIds)
        : [],
      unlinked.length > 0 ? crmChoices(store, organizationId, unlinked) : new Map(),
    ]);
    const records =
      crm.size > 0
        ? await listByIds<CrmRecord>(
            store,
            'crm_records',
            organizationId,
            [...crm.values()].map((c) => c.id),
          ).catch(() => [] as CrmRecord[])
        : [];
    const dealById = new Map(deals.map((d) => [d.id, d]));
    const portfolioById = new Map(portfolio.map((p) => [p.id, p]));
    const recordById = new Map(records.map((r) => [r.id, r]));

    for (const task of tasks) {
      const deal = task.deal_id ? dealById.get(task.deal_id) : undefined;
      if (deal) {
        out.set(task.id, {
          kind: 'deal',
          id: deal.id,
          name: deal.company_name,
          href: taskCompanyHref('deal', deal.id),
        });
        continue;
      }
      const company = task.portfolio_company_id
        ? portfolioById.get(task.portfolio_company_id)
        : undefined;
      if (company) {
        out.set(task.id, {
          kind: 'portfolio',
          id: company.id,
          name: company.name,
          href: taskCompanyHref('portfolio', company.id),
        });
        continue;
      }
      const choice = crm.get(task.id);
      if (choice) {
        const record = recordById.get(choice.id);
        const name = record?.name ?? choice.name;
        if (name) {
          out.set(task.id, {
            kind: 'crm',
            id: choice.id,
            name,
            href: record ? taskCompanyHref('crm', choice.id) : null,
          });
        }
      }
    }
  } catch (error) {
    log.warn('Task companies could not be read', {
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
  return out;
}

/**
 * A person's choice of company for a task, or none. The company must exist
 * in the organization: a deal, a portfolio company or a CRM company.
 */
export async function setTaskCompany(
  auth: AuthContext,
  taskId: string,
  choice: { kind: TaskCompanyKind; id: string } | null,
): Promise<Result<TaskCompany | null>> {
  const store = getStore();
  const task = (await store.get('tasks', auth.organizationId, taskId)) as Task | null;
  if (!task || task.status === 'cancelled') return err('not_found', 'That task does not exist.');

  let company: TaskCompany | null = null;
  if (choice) {
    if (!UUID_RE.test(choice.id)) return err('invalid_input', 'That company is not valid.');
    let name: string | null = null;
    if (choice.kind === 'deal') {
      const deal = (await store.get('deals', auth.organizationId, choice.id)) as Deal | null;
      name = deal?.company_name ?? null;
    } else if (choice.kind === 'portfolio') {
      const row = (await store.get(
        'portfolio_companies',
        auth.organizationId,
        choice.id,
      )) as PortfolioCompany | null;
      name = row?.name ?? null;
    } else {
      const record = (await store
        .get('crm_records', auth.organizationId, choice.id)
        .catch(() => null)) as CrmRecord | null;
      name = record && record.kind === 'company' ? record.name : null;
    }
    if (!name) return err('not_found', 'That company is not in Copilot.');
    company = {
      kind: choice.kind,
      id: choice.id,
      name,
      href: taskCompanyHref(choice.kind, choice.id),
    };
  }

  const patch: Partial<Task> = {
    deal_id: company?.kind === 'deal' ? company.id : null,
    portfolio_company_id: company?.kind === 'portfolio' ? company.id : null,
  };
  const changed =
    patch.deal_id !== task.deal_id || patch.portfolio_company_id !== task.portfolio_company_id;
  if (changed) await store.update('tasks', auth.organizationId, taskId, patch);
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: TASK_COMPANY_ACTION,
    entityType: 'task',
    entityId: taskId,
    metadata: {
      v: 1,
      kind: company?.kind ?? null,
      id: company?.id ?? null,
      name: company?.name ?? null,
      previous: { deal_id: task.deal_id, portfolio_company_id: task.portfolio_company_id },
    },
  });
  return ok(company);
}

const PER_KIND = 6;
const MAX_QUERY = 80;

/**
 * Companies a task can be linked to, for the edit dialog's picker: portfolio
 * companies, deals and CRM companies whose names contain the text. A CRM
 * company with the same name as a deal or portfolio company already listed
 * is left out. Each source failing on its own only leaves it out.
 */
export async function searchTaskCompanies(
  store: DataStore,
  organizationId: string,
  rawQuery: string,
): Promise<TaskCompanyOption[]> {
  const query = rawQuery.trim().slice(0, MAX_QUERY);
  if (query.length < 2) return [];
  const safe = async <T>(run: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await run();
    } catch {
      return [];
    }
  };
  const like = (columns: string[]) => ({ textSearch: { columns, query } });
  const [portfolio, deals, crm] = await Promise.all([
    safe(
      () =>
        store.list('portfolio_companies', organizationId, like(['name']), {
          limit: PER_KIND,
          orderBy: [{ field: 'name', direction: 'asc' }],
        }) as Promise<PortfolioCompany[]>,
    ),
    safe(
      () =>
        store.list('deals', organizationId, like(['company_name']), {
          limit: PER_KIND,
          orderBy: [{ field: 'company_name', direction: 'asc' }],
        }) as Promise<Deal[]>,
    ),
    safe(async () => {
      const found = await searchRecords(store, organizationId, query, PER_KIND, 'company');
      return found.ok ? found.value : [];
    }),
  ]);
  const options: TaskCompanyOption[] = [
    ...portfolio.map((p) => ({
      kind: 'portfolio' as const,
      id: p.id,
      name: p.name,
      sub: 'Portfolio',
    })),
    ...deals.map((d) => ({
      kind: 'deal' as const,
      id: d.id,
      name: d.company_name,
      sub: d.stage ? `Deal · ${d.stage.replace(/_/g, ' ')}` : 'Deal',
    })),
  ];
  const named = new Set(options.map((o) => o.name.trim().toLowerCase()));
  for (const record of crm) {
    if (named.has(record.name.trim().toLowerCase())) continue;
    options.push({
      kind: 'crm',
      id: record.id,
      name: record.name,
      sub: record.domain ? `CRM · ${record.domain}` : 'CRM',
    });
  }
  return options;
}
