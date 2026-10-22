import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { configuredBoardUrl } from '@/lib/jobs-board/config';
import {
  buildPublicBoard,
  postingPublicState,
  type PublicBoard,
  type PublicState,
} from '@/lib/jobs-board/public';
import type { JobRole } from '@/lib/portfolio/jobs';
import { single } from '@/lib/util/page-tabs';
import { readJobsBoard } from '@/lib/services/jobs-board';
import { importEmailedRolesOnView } from '@/lib/services/jobs-board-sync';
import type {
  JobBoardSettings,
  JobCompany,
  JobPosting,
  PortfolioCompany,
} from '@/lib/types/domain';

/**
 * What Portfolio > Jobs needs for the public board: the board's switch, each
 * role with its public state (one gate: postingPublicState), the approvals
 * queue, and the board as visitors see it. Emailed roles from the latest
 * jobs scan are brought in as drafts first (at most every five minutes).
 */

export const JOBS_VIEWS = ['email', 'approvals', 'board', 'companies'] as const;
export type JobsView = (typeof JOBS_VIEWS)[number];

export function parseJobsView(params: Record<string, string | string[] | undefined>): JobsView {
  const raw = single(params.view);
  return (JOBS_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as JobsView) : 'email';
}

export interface JobsBoardTab {
  /** False until the migration has run. */
  available: boolean;
  enabled: boolean;
  settings: JobBoardSettings | null;
  portfolio: PortfolioCompany[];
  companyByPortfolio: Map<string, JobCompany>;
  postings: JobPosting[];
  states: Map<string, PublicState>;
  /** Emailed roles waiting for a person, newest first. */
  pending: JobPosting[];
  /** The board as visitors would see it (whether or not it is on). */
  board: PublicBoard;
  /** "View public board": the board's own address once set, else /jobs here. */
  publicHref: string;
}

export function isPending(p: JobPosting): boolean {
  return p.source === 'email' && p.status === 'active' && !p.approved_at && !p.hidden_at;
}

export async function loadJobsBoardTab(
  store: DataStore,
  organizationId: string,
  emailedRoles: readonly JobRole[] | null,
): Promise<JobsBoardTab> {
  let data = await readJobsBoard(store, organizationId);
  if (data.available && emailedRoles) {
    const imported = await importEmailedRolesOnView(store, organizationId, emailedRoles);
    if (imported && (imported.added > 0 || imported.closed > 0))
      data = await readJobsBoard(store, organizationId);
  }
  const companyByPortfolio = new Map(data.companies.map((c) => [c.portfolio_company_id, c]));
  const portfolioById = new Map(data.portfolio.map((p) => [p.id, p]));
  const states = new Map<string, PublicState>();
  for (const p of data.postings) {
    states.set(
      p.id,
      postingPublicState(
        p,
        companyByPortfolio.get(p.portfolio_company_id) ?? null,
        portfolioById.get(p.portfolio_company_id) ?? null,
      ),
    );
  }
  const pending = data.postings
    .filter(isPending)
    .sort((a, b) => (b.posted_at ?? b.first_seen_at).localeCompare(a.posted_at ?? a.first_seen_at));
  const board = buildPublicBoard({
    settings: data.settings,
    portfolio: data.portfolio,
    jobCompanies: data.companies,
    postings: data.postings,
  });
  return {
    available: data.available,
    enabled: Boolean(data.settings?.enabled),
    settings: data.settings,
    portfolio: data.portfolio,
    companyByPortfolio,
    postings: data.postings,
    states,
    pending,
    board,
    publicHref: configuredBoardUrl() ?? '/jobs',
  };
}
