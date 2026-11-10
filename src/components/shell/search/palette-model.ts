/**
 * Pure pieces of the Ctrl+K palette (no React, no fetch): the result shape,
 * the Affinity-style tabs, bold-match splitting, logo domains, preview keys,
 * and the normalising of the preview and Harmonic responses. Kept apart so
 * they can be unit-tested without rendering.
 */

export type ResultKind =
  | 'deal'
  | 'portfolio'
  | 'lp'
  | 'person'
  | 'meeting'
  | 'task'
  | 'document'
  | 'crm_list'
  | 'crm_company'
  | 'crm_person'
  | 'crm_note'
  | 'space'
  | 'harmonic_person'
  | 'harmonic_company'
  | 'lookup'
  | 'harmonic_lookup';

export interface PreviewKey {
  kind: string;
  key: string;
}

export interface Result {
  kind: ResultKind;
  label: string;
  sub: string | null;
  href: string;
  recordId?: string;
  /** Lowercased query words the server found in this result. */
  matched?: string[];
  domain?: string | null;
  preview?: PreviewKey;
  /** A hit from the palette's own Harmonic look-up (never kept in recents). */
  origin?: 'harmonic';
}

/* ---------------------------------------------------------------- tabs */

export type TabId = 'top' | 'companies' | 'people' | 'deals' | 'lists' | 'notes' | 'meetings';

export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'top', label: 'Top Matches' },
  { id: 'companies', label: 'Companies' },
  { id: 'people', label: 'People' },
  { id: 'deals', label: 'Deals' },
  { id: 'lists', label: 'Lists' },
  { id: 'notes', label: 'Notes' },
  { id: 'meetings', label: 'Meetings' },
];

const TAB_KINDS: Record<Exclude<TabId, 'top'>, ReadonlySet<ResultKind>> = {
  companies: new Set(['crm_company', 'portfolio', 'deal', 'harmonic_company']),
  people: new Set(['person', 'crm_person', 'lp', 'harmonic_person']),
  deals: new Set(['deal']),
  lists: new Set(['crm_list']),
  notes: new Set(['crm_note', 'meeting', 'document']),
  meetings: new Set(['meeting']),
};

/** Look-up rows (Harmonic page, LinkedIn, Google) are actions, not matches. */
export function isLookupRow(result: Result): boolean {
  return result.kind === 'lookup' || result.kind === 'harmonic_lookup';
}

export function inTab(result: Result, tab: TabId): boolean {
  if (tab === 'top') return true;
  return TAB_KINDS[tab].has(result.kind);
}

export function filterTab(rows: readonly Result[], tab: TabId): Result[] {
  return rows.filter((r) => inTab(r, tab));
}

/** Matches per tab; look-up rows are never counted. */
export function tabCounts(rows: readonly Result[]): Record<TabId, number> {
  const counts = Object.fromEntries(TABS.map((t) => [t.id, 0])) as Record<TabId, number>;
  for (const r of rows) {
    if (isLookupRow(r)) continue;
    for (const t of TABS) if (inTab(r, t.id)) counts[t.id] += 1;
  }
  return counts;
}

export function nextTab(current: TabId, step: 1 | -1): TabId {
  const i = TABS.findIndex((t) => t.id === current);
  return TABS[(i + step + TABS.length) % TABS.length]!.id;
}

/* ---------------------------------------------------------------- bold matches */

export function queryWords(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[\s,]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    ),
  );
}

export interface Segment {
  text: string;
  match: boolean;
}

/**
 * Splits text into plain and matched runs, case-insensitively, for rendering
 * as React nodes (never HTML). Overlapping words merge into one bold run.
 */
export function highlightSegments(text: string, words: readonly string[]): Segment[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (!w) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      for (let i = at; i < at + w.length && i < marks.length; i++) marks[i] = true;
      from = at + 1;
    }
  }
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.match === marks[i]) last.text += text[i];
    else out.push({ text: text[i]!, match: marks[i]! });
  }
  return out;
}

