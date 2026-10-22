'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  featurePosting,
  hidePosting,
  publishPosting,
  revalidatePublicBoard,
  saveBoardText,
  saveCompanyJobs,
  savePosting,
  setBoardEnabled,
  setPostingOpen,
  type CompanyJobsInput,
  type JobsActor,
  type PostingInput,
} from '@/lib/services/jobs-board';
import {
  detectCareersBoard,
  importEmailedRoles,
  syncJobBoards,
  type CompanySyncResult,
  type EmailImport,
} from '@/lib/services/jobs-board-sync';
import { readPortfolioJobs } from '@/lib/services/portfolio-jobs';
import { jobLinkVerdicts } from '@/lib/services/job-liveness';
import { applyJobLiveness } from '@/lib/portfolio/jobs';
import type { AppError, Result } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Server actions for the public job board, on Portfolio > Jobs. Every action
 * signs in first and needs the member role (the floor the board tables'
 * row-level security sets), and hands the work to lib/services/jobs-board*.
 * After a change, Portfolio and the cached public pages are rebuilt, so what
 * a person publishes is live on the board at once.
 */

function fail(error: AppError): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

async function writer(
  limit = 120,
): Promise<
  | { auth: AuthContext; actor: JobsActor; denied?: undefined }
  | { auth?: undefined; actor?: undefined; denied: ActionResult<never> }
> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) return { denied: fail(role.error) };
  const limited = rateLimit(`jobs-board-write:${auth.userId}:${limit}`, limit, 60_000);
  if (!limited.ok) return { denied: fail(limited.error) };
  return { auth, actor: { organizationId: auth.organizationId, userId: auth.userId } };
}

function done<T>(result: Result<T>): ActionResult<T> {
  if (!result.ok) return fail(result.error);
  revalidatePath('/portfolio');
  revalidatePublicBoard();
  return { ok: true, data: result.value };
}

export async function setJobBoardEnabledAction(
  enabled: boolean,
): Promise<ActionResult<{ enabled: boolean }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await setBoardEnabled(getStore(), actor, enabled === true);
  return done(result.ok ? { ok: true, value: { enabled: result.value.enabled } } : result);
}

export async function saveJobBoardTextAction(input: {
  title?: string;
  intro?: string;
  accent?: string;
}): Promise<ActionResult<{ title: string }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await saveBoardText(getStore(), actor, {
    title: input?.title,
    intro: input?.intro,
    accent: input?.accent,
  });
  return done(result.ok ? { ok: true, value: { title: result.value.title } } : result);
}

export async function saveJobCompanyAction(
  portfolioCompanyId: string,
  input: CompanyJobsInput,
): Promise<ActionResult<{ note: string | null; detected: string | null; changedRoles: number }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const clean: CompanyJobsInput = {};
  if (input && typeof input === 'object') {
    if ('careersUrl' in input)
      clean.careersUrl = typeof input.careersUrl === 'string' ? input.careersUrl : null;
    if ('syncEnabled' in input) clean.syncEnabled = input.syncEnabled === true;
    if ('autoPublish' in input) clean.autoPublish = input.autoPublish === true;
    if ('listed' in input) clean.listed = input.listed === true;
    if ('logoUrl' in input)
      clean.logoUrl = typeof input.logoUrl === 'string' ? input.logoUrl : null;
    if ('about' in input) clean.about = typeof input.about === 'string' ? input.about : null;
  }
  const result = await saveCompanyJobs(getStore(), actor, String(portfolioCompanyId ?? ''), clean, {
    detect: (url) => detectCareersBoard(url),
  });
  return done(
    result.ok
      ? {
          ok: true,
          value: {
            note: result.value.note,
            detected: result.value.detected
              ? `${result.value.detected.ats}:${result.value.detected.token}`
              : null,
            changedRoles: result.value.changedRoles,
          },
        }
      : result,
  );
}

/**
 * "Refresh now": read the companies' job boards (one company, or all with
 * the sync on) and bring in roles from the latest jobs scan as drafts.
 */
