import 'server-only';
import { revalidatePath, revalidateTag, unstable_cache } from 'next/cache';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore, Row } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import {
  detectAtsFromUrl,
  isAts,
  isValidAtsToken,
  parseCareersUrl,
  type AtsBoard,
} from '@/lib/jobs-board/ats';
import {
  guessFunction,
  guessSeniority,
  isEmploymentType,
  isSeniority,
  normalizeJobRemote,
} from '@/lib/jobs-board/fields';
import {
  ACCENT,
  DEFAULT_BOARD_ACCENT,
  DEFAULT_BOARD_TITLE,
  applyLinkFor,
  buildPublicBoard,
  type PublicBoard,
} from '@/lib/jobs-board/public';
import type { CareersSource } from '@/lib/jobs-board/careers-page';
import { isPrivateDocLink, PRIVATE_LINK_MESSAGE } from '@/lib/jobs-board/links';
import { linkedInJobsUrl } from '@/lib/jobs-board/linkedin';
import { plainToStructuredText } from '@/lib/jobs-board/sanitize';
import { companySlug, roleSlug } from '@/lib/jobs-board/slug';
import { normalizeJobFunction } from '@/lib/portfolio/job-taxonomy';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type {
  JobBoardSettings,
  JobCompany,
  JobPosting,
  PortfolioCompany,
} from '@/lib/types/domain';
import { newId, shortHash } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The public job board's data: its switch and text, each portfolio company's
 * job settings, and the roles. Reads never throw and treat missing tables as
 * "board off" (production migrations are applied by hand, so the code can
 * land first); writes say plainly that the migration is needed.
 *
 * Who decides what is public: a person. Emailed roles (from the jobs scan of
 * Nick's mailbox) are imported as drafts and stay off the board until a
 * person approves each one; hand-added roles are approved by the person who
 * adds them; roles read from a company's own public job board appear on
 * their own only after a person turns that company's auto-publish on. The
 * one gate is `postingPublicState` (lib/jobs-board/public.ts), and the
 * database refuses a published, unapproved emailed or hand-added row too.
 *
 * The board sync and the email import are `jobs-board-sync.ts`.
 */

export const JOBS_BOARD_MIGRATION = 'supabase/migrations/20261022100000_public_jobs.sql';
export const JOBS_LINKEDIN_MIGRATION = 'supabase/migrations/20261028100000_jobs_linkedin.sql';

const NEEDS_MIGRATION = `The public job board needs its database tables. Run ${JOBS_BOARD_MIGRATION} in the Supabase SQL editor.`;

export interface JobsActor {
  organizationId: string;
  userId: string | null;
}

type JobTable = 'job_board_settings' | 'job_companies' | 'job_postings';

/** Rows of one board table; null when the table is not there yet. */
async function rowsOf<T extends JobTable>(
  store: DataStore,
  table: T,
  organizationId: string,
  filter?: Parameters<DataStore['list']>[2],
): Promise<Row<T>[] | null> {
  try {
    return await store.list(table, organizationId, filter);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return null;
    throw error;
  }
}

function missing(error: unknown): boolean {
  return isMissingTableError(error) || isMissingColumnError(error);
}

/** A write's failure as a Result: the migration message when a table is missing. */
function failed(error: unknown, what: string): Result<never> {
  if (missing(error)) return err('not_configured', NEEDS_MIGRATION);
  log.error('Job board write failed', { what, reason: (error as Error)?.message?.slice(0, 160) });
  return err('internal', `Could not save ${what}. Nothing was changed; try again.`);
}

/* ---------------------------------------------------------------- reads -- */

export interface JobsBoardData {
  /** False until the migration has run. */
  available: boolean;
  settings: JobBoardSettings | null;
  /** Portfolio companies, archived ones left out. */
  portfolio: PortfolioCompany[];
  companies: JobCompany[];
  postings: JobPosting[];
}

/** Everything the board holds for this organization. Never throws. */
export async function readJobsBoard(
  store: DataStore,
  organizationId: string,
  options: { onlyPublishable?: boolean } = {},
): Promise<JobsBoardData> {
  const empty: JobsBoardData = {
    available: false,
    settings: null,
    portfolio: [],
    companies: [],
    postings: [],
  };
  try {
    const [settings, companies, postings, portfolio] = await Promise.all([
      rowsOf(store, 'job_board_settings', organizationId),
      rowsOf(store, 'job_companies', organizationId),
      rowsOf(
        store,
        'job_postings',
        organizationId,
        options.onlyPublishable ? { eq: { status: 'active', published: true } } : undefined,
      ),
      store.list('portfolio_companies', organizationId, { eq: { is_archived: false } }),
    ]);
    if (!settings || !companies || !postings) return { ...empty, portfolio };
    return {
      available: true,
      settings: settings[0] ?? null,
      portfolio,
      companies,
      postings,
    };
  } catch (error) {
    log.warn('Reading the job board failed', { reason: (error as Error)?.message?.slice(0, 160) });
    return empty;
  }
}

export type PublicBoardRead =
  | { state: 'on'; board: PublicBoard; preview: boolean }
  | { state: 'off' }
  | { state: 'unavailable' };

/**
 * The public board for the public pages: only roles that pass the gate, only
 * public fields. `off` when the board is switched off or its tables are not
 * there; `unavailable` when the database cannot be read (a build without
 * one, an outage). `preview` reads it while it is off, for Kraken's own
 * signed-in preview, never for a public page.
 */
export async function readPublicBoard(
  options: {
    preview?: boolean;
    descriptions?: boolean;
    store?: DataStore;
    organizationId?: string;
  } = {},
): Promise<PublicBoardRead> {
  let store: DataStore;
  let organizationId: string | null;
  try {
    store = options.store ?? getStore();
    organizationId = options.organizationId ?? (await soleOrganizationId('jobs-board'));
  } catch {
    return { state: 'unavailable' };
  }
  if (!organizationId) return { state: 'unavailable' };
  const data = await readJobsBoard(store, organizationId, { onlyPublishable: true });
  if (!data.available) return { state: 'off' };
  if (!data.settings?.enabled && !options.preview) return { state: 'off' };
  const board = buildPublicBoard(
    {
      settings: data.settings,
      portfolio: data.portfolio,
      jobCompanies: data.companies,
      postings: data.postings,
    },
    { descriptions: options.descriptions },
  );
  return { state: 'on', board, preview: Boolean(options.preview) && !data.settings?.enabled };
}

/** The cache tag on the public board's one cached read (readPublicBoardCached). */
export const JOBS_BOARD_CACHE_TAG = 'jobs-board';

class BoardUnreadable extends Error {}

const cachedRead = unstable_cache(
  async (descriptions: boolean): Promise<PublicBoardRead> => {
    const read = await readPublicBoard({ descriptions });
    // Never cache an outage: thrown, so the next visit reads again.
    if (read.state === 'unavailable') throw new BoardUnreadable();
    return read;
  },
  ['jobs-board-public-v1'],
  { tags: [JOBS_BOARD_CACHE_TAG], revalidate: 600 },
);

/**
 * The public board for the public pages, through one shared cache entry
 * (two: with and without descriptions) that expires every ten minutes or the
 * moment Kraken changes the board. The pages that take an address
 * (/<company>, /<company>/<role>) render per request from this entry instead
 * of keeping a cached page per address, so made-up addresses can never fill
 * the server's disk. Public reads only: never the preview.
 */
export async function readPublicBoardCached(descriptions: boolean): Promise<PublicBoardRead> {
  try {
    return await cachedRead(descriptions);
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * Ask Next to rebuild the cached public pages and their data, after anything
 * that changes what they show. Outside a request (a test, a script) there is
 * nothing to rebuild and the call is skipped.
 */
export function revalidatePublicBoard(): void {
  try {
    // Expired at once (not stale-while-revalidate): switching the board off
    // must take the roles down on the very next visit.
    revalidateTag(JOBS_BOARD_CACHE_TAG, { expire: 0 });
  } catch {
    // No request context: nothing cached to drop.
  }
  for (const path of ['/jobs', '/jobs-host']) {
    try {
      revalidatePath(path, 'layout');
    } catch {
      // No request context: nothing cached to drop.
    }
  }
}

/* ------------------------------------------------------------- settings -- */

function settingsRow(organizationId: string, now: string): JobBoardSettings {
  return {
    id: newId(),
    organization_id: organizationId,
    enabled: false,
    title: DEFAULT_BOARD_TITLE,
    intro: null,
    accent: DEFAULT_BOARD_ACCENT,
    updated_by: null,
    created_at: now,
    updated_at: now,
  };
}

async function writeSettings(
  store: DataStore,
  actor: JobsActor,
  patch: Partial<Pick<JobBoardSettings, 'enabled' | 'title' | 'intro' | 'accent'>>,
): Promise<Result<JobBoardSettings>> {
  const now = new Date().toISOString();
  try {
    const existing = await store.findOne('job_board_settings', actor.organizationId, {});
    const row: JobBoardSettings = {
      ...(existing ?? settingsRow(actor.organizationId, now)),
      ...patch,
      updated_by: actor.userId,
      updated_at: now,
    };
    const saved = existing
      ? await store.update('job_board_settings', actor.organizationId, existing.id, row)
      : await store.insert('job_board_settings', row);
    return ok(saved);
  } catch (error) {
    return failed(error, 'the board settings');
  }
}

/** Turn the public board on or off. Off: the public pages say "coming soon" and show nothing. */
export async function setBoardEnabled(
  store: DataStore,
  actor: JobsActor,
  enabled: boolean,
): Promise<Result<JobBoardSettings>> {
  const result = await writeSettings(store, actor, { enabled: Boolean(enabled) });
  if (result.ok) {
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.board_updated',
      entityType: 'job_board',
      entityId: result.value.id,
      metadata: { enabled: result.value.enabled },
    });
  }
  return result;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.slice(0, max);
}

/** The board's title, intro and accent colour. */
export async function saveBoardText(
  store: DataStore,
  actor: JobsActor,
  input: { title?: unknown; intro?: unknown; accent?: unknown },
): Promise<Result<JobBoardSettings>> {
  const title = cleanText(input.title, 120) ?? DEFAULT_BOARD_TITLE;
  const intro = cleanText(input.intro, 600);
  const accent =
    typeof input.accent === 'string' && ACCENT.test(input.accent.trim())
      ? input.accent.trim()
      : null;
  if (input.accent !== undefined && input.accent !== '' && !accent) {
    return err('invalid_input', 'The accent must be a colour like #0FC382.');
  }
  const result = await writeSettings(store, actor, {
    title,
    intro,
    accent: accent ?? DEFAULT_BOARD_ACCENT,
  });
  if (result.ok) {
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.board_updated',
      entityType: 'job_board',
      entityId: result.value.id,
      metadata: { text: true },
    });
  }
  return result;
}

