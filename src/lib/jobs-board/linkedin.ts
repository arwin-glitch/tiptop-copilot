/**
 * A company's LinkedIn jobs link, for the public board's "See roles on
 * LinkedIn". Kraken never fetches or reads LinkedIn (it needs a sign-in, and
 * its terms forbid automated reading): the board only links to the
 * company's own jobs tab, built from the company's LinkedIn address.
 *
 * Accepted: `linkedin.com/company/<slug>` with or without `www.` or a
 * country subdomain (`uk.linkedin.com`), scheme, a trailing path
 * (`/jobs/`, `/about/`) or a query. Anything else (a person's profile, a
 * single job, another host) is not a company jobs link. Pure and client-safe.
 */

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const HOST = /^(?:(?:www|[a-z]{2})\.)?linkedin\.com$/;

/** `https://www.linkedin.com/company/<slug>/jobs/` from a LinkedIn company address; null otherwise. */
export function linkedInJobsUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 300 || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  if (!HOST.test(url.hostname.toLowerCase())) return null;
  const path = url.pathname.split('/').filter(Boolean);
  if (path[0]?.toLowerCase() !== 'company') return null;
  const slug = path[1];
  if (!slug || !SLUG.test(slug)) return null;
  return `https://www.linkedin.com/company/${slug.toLowerCase()}/jobs/`;
}

/** Whether a stored value is exactly a jobs link this file would build. */
export function isLinkedInJobsUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && linkedInJobsUrl(value) === value;
}
