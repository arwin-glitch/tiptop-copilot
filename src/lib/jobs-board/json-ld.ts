import type { JobEmploymentType } from '@/lib/types/domain';
import type { PublicCompany, PublicJob } from './public';
import { parseStructuredText } from './sanitize';

/**
 * A role's JobPosting structured data (schema.org), which Google for Jobs
 * reads. Pure. Built only from the public fields, and serialised with every
 * `<` escaped, so the script tag that carries it can never be closed early
 * by anything a job board wrote.
 *
 * Google's rules decide when there is none at all (null): a posting needs a
 * real description that is also on the page (never invented text), and a
 * place it can read (a city with its country) or, for a remote role, the
 * countries applicants may live in. A role that cannot meet that gets no
 * structured data rather than markup Google would flag.
 */

const EMPLOYMENT: Record<JobEmploymentType, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
  temporary: 'TEMPORARY',
};

/** Shorter than this and Google treats a description as incomplete. */
export const MIN_DESCRIPTION_CHARS = 150;

const US_STATES = new Set(
  (
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
    'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'
  ).split(' '),
);
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));

/** Country names a place may end with -> ISO 3166-1 alpha-2. */
const COUNTRIES: Record<string, string> = {
  us: 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'united states': 'US',
  'united states of america': 'US',
  canada: 'CA',
  uk: 'GB',
  'u.k.': 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  scotland: 'GB',
  ireland: 'IE',
  germany: 'DE',
  france: 'FR',
  spain: 'ES',
  portugal: 'PT',
  netherlands: 'NL',
  'the netherlands': 'NL',
  sweden: 'SE',
  poland: 'PL',
  switzerland: 'CH',
  israel: 'IL',
  india: 'IN',
  singapore: 'SG',
  australia: 'AU',
  'new zealand': 'NZ',
  mexico: 'MX',
  brazil: 'BR',
  argentina: 'AR',
  colombia: 'CO',
  philippines: 'PH',
  japan: 'JP',
};

export interface ParsedPlace {
  locality: string | null;
  region: string | null;
  country: string;
}

const SETUP_SUFFIX = /\s*[([]\s*(hybrid|remote|on-?site|in[- ]office)\s*[)\]]\s*$/i;