/* ------------------------------------------------------------ companies -- */

async function portfolioCompany(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<PortfolioCompany | null> {
  if (typeof id !== 'string' || !id) return null;
  const company = await store.get('portfolio_companies', organizationId, id);
  return company && !company.is_archived ? company : null;
}

/**
 * A portfolio company's job settings row, made on first need with its board
 * address (slug). Settings start off: no careers page, no sync, no
 * auto-publish, not listed.
 */
export async function ensureJobCompany(
  store: DataStore,
  organizationId: string,
  company: PortfolioCompany,
): Promise<JobCompany> {
  const existing = await store.findOne('job_companies', organizationId, {
    eq: { portfolio_company_id: company.id },
  });
  if (existing) return existing;
  const all = await store.list('job_companies', organizationId);
  const now = new Date().toISOString();
  const row: JobCompany = {
    id: newId(),
    organization_id: organizationId,
    portfolio_company_id: company.id,
    slug: companySlug(company.name, new Set(all.map((c) => c.slug))),
    careers_url: null,
    ats: null,
    ats_token: null,
    sync_enabled: false,
    auto_publish: false,
    listed: false,
    logo_url: null,
    about: null,
    last_sync_at: null,
    last_sync_status: null,
    last_sync_message: null,
    last_sync_count: null,
    created_at: now,
    updated_at: now,
  };
  try {
    return await store.insert('job_companies', row);
  } catch (error) {
    // Made by a parallel request a moment ago: use that one.
    const again = await store.findOne('job_companies', organizationId, {
      eq: { portfolio_company_id: company.id },
    });
    if (again) return again;
    throw error;
  }
}

export interface CompanyJobsInput {
  careersUrl?: string | null;
  /** A board picked by hand, when the address does not show it. */
  ats?: string | null;
  atsToken?: string | null;
  syncEnabled?: boolean;
  autoPublish?: boolean;
  listed?: boolean;
  logoUrl?: string | null;
  about?: string | null;
  /** The company's LinkedIn address (any linkedin.com/company/<slug> link); empty clears it. */
  linkedinUrl?: string | null;
}

export interface CompanyJobsSaved {
  company: JobCompany;
  /** The board read from the careers address, when it changed. */
  detected: AtsBoard | null;
  /** A plain sentence for the person when something needs their eye. */
  note: string | null;
  /** Roles whose public state the auto-publish switch changed. */
  changedRoles: number;
}

function httpsLogo(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.toString().length <= 500
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Save a company's job settings. A new careers address is read for its job
 * board (the address itself, else `detectSource` or `detect`, which fetch the
 * page); a supported board, or a careers page that publishes its roles as
 * JobPosting structured data, turns the daily sync on unless the person said
 * otherwise. Auto-publish on puts that company's open, never-hidden board
 * and careers-page roles on the board; off takes off the ones no person
 * approved one by one. A LinkedIn address is stored as the company's jobs
 * tab link (never fetched); before its migration runs the rest still saves.
 */
export async function saveCompanyJobs(
  store: DataStore,
  actor: JobsActor,
  portfolioCompanyId: string,
  input: CompanyJobsInput,
  options: {
    detect?: (url: string) => Promise<AtsBoard | null>;
    detectSource?: (url: string, companyName: string) => Promise<CareersSource | null>;
  } = {},
): Promise<Result<CompanyJobsSaved>> {
  try {
    const portfolio = await portfolioCompany(store, actor.organizationId, portfolioCompanyId);
    if (!portfolio) return err('not_found', 'That portfolio company is not here any more.');
    const current = await ensureJobCompany(store, actor.organizationId, portfolio);
    const patch: Partial<JobCompany> = {};
    let detected: AtsBoard | null = null;
    let note: string | null = null;

    if (input.careersUrl !== undefined) {
      const raw = (input.careersUrl ?? '').trim();
      if (!raw) {
        Object.assign(patch, {
          careers_url: null,
          ats: null,
          ats_token: null,
          sync_enabled: false,
        });
      } else {
        const url = parseCareersUrl(raw);
        if (!url) return err('invalid_input', 'That careers address is not a web address.');
        patch.careers_url = url.toString();
        detected = detectAtsFromUrl(url.toString());
        let pageRoles = 0;
        if (!detected && options.detectSource) {
          const source = await options
            .detectSource(url.toString(), portfolio.name)
            .catch(() => null);
          detected = source?.board ?? null;
          pageRoles = source?.pageRoles ?? 0;
        } else if (!detected && options.detect) {
          detected = await options.detect(url.toString()).catch(() => null);
        }
        patch.ats = detected?.ats ?? null;
        patch.ats_token = detected?.token ?? null;
        if ((detected || pageRoles > 0) && input.syncEnabled === undefined)
          patch.sync_enabled = true;
        if (!detected && pageRoles > 0) {
          note = `Kraken found ${pageRoles} ${pageRoles === 1 ? 'role' : 'roles'} on that careers page and will read it every day.`;
        } else if (!detected) {
          patch.sync_enabled = false;
          note =
            'Kraken could not find a job board it can read on that page (Greenhouse, Lever, Ashby, Workable or Recruitee), or roles listed in its page data. Roles can still be added by hand.';
        }
      }
    }
    if (input.ats !== undefined) {
      if (input.ats === null || input.ats === '') {
        Object.assign(patch, { ats: null, ats_token: null, sync_enabled: false });
      } else if (isAts(input.ats) && isValidAtsToken(input.ats, input.atsToken ?? null)) {
        Object.assign(patch, { ats: input.ats, ats_token: input.atsToken });
        detected = { ats: input.ats, token: input.atsToken as string };
      } else {
        return err(
          'invalid_input',
          'Pick a job board and type its name as it appears in the board address.',
        );
      }
    }
    const ats = patch.ats !== undefined ? patch.ats : current.ats;
    const careers = patch.careers_url !== undefined ? patch.careers_url : current.careers_url;
    if (input.syncEnabled !== undefined) {
      // A careers page with no supported board is read for its JobPosting data.
      if (input.syncEnabled && !ats && !careers) {
        return err('invalid_input', 'Add a careers page first.');
      }
      patch.sync_enabled = Boolean(input.syncEnabled);
    }
    if (input.autoPublish !== undefined) patch.auto_publish = Boolean(input.autoPublish);
    if (input.listed !== undefined) patch.listed = Boolean(input.listed);
    if (input.logoUrl !== undefined) {
      const raw = (input.logoUrl ?? '').trim();
      if (!raw) patch.logo_url = null;
      else {
        const logo = httpsLogo(raw);
        if (!logo) return err('invalid_input', 'The logo must be an https:// address of an image.');
        patch.logo_url = logo;
      }
    }
    if (input.about !== undefined) patch.about = cleanText(input.about, 600);
    if (input.linkedinUrl !== undefined) {
      const raw = (input.linkedinUrl ?? '').trim();
      if (!raw) patch.linkedin_url = null;
      else {
        const jobs = linkedInJobsUrl(raw);
        if (!jobs) {
          return err(
            'invalid_input',
            'Use the company’s LinkedIn page, like linkedin.com/company/acme-robotics.',
          );
        }
        patch.linkedin_url = jobs;
      }
    }

    const updatedAt = new Date().toISOString();
    let saved: JobCompany;
    try {
      saved = await store.update('job_companies', actor.organizationId, current.id, {
        ...patch,
        updated_at: updatedAt,
      });
    } catch (error) {
      // The LinkedIn column comes from its own migration: before it runs,
      // everything else still saves and the person is told what is missing.
      if (!('linkedin_url' in patch) || !isMissingColumnError(error)) throw error;
      const rest = { ...patch };
      delete rest.linkedin_url;
      saved = await store.update('job_companies', actor.organizationId, current.id, {
        ...rest,
        updated_at: updatedAt,
      });
      note = `The LinkedIn link was not saved: it needs ${JOBS_LINKEDIN_MIGRATION} run in the Supabase SQL editor.`;
    }

    let changedRoles = 0;
    if (patch.auto_publish !== undefined && patch.auto_publish !== current.auto_publish) {
      changedRoles = await applyAutoPublish(store, actor.organizationId, saved);
    }
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.company_updated',
      entityType: 'job_company',
      entityId: saved.id,
      metadata: {
        fields: Object.keys(patch),
        ats: saved.ats,
        sync: saved.sync_enabled,
        autoPublish: saved.auto_publish,
        changedRoles,
      },
    });
    return ok({ company: saved, detected, note, changedRoles });
  } catch (error) {
    return failed(error, "the company's job settings");
  }
}

