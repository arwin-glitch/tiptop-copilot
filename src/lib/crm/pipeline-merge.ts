import type { DealStage } from '@/lib/types/domain';
import { normalizeCompanyName, normalizeDomain } from '@/lib/util/text';
import { affinityDealStageKey } from './stage-map';

/**
 * One deal pipeline out of two: Copilot's own deals and the rows of
 * Affinity's deal lists, matched company by company.
 *
 * A row is a company. Copilot's deal and Affinity's entries for the same
 * company (same domain, else the same normalized name) share a row, so Nick
 * sees one line per company with both stages on it. Read-only by design:
 * nothing here writes a stage or a decision on either side. Where the two
 * disagree the row says so and keeps both.
 *
 * Pure and client-safe; the page reads the rows (`lib/services/crm-pages.ts`)
 * and this decides how they line up.
 */

export interface PipelineDealInput {
  id: string;
  company_name: string;
  domain: string | null;
  stage: string;
  received_at: string;
  updated_at: string;
}

export interface PipelineEntryInput {
  entryId: string;
  listId: string;
  listName: string;
  /** The entry's title as the list shows it (an opportunity's own name). */
  title: string;
  recordId: string | null;
  /** The linked company's name, when the entry has a record. */
  recordName: string | null;
  domain: string | null;
  /** The entry's stage on its list, as Affinity wrote it. */
  status: string | null;
  updatedAt: string;
}

export interface PipelineAffinityEntry extends PipelineEntryInput {
  /** Copilot's stage key for `status`, or null when it reads as none. */
  mappedKey: string | null;
}

export interface PipelineRow {
  /** Stable for React: the deal id, else the record id or name of the first entry. */
  key: string;
  name: string;
  domain: string | null;
  deal: { id: string; stageKey: string } | null;
  /** Newest first. */
  affinity: PipelineAffinityEntry[];
  /** The stage the row is grouped by: Copilot's when it has the deal, else Affinity's reading. */
  stageKey: string | null;
  stageSource: 'copilot' | 'affinity' | null;
  /** Both sides have a stage for the company and they read differently. */
  differs: boolean;
  /** The latest change on either side. */
  lastActivity: string;
}

function latest(a: string, b: string): string {
  return a > b ? a : b;
}

/** Merge Copilot's deals and Affinity's deal-list entries into one row per company. */
export function mergePipeline(
  deals: readonly PipelineDealInput[],
  entries: readonly PipelineEntryInput[],
  stages?: readonly Pick<DealStage, 'key'>[],
): PipelineRow[] {
  const rows: PipelineRow[] = [];
  const byDomain = new Map<string, PipelineRow>();
  const byName = new Map<string, PipelineRow>();
  const index = (row: PipelineRow, domain: string | null, names: string[]) => {
    if (domain && !byDomain.has(domain)) byDomain.set(domain, row);
    for (const n of names) if (n && !byName.has(n)) byName.set(n, row);
  };

  for (const deal of deals) {
    const row: PipelineRow = {
      key: deal.id,
      name: deal.company_name,
      domain: normalizeDomain(deal.domain),
      deal: { id: deal.id, stageKey: deal.stage },
      affinity: [],
      stageKey: deal.stage,
      stageSource: 'copilot',
      differs: false,
      lastActivity: latest(deal.received_at, deal.updated_at),
    };
    rows.push(row);
    index(row, row.domain, [normalizeCompanyName(deal.company_name)]);
  }

  // Newest first, so each row's first entry is its current Affinity stage.
  const ordered = [...entries].sort((a, b) =>
    a.updatedAt === b.updatedAt
      ? a.entryId.localeCompare(b.entryId)
      : a.updatedAt < b.updatedAt
        ? 1
        : -1,
  );
  for (const entry of ordered) {
    const domain = normalizeDomain(entry.domain);
    const names = [entry.recordName, entry.title]
      .filter((n): n is string => Boolean(n))
      .map((n) => normalizeCompanyName(n))
      .filter(Boolean);
    const affinity: PipelineAffinityEntry = {
      ...entry,
      mappedKey: affinityDealStageKey(entry.status, stages),
    };
    const row =
      (domain ? byDomain.get(domain) : undefined) ??
      names.map((n) => byName.get(n)).find((r): r is PipelineRow => Boolean(r));
    if (row) {
      row.affinity.push(affinity);
      row.lastActivity = latest(row.lastActivity, entry.updatedAt);
      if (!row.domain && domain) {
        row.domain = domain;
        index(row, domain, []);
      }
      continue;
    }
    const created: PipelineRow = {
      key: entry.recordId ?? `entry:${entry.entryId}`,
      name: entry.recordName ?? entry.title,
      domain,
      deal: null,
      affinity: [affinity],
      stageKey: null,
      stageSource: null,
      differs: false,
      lastActivity: entry.updatedAt,
    };
    rows.push(created);
    index(created, domain, names);
  }

  for (const row of rows) {
    const current = row.affinity[0];
    if (row.deal) {
      row.differs = Boolean(current?.mappedKey && current.mappedKey !== row.deal.stageKey);
    } else if (current) {
      row.stageKey = current.mappedKey;
      row.stageSource = current.mappedKey ? 'affinity' : null;
    }
  }
  return rows;
}

