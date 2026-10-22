/**
 * The words a role is described in: its function (team), remote setting and
 * title, with the rules that read a routine's or a job board's words into
 * them. Pure, with no zod and no server imports, so the public job board's
 * filters can run in the browser on the same rules (lib/jobs-board/). The
 * jobs snapshot's own module (jobs.ts) re-exports all of it.
 */

export const JOB_FUNCTIONS = [
  'engineering',
  'product',
  'design',
  'data',
  'sales',
  'marketing',
  'customer_success',
  'operations',
  'finance',
  'people',
  'legal',
  'leadership',
  'other',
] as const;
export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export const JOB_FUNCTION_LABELS: Record<JobFunction, string> = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  data: 'Data & ML',
  sales: 'Sales',
  marketing: 'Marketing',
  customer_success: 'Customer success',
  operations: 'Operations',
  finance: 'Finance',
  people: 'People & recruiting',
  legal: 'Legal',
  leadership: 'Leadership',
  other: 'Other',
};

/** Words a routine might use for a function, mapped to the list above. */
const FUNCTION_ALIASES: Record<string, JobFunction> = {
  eng: 'engineering',
  engineer: 'engineering',
  software: 'engineering',
  devops: 'engineering',
  hardware: 'engineering',
  pm: 'product',
  ux: 'design',
  ml: 'data',
  ai: 'data',
  data_science: 'data',
  machine_learning: 'data',
  gtm: 'sales',
  business_development: 'sales',
  bd: 'sales',
  growth: 'marketing',
  cs: 'customer_success',
  support: 'customer_success',
  customer_support: 'customer_success',
  ops: 'operations',
  accounting: 'finance',
  hr: 'people',
  recruiting: 'people',
  talent: 'people',
  executive: 'leadership',
  exec: 'leadership',
  c_level: 'leadership',
};

export const JOB_REMOTE = ['remote', 'hybrid', 'onsite'] as const;
export type JobRemote = (typeof JOB_REMOTE)[number];
export const JOB_REMOTE_LABELS: Record<JobRemote, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

/** Any casing or spacing of a function, its aliases, or anything else as "other". */
export function normalizeJobFunction(raw: unknown): JobFunction {
  if (typeof raw !== 'string') return 'other';
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if ((JOB_FUNCTIONS as readonly string[]).includes(key)) return key as JobFunction;
  return FUNCTION_ALIASES[key] ?? FUNCTION_ALIASES[key.split('_')[0] ?? ''] ?? 'other';
}

/** "Remote", "on-site", "In office", true/false -> one of JOB_REMOTE, or null when unsaid. */
export function normalizeJobRemote(raw: unknown): JobRemote | null {
  if (raw === true) return 'remote';
  if (raw === false) return 'onsite';
  if (typeof raw !== 'string') return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, '');
  if (key.startsWith('remote')) return 'remote';
  if (key.startsWith('hybrid')) return 'hybrid';
  if (['onsite', 'inoffice', 'office', 'inperson', 'onprem'].includes(key)) return 'onsite';
  return null;
}

/**
 * The title as the dedupe key reads it: lowercase, a parenthetical dropped
 * ("(Remote)", "(NYC)"), common abbreviations spelled out, punctuation gone.
 * "Sr. Backend Eng (Remote)" and "Senior Backend Engineer" are one role.
 */
export function normalizeJobTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => TITLE_WORDS[word] ?? word)
    .join(' ');
}

const TITLE_WORDS: Record<string, string> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  eng: 'engineer',
  engr: 'engineer',
  mgr: 'manager',
  dir: 'director',
  swe: 'software engineer',
};