/**
 * The auto-publish switch's effect on a company's board roles: on publishes
 * every open one a person has not hidden; off unpublishes the ones no person
 * approved individually. Returns how many changed.
 */
export async function applyAutoPublish(
  store: DataStore,
  organizationId: string,
  company: JobCompany,
): Promise<number> {
  const roles = await store.list('job_postings', organizationId, {
    eq: { portfolio_company_id: company.portfolio_company_id, source: 'ats' },
  });
  const now = new Date().toISOString();
  let changed = 0;
  for (const role of roles) {
    const want = company.auto_publish
      ? role.status === 'active' && !role.hidden_at
        ? true
        : role.published
      : role.approved_at
        ? role.published
        : false;
    if (want !== role.published) {
      await store.update('job_postings', organizationId, role.id, {
        published: want,
        updated_at: now,
      });
      changed++;
    }
  }
  return changed;
}

/* ------------------------------------------------------------- postings -- */

async function posting(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<JobPosting | null> {
  if (typeof id !== 'string' || !id) return null;
  return store.get('job_postings', organizationId, id);
}

/**
 * Publish a role: a person's approval, recorded with who and when. Needs an
 * open role with somewhere to apply (its own link or its company's careers
 * page). Clears an earlier hide. An emailed role whose link is on a document
 * host that is often private needs `confirmLink`, after the person checked
 * that anyone can open it. Publishing again also re-confirms that a role is
 * still open (UNCONFIRMED_ROLE_DAYS).
 */
export async function publishPosting(
  store: DataStore,
  actor: JobsActor,
  postingId: string,
  options: { confirmLink?: boolean } = {},
): Promise<Result<JobPosting>> {
  try {
    const role = await posting(store, actor.organizationId, postingId);
    if (!role) return err('not_found', 'That role is not here any more.');
    if (role.status !== 'active')
      return err('conflict', 'That role is closed, so it cannot go on the board.');
    const portfolio = await portfolioCompany(
      store,
      actor.organizationId,
      role.portfolio_company_id,
    );
    if (!portfolio)
      return err('not_found', "That role's company is not in the portfolio any more.");
    const company = await ensureJobCompany(store, actor.organizationId, portfolio);
    if (!applyLinkFor(role, company)) {
      return err(
        'invalid_input',
        'Add an apply link to the role (or a careers page to its company) first.',
      );
    }
    if (role.source === 'email' && isPrivateDocLink(role.apply_url) && !options.confirmLink) {
      return err('conflict', PRIVATE_LINK_MESSAGE, { details: { confirm_link: true } });
    }
    const now = new Date().toISOString();
    const saved = await store.update('job_postings', actor.organizationId, role.id, {
      published: true,
      approved_by: actor.userId,
      approved_at: now,
      hidden_at: null,
      hidden_by: null,
      updated_at: now,
    });
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.role_published',
      entityType: 'job_posting',
      entityId: saved.id,
      metadata: { source: saved.source },
    });
    return ok(saved);
  } catch (error) {
    return failed(error, 'the role');
  }
}