export async function refreshJobBoardsAction(portfolioCompanyId?: string): Promise<
  ActionResult<{
    results: CompanySyncResult[];
    imported: EmailImport | null;
  }>
> {
  const { auth, denied } = await writer(6);
  if (denied) return denied;
  const store = getStore();
  const summary = await syncJobBoards(store, auth.organizationId, {
    trigger: 'manual',
    companyIds: portfolioCompanyId ? [String(portfolioCompanyId)] : undefined,
    userId: auth.userId,
  });
  if (summary.state === 'not_configured') {
    return fail({
      code: 'not_configured',
      message:
        'The public job board needs its database tables. Run supabase/migrations/20261022100000_public_jobs.sql in the Supabase SQL editor.',
    });
  }
  let imported: EmailImport | null = null;
  if (!portfolioCompanyId) {
    const jobs = await readPortfolioJobs(store, auth.organizationId).catch(() => null);
    if (jobs?.state === 'ok' && jobs.snapshot) {
      // A posting its job board has dropped reads as closed, as on the Jobs tab.
      const roles = jobs.snapshot.roles;
      const live = applyJobLiveness(roles, await jobLinkVerdicts(roles));
      imported = await importEmailedRoles(store, auth.organizationId, live).catch(() => null);
    }
  }
  revalidatePath('/portfolio');
  revalidatePublicBoard();
  return { ok: true, data: { results: summary.results, imported } };
}

export async function publishJobAction(
  postingId: string,
  options?: { confirmLink?: boolean },
): Promise<ActionResult<{ id: string }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await publishPosting(getStore(), actor, String(postingId ?? ''), {
    confirmLink: options?.confirmLink === true,
  });
  return done(result.ok ? { ok: true, value: { id: result.value.id } } : result);
}

export async function hideJobAction(postingId: string): Promise<ActionResult<{ id: string }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await hidePosting(getStore(), actor, String(postingId ?? ''));
  return done(result.ok ? { ok: true, value: { id: result.value.id } } : result);
}

export async function featureJobAction(
  postingId: string,
  featured: boolean,
): Promise<ActionResult<{ featured: boolean }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await featurePosting(
    getStore(),
    actor,
    String(postingId ?? ''),
    featured === true,
  );
  return done(result.ok ? { ok: true, value: { featured: result.value.featured } } : result);
}

export async function setJobOpenAction(
  postingId: string,
  open: boolean,
): Promise<ActionResult<{ status: string }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const result = await setPostingOpen(getStore(), actor, String(postingId ?? ''), open === true);
  return done(result.ok ? { ok: true, value: { status: result.value.status } } : result);
}

export async function saveJobAction(
  input: PostingInput,
  postingId?: string,
): Promise<ActionResult<{ id: string; published: boolean }>> {
  const { actor, denied } = await writer();
  if (denied) return denied;
  const safe: PostingInput = {
    portfolioCompanyId:
      typeof input?.portfolioCompanyId === 'string' ? input.portfolioCompanyId : undefined,
    title: typeof input?.title === 'string' ? input.title : undefined,
    team: typeof input?.team === 'string' ? input.team : null,
    fn: typeof input?.fn === 'string' ? input.fn : null,
    locations: typeof input?.locations === 'string' ? input.locations : null,
    remote: typeof input?.remote === 'string' ? input.remote : null,
    employmentType: typeof input?.employmentType === 'string' ? input.employmentType : null,
    seniority: typeof input?.seniority === 'string' ? input.seniority : null,
    comp: typeof input?.comp === 'string' ? input.comp : null,
    description: typeof input?.description === 'string' ? input.description.slice(0, 40_000) : null,
    applyUrl: typeof input?.applyUrl === 'string' ? input.applyUrl : null,
    publish: input?.publish === true,
  };
  const result = await savePosting(
    getStore(),
    actor,
    safe,
    typeof postingId === 'string' ? postingId : undefined,
  );
  return done(
    result.ok
      ? { ok: true, value: { id: result.value.id, published: result.value.published } }
      : result,
  );
}
