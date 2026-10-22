import {
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  normalizeJobFunction,
  normalizeJobRemote,
  type JobFunction,
  type JobRemote,
} from '@/lib/portfolio/job-taxonomy';
import type { JobEmploymentType, JobSeniority } from '@/lib/types/domain';

/**
 * The public job board's fields, their labels, and the guesses that fill them
 * from what a job board or a founder's email says. Pure and client-safe: the
 * board's filters run in the browser on the same rules.
 */

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
] as const satisfies readonly JobEmploymentType[];

export const EMPLOYMENT_TYPE_LABELS: Record<JobEmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
};

export const SENIORITIES = [
  'intern',
  'entry',
  'mid',
  'senior',
  'staff',
  'lead',
  'manager',
  'director',
  'vp',
  'executive',
] as const satisfies readonly JobSeniority[];

export const SENIORITY_LABELS: Record<JobSeniority, string> = {
  intern: 'Intern',
  entry: 'Entry level',
  mid: 'Mid level',
  senior: 'Senior',
  staff: 'Staff / Principal',
  lead: 'Lead',
  manager: 'Manager',
  director: 'Director',
  vp: 'VP',
  executive: 'Executive',
};

export {
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  normalizeJobRemote,
  type JobFunction,
  type JobRemote,
};

export function isEmploymentType(value: unknown): value is JobEmploymentType {
  return typeof value === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(value);
}

export function isSeniority(value: unknown): value is JobSeniority {
  return typeof value === 'string' && (SENIORITIES as readonly string[]).includes(value);
}

/**
 * "Full-time", "FullTime", "fulltime_permanent", "Intern", "Contractor" ->
 * one of EMPLOYMENT_TYPES, or null when it says nothing this knows.
 */
export function normalizeEmploymentType(raw: unknown): JobEmploymentType | null {
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return null;
  if (key.startsWith('intern')) return 'internship';
  if (key.startsWith('fulltime') || key === 'permanent' || key === 'regular') return 'full_time';
  if (key.startsWith('parttime')) return 'part_time';
  if (key.startsWith('contract') || key === 'freelance' || key === 'consultant') return 'contract';
  if (key.startsWith('temp') || key === 'seasonal') return 'temporary';
  return null;
}

/**
 * A level read from a title: "Senior Backend Engineer" -> senior, "VP Sales"
 * -> vp, "Head of Growth" -> director. A guess, shown as one; null when the
 * title says nothing (most "Software Engineer" titles).
 */