/**
 * `open` is every stage that is not terminal, plus rows whose stage is
 * unknown; `any` is every row; `other` the rows whose stage is unknown; any
 * other value one stage key.
 */
export type PipelineStageFilter = 'open' | 'any' | 'other' | string;

export interface PipelineCounts {
  total: number;
  open: number;
  /** Rows whose Affinity stage reads as none of Copilot's. */
  other: number;
  byStage: Record<string, number>;
  copilot: number;
  affinity: number;
  both: number;
}

function isOpen(row: PipelineRow, terminal: ReadonlySet<string>): boolean {
  return row.stageKey === null || !terminal.has(row.stageKey);
}

export function countPipeline(
  rows: readonly PipelineRow[],
  stages: readonly Pick<DealStage, 'key' | 'terminal'>[],
): PipelineCounts {
  const terminal = new Set(stages.filter((s) => s.terminal).map((s) => s.key));
  const out: PipelineCounts = {
    total: rows.length,
    open: 0,
    other: 0,
    byStage: {},
    copilot: 0,
    affinity: 0,
    both: 0,
  };
  for (const row of rows) {
    if (isOpen(row, terminal)) out.open++;
    if (row.stageKey === null) out.other++;
    else out.byStage[row.stageKey] = (out.byStage[row.stageKey] ?? 0) + 1;
    if (row.deal && row.affinity.length) out.both++;
    else if (row.deal) out.copilot++;
    else out.affinity++;
  }
  return out;
}

/** Rows in one stage filter whose name, domain or Affinity title contains `query`; newest first. */
export function filterPipeline(
  rows: readonly PipelineRow[],
  stages: readonly Pick<DealStage, 'key' | 'terminal'>[],
  options: { stage?: PipelineStageFilter | null; query?: string | null },
): PipelineRow[] {
  const terminal = new Set(stages.filter((s) => s.terminal).map((s) => s.key));
  const needle = options.query?.trim().toLowerCase() ?? '';
  const stage = options.stage ?? 'open';
  return rows
    .filter((row) => {
      if (stage === 'any') {
        // every row
      } else if (stage === 'open') {
        if (!isOpen(row, terminal)) return false;
      } else if (stage === 'other') {
        if (row.stageKey !== null) return false;
      } else if (row.stageKey !== stage) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        Boolean(row.domain?.includes(needle)) ||
        row.affinity.some((e) => e.title.toLowerCase().includes(needle))
      );
    })
    .sort((a, b) =>
      a.lastActivity === b.lastActivity
        ? a.name.localeCompare(b.name)
        : a.lastActivity < b.lastActivity
          ? 1
          : -1,
    );
}
