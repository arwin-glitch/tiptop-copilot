import type { JobEmploymentType } from '@/lib/types/domain';
import type { PublicCompany, PublicJob } from './public';
import { parseStructuredText } from './sanitize';

/**
 * A role's JobPosting structured data (schema.org), which Google for Jobs
 * reads. Pure. Built only from the public fields, and serialised with every
 * `<` escaped, so the script tag that carries it can never be closed early
 * by anything a job board wrote.
 */

const EMPLOYMENT: Record<JobEmploymentType, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
  temporary: 'TEMPORARY',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The description as the simple HTML Google asks for, every word escaped. */
export function descriptionHtml(text: string | null | undefined, fallback: string): string {
  const blocks = parseStructuredText(text);
  if (blocks.length === 0) return `<p>${escapeHtml(fallback)}</p>`;
  return blocks
    .map((b) =>
      b.kind === 'heading'
        ? `<h3>${escapeHtml(b.text)}</h3>`
        : b.kind === 'list'
          ? `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
          : `<p>${escapeHtml(b.text).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

export function jobPostingJsonLd(
  job: PublicJob,
  company: PublicCompany | null,
  pageUrl: string,
): Record<string, unknown> {
  const places = job.locations.filter((l) => !/^remote\b/i.test(l.trim()));
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: descriptionHtml(
      job.description,
      `${job.title} at ${job.companyName}. Apply on ${job.companyName}'s careers page.`,
    ),
    url: pageUrl,
    directApply: false,
    identifier: { '@type': 'PropertyValue', name: job.companyName, value: job.key },
    hiringOrganization: {
      '@type': 'Organization',
      name: job.companyName,
      ...(company?.website ? { sameAs: company.website } : {}),
      ...(company?.logoUrl ? { logo: company.logoUrl } : {}),
    },
  };
  if (job.postedAt) data.datePosted = job.postedAt.slice(0, 10);
  if (job.employmentType) data.employmentType = EMPLOYMENT[job.employmentType];
  if (places.length > 0) {
    data.jobLocation = places.map((place) => ({
      '@type': 'Place',
      address: { '@type': 'PostalAddress', addressLocality: place },
    }));
  }
  if (job.remote === 'remote') data.jobLocationType = 'TELECOMMUTE';
  return data;
}

/** JSON for a `<script type="application/ld+json">`, with `<` escaped. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
