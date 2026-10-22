/**
 * Addresses on the public board: /jobs/<company>/<role>. Pure and
 * client-safe; the short suffix that keeps two roles with one title apart is
 * hashed by the service (server-side) and passed in.
 */

/** Words a company's address can never be: they are the board's own pages. */
export const RESERVED_COMPANY_SLUGS = new Set([
  'companies',
  'company',
  'jobs',
  'job',
  'search',
  'sitemap',
  'sitemap.xml',
  'robots',
  'robots.txt',
  'feed',
  'rss',
  'api',
  'about',
  'preview',
  'opengraph-image',
  'twitter-image',
  'icon',
  'apple-icon',
  'favicon',
  'manifest',
  '_next',
]);

const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;

/** "Café Robotics, Inc." -> "cafe-robotics-inc", at most `max` characters, cut at a dash. */
export function slugify(text: string, max = 60, fallback = 'item'): string {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = base;
  if (slug.length > max) {
    const cut = slug.lastIndexOf('-', max);
    slug = slug.slice(0, cut > max / 2 ? cut : max).replace(/-+$/g, '');
  }
  return slug || fallback;
}

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

/** A company's address, kept clear of the board's own pages and of the ones taken. */
export function companySlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name, 60, 'company');
  let slug = RESERVED_COMPANY_SLUGS.has(base) ? `${base}-co` : base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** A role's address under its company: the title's words and a short stable suffix. */
export function roleSlug(title: string, suffix: string): string {
  const clean =
    suffix
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || '0';
  return `${slugify(title, 80, 'role')}-${clean}`;
}
