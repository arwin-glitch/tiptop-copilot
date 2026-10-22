import Link from 'next/link';
import {
  EMPLOYMENT_TYPE_LABELS,
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  SENIORITY_LABELS,
  placeLine,
} from '@/lib/jobs-board/fields';
import { serializeJsonLd } from '@/lib/jobs-board/json-ld';
import { jobPath, type PublicCompany, type PublicJob } from '@/lib/jobs-board/public';

/**
 * Small pieces the public board's pages share. No hooks, so they render on
 * the server and inside the browser-side filter alike. Every value is text.
 */

/** TipTop's mark, drawn inline in the board's accent colour. */
export function TipTopMark({ className = 'jb-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 139 84" fill="currentColor" aria-hidden="true">
      <path d="M66.2955 26.3643L42.7802 83.8142L20.8093 83.8148L47.122 19.2074H6.98452L0 0H54.6497L66.2955 26.3643Z" />
      <path d="M72.3906 26.3643L95.9059 83.8142L117.877 83.8148L91.564 19.2074H131.702L138.686 0H84.0363L72.3906 26.3643Z" />
    </svg>
  );
}

export function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A company's logo when a person gave one, else its first letter. */
export function CompanyLogo({
  name,
  logoUrl,
  size = 'md',
}: {
  name: string;
  logoUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass = size === 'lg' ? ' jb-logo-lg' : size === 'sm' ? ' jb-logo-sm' : '';
  if (logoUrl) {
    return (
      <span className={`jb-logo${sizeClass}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a person-supplied
            https logo; next/image would need every company's host allow-listed. */}
        <img src={logoUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      </span>
    );
  }
  const letter = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span className={`jb-logo jb-logo-letter${sizeClass}`} aria-hidden="true">
      {letter}
    </span>
  );
}

/** "Oct 18" (in UTC, so a cached page never disagrees with itself). */
/** "Oct 1", with the year when it is not this year ("Dec 12, 2025"). */
export function postedDate(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/** A role's short facts as chips: place, remote, level, type. */
export function jobChips(job: PublicJob): string[] {
  const chips: string[] = [];
  const place = placeLine(job.locations, null);
  if (place) chips.push(place);
  if (job.remote && !(place ?? '').toLowerCase().includes(job.remote))
    chips.push(JOB_REMOTE_LABELS[job.remote]);
  if (job.seniority) chips.push(SENIORITY_LABELS[job.seniority]);
  if (job.employmentType && job.employmentType !== 'full_time') {
    chips.push(EMPLOYMENT_TYPE_LABELS[job.employmentType]);
  }
  return chips;
}

export function JobRow({
  job,
  company,
  base,
  showCompany = true,
}: {
  job: PublicJob;
  company: PublicCompany | undefined;
  base: string;
  showCompany?: boolean;
}) {
  const posted = postedDate(job.postedAt);
  const fn = job.fn !== 'other' ? JOB_FUNCTION_LABELS[job.fn] : null;
  return (
    <Link href={jobPath(base, job)} className="jb-job" prefetch={false}>
      <CompanyLogo name={job.companyName} logoUrl={company?.logoUrl} />
      <span className="jb-job-body">
        <span className="jb-job-title">{job.title}</span>
        <span className="jb-job-company">
          {showCompany ? job.companyName : null}
          {showCompany && fn ? ' · ' : null}
          {fn}
        </span>
        <span className="jb-chips">
          {job.featured ? <span className="jb-chip jb-chip-accent">Featured</span> : null}
          {jobChips(job).map((chip) => (
            <span key={chip} className="jb-chip">
              {chip}
            </span>
          ))}
          {job.comp ? <span className="jb-chip">{job.comp}</span> : null}
        </span>
      </span>
      <span className="jb-job-side">
        {posted ? <span>{posted}</span> : null}
        <ArrowRight className="jb-arrow" />
      </span>
    </Link>
  );
}

/**
 * Structured data for search engines (JobPosting). JSON built only from the
 * public fields, with every "<" escaped by serializeJsonLd, so it can never
 * close its script tag or become markup.
 */
export function JsonLd({ data }: { data: unknown }) {
  const json = { __html: serializeJsonLd(data) };
  // eslint-disable-next-line no-restricted-syntax -- escaped JSON, not HTML; see above.
  return <script type="application/ld+json" dangerouslySetInnerHTML={json} />;
}