/** Hide a role: off the board, and kept off whatever later syncs read. */
export async function hidePosting(
  store: DataStore,
  actor: JobsActor,
  postingId: string,
): Promise<Result<JobPosting>> {
  try {
    const role = await posting(store, actor.organizationId, postingId);
    if (!role) return err('not_found', 'That role is not here any more.');
    const now = new Date().toISOString();
    const saved = await store.update('job_postings', actor.organizationId, role.id, {
      published: false,
      featured: false,
      hidden_at: now,
      hidden_by: actor.userId,
      updated_at: now,
    });
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.role_hidden',
      entityType: 'job_posting',
      entityId: saved.id,
      metadata: { source: saved.source },
    });
    return ok(saved);
  } catch (error) {
    return failed(error, 'the role');
  }
}

/** Feature a role at the top of the board (shown only while it is public). */
export async function featurePosting(
  store: DataStore,
  actor: JobsActor,
  postingId: string,
  featured: boolean,
): Promise<Result<JobPosting>> {
  try {
    const role = await posting(store, actor.organizationId, postingId);
    if (!role) return err('not_found', 'That role is not here any more.');
    if (featured && role.hidden_at)
      return err('conflict', 'That role is hidden. Publish it first.');
    const saved = await store.update('job_postings', actor.organizationId, role.id, {
      featured: Boolean(featured),
      updated_at: new Date().toISOString(),
    });
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.role_featured',
      entityType: 'job_posting',
      entityId: saved.id,
      metadata: { featured: saved.featured },
    });
    return ok(saved);
  } catch (error) {
    return failed(error, 'the role');
  }
}