/* ---------------------------------------------------------------- logos */

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidDomain(value: unknown): value is string {
  return typeof value === 'string' && DOMAIN.test(value);
}

/** A bare host from a domain, URL or email; null unless it validates. */
export function cleanDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (v.includes('@')) v = v.slice(v.lastIndexOf('@') + 1);
  v = v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  v = v.split(/[/?#:\s]/)[0] ?? '';
  return isValidDomain(v) ? v : null;
}

export function faviconUrl(domain: string | null | undefined): string | null {
  const d = cleanDomain(domain);
  return d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64` : null;
}

const COMPANY_KINDS: ReadonlySet<ResultKind> = new Set([
  'crm_company',
  'harmonic_company',
  'portfolio',
  'deal',
]);

export function isCompanyKind(kind: ResultKind): boolean {
  return COMPANY_KINDS.has(kind);
}

/** The domain a company row's logo comes from. People get initials instead. */
export function logoDomainOf(result: Result): string | null {
  if (!isCompanyKind(result.kind)) return null;
  const given = cleanDomain(result.domain ?? null);
  if (given) return given;
  const first = result.sub?.split(/\s*[•·|,]\s*/)[0] ?? null;
  return first && !first.includes(' ') ? cleanDomain(first) : null;
}

export function initials(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

/* ---------------------------------------------------------------- previews */

/** Which preview card a row asks for, or null for a simple card. */
export function previewKeyOf(result: Result): PreviewKey | null {
  if (result.preview?.kind && result.preview.key) return result.preview;
  if (
    (result.kind === 'crm_company' || result.kind === 'crm_person' || result.kind === 'crm_note') &&
    result.recordId
  ) {
    return { kind: 'crm', key: result.recordId };
  }
  let url: URL;
  try {
    url = new URL(result.href, 'https://kraken.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://kraken.invalid') return null;
  if (
    result.kind === 'person' &&
    url.pathname === '/network' &&
    url.searchParams.get('source') === 'mail'
  ) {
    const email = url.searchParams.get('q');
    return email && email.includes('@') ? { kind: 'mail', key: email } : null;
  }
  const portfolio = /^\/portfolio\/([^/]+)$/.exec(url.pathname);
  if (result.kind === 'portfolio' && portfolio) {
    return { kind: 'portfolio', key: decodeURIComponent(portfolio[1]!) };
  }
  const deal = /^\/deals\/([^/]+)$/.exec(url.pathname);
  if (result.kind === 'deal' && deal) return { kind: 'deal', key: decodeURIComponent(deal[1]!) };
  return null;
}

export function previewCacheKey(key: PreviewKey): string {
  return `${key.kind}:${key.key}`;
}

/** Each Harmonic preview spends a look-up, so it waits until a row has settled. */
export function isHarmonicPreview(key: PreviewKey): boolean {
  return key.kind.startsWith('harmonic');
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface PreviewCard {
  kind: string;
  title: string;
  subtitle: string | null;
  logoDomain: string | null;
  avatarText: string | null;
  status: { label: string; tone: Tone } | null;
  description: string | null;
  counts: { label: string; value: number | string }[];
  lastContact: { at: string | null; text: string | null } | null;
  facts: { label: string; value: string }[];
  links: { label: string; href: string; external: boolean }[];
  openHref: string | null;
  source: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'bad', 'neutral']);

/** Only in-app paths and http(s) URLs are ever linked. */
export function safeHref(href: unknown): string | null {
  const h = str(href);
  if (!h) return null;
  if (h.startsWith('/') && !h.startsWith('//')) return h;
  try {
    const u = new URL(h);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Accepts the server's {ok, card} (the card may sit beside the old `preview`
 * of a CRM record), the card bare, or {preview}; null if unusable.
 */
export function normalizePreviewCard(body: unknown): PreviewCard | null {
  if (!body || typeof body !== 'object') return null;
  const outer = body as Record<string, unknown>;
  if (outer.ok === false) return null;
  const raw = (
    outer.card && typeof outer.card === 'object'
      ? outer.card
      : outer.preview && typeof outer.preview === 'object'
        ? outer.preview
        : outer
  ) as Record<string, unknown>;
  const title = str(raw.title);
  if (!title) return null;
  const status = raw.status as { label?: unknown; tone?: unknown } | null | undefined;
  const last = raw.lastContact as { at?: unknown; text?: unknown } | null | undefined;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    kind: str(raw.kind) ?? 'record',
    title,
    subtitle: str(raw.subtitle),
    logoDomain: cleanDomain(str(raw.logoDomain)),
    avatarText: str(raw.avatarText),
    status:
      status && str(status.label)
        ? {
            label: status.label as string,
            tone: TONES.has(status.tone as string) ? (status.tone as Tone) : 'neutral',
          }
        : null,
    description: str(raw.description),
    counts: arr(raw.counts)
      .filter((c) => str(c?.label) && (typeof c.value === 'number' || typeof c.value === 'string'))
      .map((c) => ({ label: c.label as string, value: c.value as number | string })),
    lastContact:
      last && (str(last.at) || str(last.text)) ? { at: str(last.at), text: str(last.text) } : null,
    facts: arr(raw.facts)
      .filter((f) => str(f?.label) && str(f?.value))
      .map((f) => ({ label: f.label as string, value: f.value as string })),
    links: arr(raw.links).flatMap((l) => {
      const href = safeHref(l?.href);
      const label = str(l?.label);
      return href && label ? [{ label, href, external: !href.startsWith('/') }] : [];
    }),
    openHref: safeHref(raw.openHref),
    source: str(raw.source),
  };
}

/* ---------------------------------------------------------------- Harmonic */

export interface HarmonicHit {
  urn?: string;
  kind: 'person' | 'company' | 'investor';
  id: string;
  name: string;
  headline?: string | null;
  linkedin?: string | null;
  website?: string | null;
}

export function harmonicHitToResult(hit: HarmonicHit): Result | null {
  if (!hit || typeof hit !== 'object' || !str(hit.name) || !str(String(hit.id ?? ''))) return null;
  const person = hit.kind === 'person';
  return {
    kind: person ? 'harmonic_person' : 'harmonic_company',
    label: hit.name,
    sub: str(hit.headline) ?? (person ? null : cleanDomain(hit.website ?? null)),
    href: `/network/harmonic?q=${encodeURIComponent(hit.name)}`,
    domain: person ? null : cleanDomain(hit.website ?? null),
    // An investor's details need Harmonic's paid Deal Data add-on, so it gets
    // the simple card (no look-up spent) instead of a preview fetch.
    ...(hit.kind === 'investor'
      ? {}
      : {
          preview: { kind: person ? 'harmonic_person' : 'harmonic_company', key: String(hit.id) },
        }),
    origin: 'harmonic',
  };
}

export interface HarmonicAnswer {
  hits: Result[];
  remaining: number | null;
  /** Not connected or out of look-ups: stop asking for this session. */
  off: boolean;
}

const OFF_CODE = /not[_-]?connected|unconnected|rate|limit|quota|exhaust|used[_-]?up/i;

export function readHarmonicAnswer(status: number, body: unknown): HarmonicAnswer {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const remaining = typeof b.remaining === 'number' ? b.remaining : null;
  const off =
    status === 429 ||
    status === 401 ||
    status === 403 ||
    b.connected === false ||
    (typeof b.code === 'string' && OFF_CODE.test(b.code)) ||
    remaining === 0;
  const hits =
    b.ok !== false && Array.isArray(b.hits)
      ? (b.hits as HarmonicHit[]).flatMap((h) => {
          const r = harmonicHitToResult(h);
          return r ? [r] : [];
        })
      : [];
  return { hits, remaining, off };
}
