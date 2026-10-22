import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { cache } from 'react';
import { canonicalBoardUrl } from '@/lib/jobs-board/config';
import {
  EMPLOYMENT_TYPE_LABELS,
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  SENIORITY_LABELS,
  placeLine,
} from '@/lib/jobs-board/fields';
import { jobPostingJsonLd } from '@/lib/jobs-board/json-ld';
import {
  companyPath,
  homePath,
  jobPath,
  type PublicBoard,
  type PublicCompany,
  type PublicJob,
} from '@/lib/jobs-board/public';
import { descriptionSummary, parseStructuredText } from '@/lib/jobs-board/sanitize';
import { readPublicBoard, type PublicBoardRead } from '@/lib/services/jobs-board';
import { BoardBrowser } from './browser';
import {
  ArrowRight,
  CompanyLogo,
  ExternalIcon,
  JobRow,
  JsonLd,
  TipTopMark,
  jobChips,
  postedDate,
} from './parts';
import { ShareButtons } from './share';
import { BoardShell } from './shell';

/**
 * The public board's pages, shared by its three addresses:
 *   - `/jobs` on Copilot's own host (base "/jobs"),
 *   - the root of jobs.tiptop.vc (base "", the `/jobs-host` routes the
 *     proxy rewrites to),
 *   - `/jobs-preview` (base "/jobs-preview"), signed-in only, which shows
 *     the board while it is still switched off.
 * Each route file is a few lines that call these with its base.
 *
 * Every page reads the board once per request (React `cache`), and the
 * public routes are cached by Next and rebuilt every ten minutes or as soon
 * as a person changes something in Copilot (revalidatePublicBoard).
 */

export interface BoardPageOptions {
  base: string;
  preview?: boolean;
}

const readBoard = cache(async (descriptions: boolean, preview: boolean): Promise<PublicBoardRead> =>
  unlessBuildCannotRead(await readPublicBoard({ descriptions, preview })),
);

/**
 * A build with no database to read (a CI or local build) must not bake a
 * "taking a moment" page into the cache: the page is rendered per request
 * instead (connection() marks it dynamic). A build that can read the
 * database, as on Render, caches the pages as usual.
 */
async function unlessBuildCannotRead(read: PublicBoardRead): Promise<PublicBoardRead> {
  if (read.state === 'unavailable' && process.env.NEXT_PHASE === 'phase-production-build') {
    await connection();
  }
  return read;
}

function canonical(path: string, preview?: boolean): string | undefined {
  return preview ? undefined : canonicalBoardUrl(path);
}

const OFF_METADATA: Metadata = {
  title: { absolute: 'TipTop VC Jobs: coming soon' },
  description: 'Open roles at TipTop VC portfolio companies, coming soon.',
  robots: { index: false, follow: false },
};

function pageRobots(preview?: boolean): Metadata['robots'] {
  return preview ? { index: false, follow: false } : { index: true, follow: true };
}

/* ----------------------------------------------------------- pieces -- */

export function ComingSoon({ base, state }: { base: string; state: 'off' | 'unavailable' }) {
  return (
    <BoardShell base={base} board={null} active={null}>
      <section className="jb-wrap jb-soon">
        <div>
          <TipTopMark />
          <p className="jb-eyebrow">TipTop VC · Portfolio jobs</p>
          <h1>Our job board is coming soon.</h1>
          <p>
            {state === 'off'
              ? 'Open roles at the companies TipTop backs will be listed here. Check back shortly.'
              : 'The job board is taking a moment to load. Try again in a minute.'}
          </p>
          <a className="jb-btn jb-btn-ghost" href="https://www.tiptop.vc">
            Visit tiptop.vc
          </a>
        </div>
      </section>
    </BoardShell>
  );
}