function countryOf(text: string): string | null {
  return COUNTRIES[text.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

/** Whether a place names remote work rather than a city ("Remote", "Remote - US", "US (Remote)"). */
export function isRemotePlace(place: string): boolean {
  return /\bremote\b/i.test(place) && !SETUP_SUFFIX.test(place);
}

/**
 * A place as a postal address Google can read: "Austin, TX" (US state),
 * "Toronto, ON" (Canadian province), "Berlin, Germany", "London, UK",
 * "Denver, CO, USA", or a country on its own. Null for anything else, which
 * is then left out rather than guessed.
 */
export function parsePlace(raw: string): ParsedPlace | null {
  const place = raw.replace(SETUP_SUFFIX, '').replace(/\s+/g, ' ').trim();
  if (!place || place.length > 120 || isRemotePlace(place)) return null;
  const parts = place.split(',').map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  if (parts.length === 1) {
    const country = countryOf(parts[0]!);
    return country ? { locality: null, region: null, country } : null;
  }
  let country: string | null = null;
  if (parts.length >= 3 || (parts.length === 2 && countryOf(parts[1]!))) {
    country = countryOf(parts.at(-1)!);
    if (!country) return null;
    parts.pop();
  }
  const [city, region] = parts as [string, string | undefined];
  if (parts.length > 2) return null;
  if (region) {
    const code = region.toUpperCase();
    if (US_STATES.has(code) && (!country || country === 'US')) {
      return { locality: city, region: code, country: 'US' };
    }
    if (CA_PROVINCES.has(code) && (!country || country === 'CA')) {
      return { locality: city, region: code, country: 'CA' };
    }
    return null;
  }
  return country ? { locality: city, region: null, country } : null;
}

/** The countries a remote role's places name ("Remote - US", "Remote (Canada)"). */
function remoteCountries(places: readonly string[]): string[] {
  const out = new Set<string>();
  for (const place of places) {
    if (!isRemotePlace(place)) continue;
    const words = place
      .replace(/\bremote\b/i, ' ')
      .replace(/[()[\]\-–—:/|]/g, ',')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    for (const word of words) {
      const country = countryOf(word);
      if (country) out.add(country);
    }
  }
  return [...out];
}

export interface ParsedPay {
  currency: string;
  min: number;
  max: number;
  unit: 'HOUR' | 'WEEK' | 'MONTH' | 'YEAR';
}

/**
 * A pay line as a range Google can read: "$190K – $220K / year",
 * "$150,000 - $180,000", "USD 60-75/hr", "€70k". Null unless it parses
 * cleanly (a currency, one or two sensible amounts).
 */
export function parsePay(comp: string | null | undefined): ParsedPay | null {
  if (!comp || comp.length > 160) return null;
  const text = comp.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const currency = /\b(cad|c\$)/.test(text)
    ? 'CAD'
    : /\b(aud|a\$)/.test(text)
      ? 'AUD'
      : /\$|\busd\b/.test(text)
        ? 'USD'
        : /€|\beur\b/.test(text)
          ? 'EUR'
          : /£|\bgbp\b/.test(text)
            ? 'GBP'
            : null;
  if (!currency) return null;
  const unit = /\b(hour|hr|hourly)\b|\/\s*h\b/.test(text)
    ? 'HOUR'
    : /\b(week|weekly|wk)\b/.test(text)
      ? 'WEEK'
      : /\b(month|monthly|mo)\b/.test(text)
        ? 'MONTH'
        : 'YEAR';
  const amounts: number[] = [];
  for (const m of text.matchAll(
    /(\$|€|£|usd|eur|gbp|cad|aud)?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b(?!\s*%)/g,
  )) {
    const [, symbol, digits, scale] = m;
    let value = Number(digits);
    if (scale === 'k') value *= 1_000;
    if (scale === 'm') value *= 1_000_000;
    // A bare small number (a percentage of equity, "0.5") is not pay.
    if (!symbol && !scale && value < 1_000 && unit === 'YEAR') continue;
    if (Number.isFinite(value) && value > 0) amounts.push(value);
    if (amounts.length === 2) break;
  }
  if (amounts.length === 0) return null;
  const min = amounts[0]!;
  const max = amounts[1] ?? min;
  if (max < min) return null;
  const [low, high] =
    unit === 'HOUR'
      ? [5, 1_000]
      : unit === 'WEEK'
        ? [200, 40_000]
        : unit === 'MONTH'
          ? [800, 200_000]
          : [10_000, 5_000_000];
  if (min < low || max > high) return null;
  return { currency, min, max, unit };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The description as the simple HTML Google asks for, every word escaped; null when empty. */
export function descriptionHtml(text: string | null | undefined): string | null {
  const blocks = parseStructuredText(text);
  if (blocks.length === 0) return null;
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

function descriptionLength(text: string | null | undefined): number {
  return parseStructuredText(text)
    .map((b) => (b.kind === 'list' ? b.items.join(' ') : b.text))
    .join(' ').length;
}

/** The role's JobPosting, or null when it cannot meet Google's required fields (see above). */
export function jobPostingJsonLd(
  job: PublicJob,
  company: PublicCompany | null,
  pageUrl: string,
): Record<string, unknown> | null {
  const description = descriptionHtml(job.description);
  if (!description || descriptionLength(job.description) < MIN_DESCRIPTION_CHARS) return null;

  const places = job.locations.map(parsePlace).filter((p): p is ParsedPlace => p !== null);
  const remote = job.remote === 'remote';
  if (places.length === 0 && !remote) return null;

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description,
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
  if (job.validThrough) data.validThrough = job.validThrough;
  if (job.employmentType) data.employmentType = EMPLOYMENT[job.employmentType];
  if (places.length > 0) {
    data.jobLocation = places.map((place) => ({
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        ...(place.locality ? { addressLocality: place.locality } : {}),
        ...(place.region ? { addressRegion: place.region } : {}),
        addressCountry: place.country,
      },
    }));
  }
  if (remote) {
    data.jobLocationType = 'TELECOMMUTE';
    const named = remoteCountries(job.locations);
    const countries =
      named.length > 0
        ? named
        : places.length > 0
          ? [...new Set(places.map((p) => p.country))]
          : // TipTop's portfolio hires in the US unless a role says otherwise.
            ['US'];
    data.applicantLocationRequirements = countries.map((name) => ({ '@type': 'Country', name }));
  }
  const pay = parsePay(job.comp);
  if (pay) {
    data.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: pay.currency,
      value: {
        '@type': 'QuantitativeValue',
        ...(pay.min === pay.max ? { value: pay.min } : { minValue: pay.min, maxValue: pay.max }),
        unitText: pay.unit,
      },
    };
  }
  return data;
}

/** JSON for a `<script type="application/ld+json">`, with `<` escaped. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