/** Close or reopen a hand-added or emailed role (a board's own roles follow their board). */
export async function setPostingOpen(
  store: DataStore,
  actor: JobsActor,
  postingId: string,
  open: boolean,
): Promise<Result<JobPosting>> {
  try {
    const role = await posting(store, actor.organizationId, postingId);
    if (!role) return err('not_found', 'That role is not here any more.');
    if (role.source === 'ats') {
      return err(
        'conflict',
        "This role comes from the company's own job board, which opens and closes it.",
      );
    }
    const now = new Date().toISOString();
    const saved = await store.update('job_postings', actor.organizationId, role.id, {
      status: open ? 'active' : 'closed',
      closed_at: open ? null : now,
      updated_at: now,
    });
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.role_saved',
      entityType: 'job_posting',
      entityId: saved.id,
      metadata: { status: saved.status },
    });
    return ok(saved);
  } catch (error) {
    return failed(error, 'the role');
  }
}

export interface PostingInput {
  portfolioCompanyId?: string;
  title?: string;
  team?: string | null;
  fn?: string | null;
  /** Places, separated by ';' or new lines, or a list. */
  locations?: string | string[] | null;
  remote?: string | null;
  employmentType?: string | null;
  seniority?: string | null;
  comp?: string | null;
  description?: string | null;
  applyUrl?: string | null;
  /** Hand-added only: publish straight away (the person adding it approves it). */
  publish?: boolean;
}