function DescriptionView({ text }: { text: string | null }) {
  const blocks = parseStructuredText(text);
  if (blocks.length === 0) return null;
  return (
    <div className="jb-desc">
      {blocks.map((block, i) =>
        block.kind === 'heading' ? (
          <h2 key={i}>{block.text}</h2>
        ) : block.kind === 'list' ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </div>
  );
}

function FeatureCard({
  job,
  company,
  base,
}: {
  job: PublicJob;
  company: PublicCompany | undefined;
  base: string;
}) {
  return (
    <Link href={jobPath(base, job)} className="jb-feature" prefetch={false}>
      <span className="jb-card-top" style={{ marginBottom: 0 }}>
        <CompanyLogo name={job.companyName} logoUrl={company?.logoUrl} />
        <span className="jb-muted">{job.companyName}</span>
      </span>
      <h3>{job.title}</h3>
      <span className="jb-chips" style={{ marginTop: 0 }}>
        {jobChips(job).map((chip) => (
          <span key={chip} className="jb-chip">
            {chip}
          </span>
        ))}
      </span>
    </Link>
  );
}

function CompanyCard({ company, base }: { company: PublicCompany; base: string }) {
  return (
    <Link href={companyPath(base, company.slug)} className="jb-card" prefetch={false}>
      <span className="jb-card-top">
        <CompanyLogo name={company.name} logoUrl={company.logoUrl} />
        <span>
          <h3>{company.name}</h3>
          {company.sector ? (
            <span className="jb-muted" style={{ fontSize: 13 }}>
              {company.sector}
            </span>
          ) : null}
        </span>
      </span>
      <p>{company.about ?? `${company.name} is a TipTop VC portfolio company.`}</p>
      <span className="jb-card-cta">
        <span className="jb-card-count">{company.openRoles}</span> open{' '}
        {company.openRoles === 1 ? 'role' : 'roles'} <ArrowRight />
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------- home -- */

export async function boardHomeMetadata({ preview }: BoardPageOptions): Promise<Metadata> {
  const read = await readBoard(false, Boolean(preview));
  if (read.state !== 'on') return OFF_METADATA;
  const { board } = read;
  const description = `${board.jobs.length} open ${board.jobs.length === 1 ? 'role' : 'roles'} at ${board.companies.length} TipTop VC portfolio ${board.companies.length === 1 ? 'company' : 'companies'}. Apply directly with each company.`;
  return {
    title: { absolute: `${board.title} | TipTop VC` },
    description,
    robots: pageRobots(preview),
    alternates: { canonical: canonical('', preview) },
    openGraph: {
      title: board.title,
      description,
      url: canonical('', preview),
      siteName: 'TipTop VC',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title: board.title, description },
  };
}

export async function BoardHomePage({ base, preview }: BoardPageOptions) {
  const read = await readBoard(false, Boolean(preview));
  if (read.state !== 'on') return <ComingSoon base={base} state={read.state} />;
  const { board } = read;
  const companyBySlug = new Map(board.companies.map((c) => [c.slug, c]));
  const featured = board.jobs.filter((j) => j.featured).slice(0, 6);
  const remote = board.jobs.filter((j) => j.remote === 'remote').length;

  return (
    <BoardShell base={base} board={board} active="jobs" preview={read.preview}>
      <section className="jb-wrap jb-hero">
        <p className="jb-eyebrow">TipTop VC · Portfolio jobs</p>
        <h1>{board.title}</h1>
        <p className="jb-hero-sub">
          {board.intro ??
            'Open roles at the companies TipTop backs, from first hires to leadership. Every role links straight to the company to apply.'}
        </p>
        <ul className="jb-stats" aria-label="The board in numbers">
          <li className="jb-stat">
            <span className="jb-stat-num">{board.jobs.length}</span>
            <span className="jb-stat-label">open {board.jobs.length === 1 ? 'role' : 'roles'}</span>
          </li>
          <li className="jb-stat">
            <span className="jb-stat-num">{board.companies.length}</span>
            <span className="jb-stat-label">
              {board.companies.length === 1 ? 'company' : 'companies'}
            </span>
          </li>
          {remote > 0 ? (
            <li className="jb-stat">
              <span className="jb-stat-num">{remote}</span>
              <span className="jb-stat-label">remote</span>
            </li>
          ) : null}
        </ul>
      </section>

      {featured.length > 0 ? (
        <section className="jb-wrap jb-section" aria-labelledby="featured-roles">
          <div className="jb-section-head">
            <h2 id="featured-roles">Featured roles</h2>
          </div>
          <ul className="jb-featured" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {featured.map((job) => (
              <li key={job.key}>
                <FeatureCard job={job} company={companyBySlug.get(job.companySlug)} base={base} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="jb-wrap">
        {board.jobs.length === 0 ? (
          <div className="jb-empty" style={{ margin: '24px 0 48px' }}>
            <h2>No open roles right now</h2>
            <p>New roles at TipTop companies show up here as soon as they open. Check back soon.</p>
          </div>
        ) : (
          <BoardBrowser jobs={board.jobs} companies={board.companies} base={base} />
        )}
      </div>
    </BoardShell>
  );
}

/* -------------------------------------------------------- companies -- */

export async function companiesMetadata({ preview }: BoardPageOptions): Promise<Metadata> {
  const read = await readBoard(false, Boolean(preview));
  if (read.state !== 'on') return OFF_METADATA;
  const title = 'TipTop VC portfolio companies hiring';
  const description = `${read.board.companies.length} TipTop VC portfolio companies and their open roles.`;
  return {
    title: { absolute: `${title} | TipTop VC` },
    description,
    robots: pageRobots(preview),
    alternates: { canonical: canonical('/companies', preview) },
    openGraph: { title, description, url: canonical('/companies', preview), siteName: 'TipTop VC' },
  };
}

export async function CompaniesPage({ base, preview }: BoardPageOptions) {
  const read = await readBoard(false, Boolean(preview));
  if (read.state !== 'on') return <ComingSoon base={base} state={read.state} />;
  const { board } = read;
  return (
    <BoardShell base={base} board={board} active="companies" preview={read.preview}>
      <section className="jb-wrap jb-page">
        <p className="jb-eyebrow">TipTop VC · Portfolio</p>
        <h1 style={{ fontSize: 'clamp(30px, 6vw, 44px)', marginBottom: 10 }}>Companies hiring</h1>
        <p className="jb-hero-sub">
          The TipTop VC portfolio companies on the board, and how many roles each has open.
        </p>
        {board.companies.length === 0 ? (
          <div className="jb-empty">
            <h2>No companies listed yet</h2>
          </div>
        ) : (
          <ul className="jb-grid" aria-label="Companies">
            {board.companies.map((company) => (
              <li key={company.slug}>
                <CompanyCard company={company} base={base} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </BoardShell>
  );
}

/* ---------------------------------------------------------- company -- */

function findCompany(board: PublicBoard, slug: string) {
  return board.companies.find((c) => c.slug === slug) ?? null;
}

export async function companyMetadata(
  options: BoardPageOptions & { slug: string },
): Promise<Metadata> {
  const read = await readBoard(false, Boolean(options.preview));
  if (read.state !== 'on') return OFF_METADATA;
  const company = findCompany(read.board, options.slug);
  if (!company)
    return { title: { absolute: 'Not found | TipTop VC Jobs' }, robots: { index: false } };
  const title = `Jobs at ${company.name}`;
  const description =
    `${company.openRoles} open ${company.openRoles === 1 ? 'role' : 'roles'} at ${company.name}, a TipTop VC portfolio company.${company.about ? ` ${company.about}` : ''}`.slice(
      0,
      300,
    );
  const path = `/${company.slug}`;
  return {
    title: { absolute: `${title} | TipTop VC` },
    description,
    robots: pageRobots(options.preview),
    alternates: { canonical: canonical(path, options.preview) },
    openGraph: { title, description, url: canonical(path, options.preview), siteName: 'TipTop VC' },
  };
}

export async function CompanyPage({ base, preview, slug }: BoardPageOptions & { slug: string }) {
  const read = await readBoard(false, Boolean(preview));
  if (read.state !== 'on') return <ComingSoon base={base} state={read.state} />;
  const { board } = read;
  const company = findCompany(board, slug);
  if (!company) notFound();
  const jobs = board.jobs.filter((j) => j.companySlug === company.slug);
  return (
    <BoardShell base={base} board={board} active="companies" preview={read.preview}>
      <section className="jb-wrap jb-page">
        <Link href={`${base}/companies`} className="jb-back">
          ← All companies
        </Link>
        <div className="jb-company-hero">
          <CompanyLogo name={company.name} logoUrl={company.logoUrl} size="lg" />
          <div>
            <p className="jb-eyebrow">{company.sector ?? 'TipTop VC portfolio'}</p>
            <h1>{company.name}</h1>
            {company.about ? <p style={{ marginTop: 10 }}>{company.about}</p> : null}
          </div>
        </div>
        <div className="jb-company-links" style={{ marginBottom: 24 }}>
          {company.website ? (
            <a
              className="jb-btn jb-btn-ghost jb-btn-small"
              href={company.website}
              target="_blank"
              rel="noopener noreferrer"
            >
              {company.domain ?? 'Website'} <ExternalIcon />
            </a>
          ) : null}
        </div>
        <div className="jb-section-head">
          <h2 id="company-roles">
            {jobs.length} open {jobs.length === 1 ? 'role' : 'roles'}
          </h2>
        </div>
        {jobs.length === 0 ? (
          <div className="jb-empty">
            <h3>No open roles right now</h3>
            <p>{company.name} has nothing open on the board today. Check back soon.</p>
          </div>
        ) : (
          <ul className="jb-jobs" aria-labelledby="company-roles">
            {jobs.map((job) => (
              <li key={job.key}>
                <JobRow job={job} company={company} base={base} showCompany={false} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </BoardShell>
  );
}

/* -------------------------------------------------------------- job -- */

function findJob(board: PublicBoard, companySlug: string, roleSlug: string) {
  return board.jobs.find((j) => j.companySlug === companySlug && j.slug === roleSlug) ?? null;
}

export async function jobMetadata(
  options: BoardPageOptions & { companySlug: string; roleSlug: string },
): Promise<Metadata> {
  const read = await readBoard(true, Boolean(options.preview));
  if (read.state !== 'on') return OFF_METADATA;
  const job = findJob(read.board, options.companySlug, options.roleSlug);
  if (!job) return { title: { absolute: 'Not found | TipTop VC Jobs' }, robots: { index: false } };
  const title = `${job.title} at ${job.companyName}`;
  const place = placeLine(job.locations, job.remote);
  const description =
    descriptionSummary(job.description, 180) ||
    `${title}${place ? `, ${place}` : ''}. A TipTop VC portfolio company. Apply on ${job.companyName}'s careers page.`;
  const path = `/${job.companySlug}/${job.slug}`;
  return {
    title: { absolute: `${title} | TipTop VC Jobs` },
    description,
    robots: pageRobots(options.preview),
    alternates: { canonical: canonical(path, options.preview) },
    openGraph: {
      title,
      description,
      url: canonical(path, options.preview),
      siteName: 'TipTop VC',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export async function JobPage({
  base,
  preview,
  companySlug,
  roleSlug,
}: BoardPageOptions & { companySlug: string; roleSlug: string }) {
  const read = await readBoard(true, Boolean(preview));
  if (read.state !== 'on') return <ComingSoon base={base} state={read.state} />;
  const { board } = read;
  const job = findJob(board, companySlug, roleSlug);
  if (!job) notFound();
  const company = findCompany(board, job.companySlug) ?? undefined;
  const more = board.jobs
    .filter((j) => j.companySlug === job.companySlug && j.key !== job.key)
    .slice(0, 5);
  const url = canonicalBoardUrl(`/${job.companySlug}/${job.slug}`);
  const posted = postedDate(job.postedAt);
  const facts: [string, string][] = [];
  const place = placeLine(job.locations, null);
  if (place) facts.push(['Location', place]);
  if (job.remote) facts.push(['Work setup', JOB_REMOTE_LABELS[job.remote]]);
  if (job.fn !== 'other') facts.push(['Team', job.team ?? JOB_FUNCTION_LABELS[job.fn]]);
  else if (job.team) facts.push(['Team', job.team]);
  if (job.seniority) facts.push(['Level', SENIORITY_LABELS[job.seniority]]);
  if (job.employmentType) facts.push(['Type', EMPLOYMENT_TYPE_LABELS[job.employmentType]]);
  if (job.comp) facts.push(['Pay', job.comp]);
  if (posted) facts.push(['Posted', posted]);

  return (
    <BoardShell base={base} board={board} active="jobs" preview={read.preview}>
      <JsonLd data={jobPostingJsonLd(job, company ?? null, url)} />
      <article className="jb-wrap jb-page">
        <Link href={homePath(base)} className="jb-back">
          ← All open roles
        </Link>
        <div className="jb-detail">
          <div>
            <div className="jb-detail-head">
              <CompanyLogo name={job.companyName} logoUrl={company?.logoUrl} size="lg" />
              <div>
                <p className="jb-eyebrow">
                  <Link href={companyPath(base, job.companySlug)} className="jb-detail-company">
                    {job.companyName}
                  </Link>
                </p>
                <h1>{job.title}</h1>
              </div>
            </div>
            <div className="jb-chips" style={{ marginBottom: 24 }}>
              {job.featured ? <span className="jb-chip jb-chip-accent">Featured</span> : null}
              {jobChips(job).map((chip) => (
                <span key={chip} className="jb-chip">
                  {chip}
                </span>
              ))}
            </div>
            {job.description ? (
              <DescriptionView text={job.description} />
            ) : (
              <p className="jb-muted">
                {job.companyName} shares the full description on its own careers page. Use the apply
                button to read it and apply.
              </p>
            )}
          </div>
          <aside className="jb-side-card" aria-label="Apply">
            <ul className="jb-facts">
              <li>
                <span>Company</span>
                <span>{job.companyName}</span>
              </li>
              {facts.map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <span>{value}</span>
                </li>
              ))}
            </ul>
            <a
              className="jb-btn jb-btn-primary jb-btn-block"
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Apply at {job.companyName} <ExternalIcon />
            </a>
            <p className="jb-apply-note">
              You apply on {job.companyName}&rsquo;s own careers page.
            </p>
            <ShareButtons url={url} title={`${job.title} at ${job.companyName}`} />
          </aside>
        </div>

        {more.length > 0 ? (
          <section className="jb-section" aria-labelledby="more-roles" style={{ marginTop: 32 }}>
            <div className="jb-section-head">
              <h2 id="more-roles">More roles at {job.companyName}</h2>
              <Link href={companyPath(base, job.companySlug)} className="jb-count-note">
                See all
              </Link>
            </div>
            <ul className="jb-jobs" aria-labelledby="more-roles">
              {more.map((other) => (
                <li key={other.key}>
                  <JobRow job={other} company={company} base={base} showCompany={false} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>
    </BoardShell>
  );
}

/* ----------------------------------------------------------- sitemap -- */

/** The board's sitemap: home, companies, each company and each role, at their canonical addresses. */
export async function boardSitemapXml(): Promise<string> {
  const read = await unlessBuildCannotRead(await readPublicBoard());
  const urls: { loc: string; lastmod?: string }[] = [];
  if (read.state === 'on') {
    urls.push({ loc: canonicalBoardUrl('') }, { loc: canonicalBoardUrl('/companies') });
    for (const company of read.board.companies)
      urls.push({ loc: canonicalBoardUrl(`/${company.slug}`) });
    for (const job of read.board.jobs) {
      urls.push({
        loc: canonicalBoardUrl(`/${job.companySlug}/${job.slug}`),
        lastmod: job.postedAt?.slice(0, 10),
      });
    }
  }
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = urls
    .map(
      (u) =>
        `  <url><loc>${escape(u.loc)}</loc>${u.lastmod ? `<lastmod>${escape(u.lastmod)}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