export function guessSeniority(title: string, hint?: string | null): JobSeniority | null {
  const text = ` ${`${hint ?? ''} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const has = (...words: string[]) => words.some((w) => text.includes(` ${w} `));
  if (has('intern', 'internship', 'co op', 'coop')) return 'intern';
  if (has('chief', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cro', 'cpo', 'founder', 'co founder'))
    return 'executive';
  if (has('vp', 'svp', 'evp', 'vice president')) return 'vp';
  if (has('director', 'head')) return 'director';
  if (has('principal', 'staff', 'distinguished')) return 'staff';
  if (has('lead', 'tech lead')) return 'lead';
  if (has('manager', 'mgr')) return 'manager';
  if (has('senior', 'sr', 'snr', 'iii', 'iv')) return 'senior';
  if (has('junior', 'jr', 'entry', 'graduate', 'new grad', 'associate', 'i')) return 'entry';
  if (has('mid', 'ii', 'intermediate')) return 'mid';
  return null;
}

const TITLE_FUNCTION_WORDS: [RegExp, JobFunction][] = [
  [/\b(designer|design|ux|ui)\b/, 'design'],
  [/\b(data|analytics|analyst|machine learning|ml|ai|scientist)\b/, 'data'],
  [/\b(product manager|product owner|product lead|head of product|pm)\b/, 'product'],
  [
    /\b(engineer|engineering|developer|devops|sre|architect|firmware|software|frontend|backend|full ?stack|qa)\b/,
    'engineering',
  ],
  [/\b(account executive|sales|sdr|bdr|business development|partnerships|revenue)\b/, 'sales'],
  [/\b(marketing|growth|brand|content|seo|communications|pr|demand gen)\b/, 'marketing'],
  [/\b(customer success|support|account manager|implementation|onboarding)\b/, 'customer_success'],
  [/\b(finance|accountant|accounting|controller|fp&a|bookkeeper)\b/, 'finance'],
  [/\b(recruiter|recruiting|talent|people|hr|human resources)\b/, 'people'],
  [/\b(counsel|legal|paralegal|compliance)\b/, 'legal'],
  [/\b(operations|ops|logistics|supply chain|program manager|chief of staff)\b/, 'operations'],
];

/**
 * A role's function from its team name and title: the team when it names a
 * known function ("Engineering", "GTM"), else the title's words.
 */
export function guessFunction(title: string, team?: string | null): JobFunction {
  if (team) {
    const fromTeam = normalizeJobFunction(team);
    if (fromTeam !== 'other') return fromTeam;
  }
  // A leader still has a function ("VP Sales" is sales), so titles are read
  // by their words alone; a bare "CEO" or "Founder" reads as leadership.
  const lower = title.toLowerCase();
  for (const [pattern, fn] of TITLE_FUNCTION_WORDS) if (pattern.test(lower)) return fn;
  if (/\b(chief|ceo|founder|general manager|president)\b/.test(lower)) return 'leadership';
  return 'other';
}

/** "Remote", "Remote - US", "Hybrid (NYC)" in a place name -> remote / hybrid, else null. */
export function remoteFromPlace(place: string | null | undefined): JobRemote | null {
  if (!place) return null;
  const lower = place.toLowerCase();
  if (/\bremote\b|\banywhere\b|\bdistributed\b/.test(lower)) return 'remote';
  if (/\bhybrid\b/.test(lower)) return 'hybrid';
  return null;
}

/** "$120K – $150K / year" from a range, or null. Whole thousands are shortened. */
export function formatPayRange(input: {
  min?: unknown;
  max?: unknown;
  currency?: unknown;
  interval?: unknown;
}): string | null {
  const min = typeof input.min === 'number' && Number.isFinite(input.min) ? input.min : null;
  const max = typeof input.max === 'number' && Number.isFinite(input.max) ? input.max : null;
  if (min === null && max === null) return null;
  const currency =
    typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency.toUpperCase())
      ? input.currency.toUpperCase()
      : 'USD';
  const symbol: Record<string, string> = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£', AUD: 'A$' };
  const money = (n: number) => {
    const prefix = symbol[currency] ?? `${currency} `;
    if (n >= 1000 && n % 1000 === 0) return `${prefix}${n / 1000}K`;
    if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return `${prefix}${n.toLocaleString('en-US')}`;
  };
  const range =
    min !== null && max !== null && min !== max
      ? `${money(min)} – ${money(max)}`
      : money((min ?? max) as number);
  const interval = typeof input.interval === 'string' ? input.interval.toLowerCase() : '';
  const per = /year|annual|1 year|yearly/.test(interval)
    ? ' / year'
    : /month/.test(interval)
      ? ' / month'
      : /hour/.test(interval)
        ? ' / hour'
        : '';
  return `${range}${per}`.slice(0, 160);
}

/** "Austin, TX · Remote" from a role's places and remote setting. */
export function placeLine(locations: readonly string[], remote: JobRemote | null): string | null {
  const places = locations.filter(Boolean);
  const parts = [...places.slice(0, 2)];
  if (places.length > 2) parts.push(`+${places.length - 2} more`);
  const label = remote ? JOB_REMOTE_LABELS[remote] : null;
  if (label && !places.some((p) => p.toLowerCase().includes(label.toLowerCase())))
    parts.push(label);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function functionLabel(fn: string): string {
  return JOB_FUNCTION_LABELS[normalizeJobFunction(fn)];
}