function placesFrom(value: PostingInput['locations']): string[] {
  // A place is "City, ST", so a comma never separates two of them.
  const parts = Array.isArray(value) ? value : (value ?? '').split(/[;\n|]/);
  const out: string[] = [];
  for (const part of parts) {
    const place = cleanText(part, 120);
    if (place && !out.some((p) => p.toLowerCase() === place.toLowerCase())) out.push(place);
  }
  return out.slice(0, 10);
}

function applyUrlFrom(value: string | null | undefined): string | null | 'invalid' {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const url = parseCareersUrl(raw);
  return url && url.toString().length <= 800 ? url.toString() : 'invalid';
}

/**
 * Add a role by hand, or edit a hand-added or emailed one (a board's own
 * roles are read from the board and are not edited here). An edit never
 * changes a role's address, and never its approval.
 */
export async function savePosting(
  store: DataStore,
  actor: JobsActor,
  input: PostingInput,
  postingId?: string,
): Promise<Result<JobPosting>> {
  try {
    const existing = postingId ? await posting(store, actor.organizationId, postingId) : null;
    if (postingId && !existing) return err('not_found', 'That role is not here any more.');
    if (existing?.source === 'ats') {
      return err('conflict', "This role comes from the company's own job board; edit it there.");
    }
    const title = cleanText(input.title ?? existing?.title, 200);
    if (!title) return err('invalid_input', 'Give the role a title.');
    const companyId = existing?.portfolio_company_id ?? input.portfolioCompanyId ?? '';
    const portfolio = await portfolioCompany(store, actor.organizationId, companyId);
    if (!portfolio) return err('invalid_input', 'Pick the portfolio company the role is at.');
    const applyUrl = applyUrlFrom(input.applyUrl);
    if (applyUrl === 'invalid')
      return err('invalid_input', 'The apply link must be a web address.');
    const team = cleanText(input.team, 120);
    const remote = normalizeJobRemote(input.remote ?? null);
    const fields = {
      title,
      team,
      job_function: input.fn ? normalizeJobFunction(input.fn) : guessFunction(title, team),
      locations: placesFrom(input.locations),
      remote,
      employment_type: isEmploymentType(input.employmentType) ? input.employmentType : null,
      seniority: isSeniority(input.seniority) ? input.seniority : guessSeniority(title),
      comp: cleanText(input.comp, 160),
      description: plainToStructuredText(input.description ?? '') || null,
      apply_url: applyUrl,
    } satisfies Partial<JobPosting>;
    const now = new Date().toISOString();

    if (existing) {
      const saved = await store.update('job_postings', actor.organizationId, existing.id, {
        ...fields,
        updated_at: now,
      });
      await recordAudit(store, {
        organizationId: actor.organizationId,
        userId: actor.userId,
        action: 'jobs.role_saved',
        entityType: 'job_posting',
        entityId: saved.id,
        metadata: { source: saved.source, edited: true },
      });
      return ok(saved);
    }

    const company = await ensureJobCompany(store, actor.organizationId, portfolio);
    const sourceKey = newId();
    const publish = Boolean(input.publish);
    if (publish && !applyLinkFor({ apply_url: fields.apply_url }, company)) {
      return err(
        'invalid_input',
        'Add an apply link (or a careers page for the company) to publish it.',
      );
    }
    const row: JobPosting = {
      id: newId(),
      organization_id: actor.organizationId,
      portfolio_company_id: portfolio.id,
      source: 'manual',
      source_key: sourceKey,
      slug: roleSlug(title, shortHash(`manual:${sourceKey}`, 6)),
      ...fields,
      posted_at: now,
      source_updated_at: null,
      status: 'active',
      published: publish,
      featured: false,
      approved_by: publish ? actor.userId : null,
      approved_at: publish ? now : null,
      hidden_by: null,
      hidden_at: null,
      first_seen_at: now,
      last_seen_at: now,
      closed_at: null,
      created_at: now,
      updated_at: now,
    };
    const saved = await store.insert('job_postings', row);
    await recordAudit(store, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      action: 'jobs.role_saved',
      entityType: 'job_posting',
      entityId: saved.id,
      metadata: { source: 'manual', published: publish, companyId: company.id },
    });
    return ok(saved);
  } catch (error) {
    return failed(error, 'the role');
  }
}
