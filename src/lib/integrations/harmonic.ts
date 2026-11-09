import 'server-only';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';

/**
 * Harmonic (TipTop's people and company data plan), so Ctrl+K finds people
 * and companies nobody at the fund has met yet, as Affinity does.
 *
 * The key (HARMONIC_API_KEY) is read only here, on the server, and sent only
 * to api.harmonic.ai in its `apikey` header; never logged, never returned to
 * a page. Unset, every call returns nothing and the rest of search is
 * unchanged. Answers are kept ten minutes per query, so typing the same name
 * twice costs one call.
 */

export const HARMONIC_BASE = 'https://api.harmonic.ai';
const TIMEOUT_MS = 2_400;
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 300;

export type HarmonicKind = 'person' | 'company';

export interface HarmonicHit {
  kind: HarmonicKind;
  /** The id in the entity's URN (urn:harmonic:person:123 → "123"). */
  id: string;
  name: string;
  sub: string | null;
}

export function harmonicConfigured(): boolean {
  return !!env().harmonicApiKey;
}

/** "urn:harmonic:person:123" → { kind: 'person', id: '123' }; anything else → null. */
export function parseHarmonicUrn(urn: string): { kind: HarmonicKind; id: string } | null {
  const m = /^urn:harmonic:(person|company):([A-Za-z0-9_-]{1,40})$/.exec(urn.trim());
  return m ? { kind: m[1] as HarmonicKind, id: m[2]! } : null;
}

const cache = new Map<string, { at: number; hits: HarmonicHit[] }>();

/** For the tests. */
export function resetHarmonicCache(): void {
  cache.clear();
  pausedUntil = 0;
}

/**
 * Harmonic answers 429 "no allocated API calls" when the plan has no API
 * allowance. Then it is not asked again for an hour, so search does not wait
 * on a refusal every keystroke.
 */
let pausedUntil = 0;
const PAUSE_MS = 60 * 60_000;

async function call(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const key = env().harmonicApiKey;
  if (!key || Date.now() < pausedUntil) return null;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${HARMONIC_BASE}${path}${qs ? `?${qs}` : ''}`, {
    headers: { apikey: key, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 402) pausedUntil = Date.now() + PAUSE_MS;
    log.warn('Harmonic call failed', { status: res.status, path });
    return null;
  }
  return res.json();
}

interface TypeaheadRow {
  entity_urn?: unknown;
  text?: unknown;
  alt_text?: unknown;
}

/**
 * People and companies whose name matches the query, from Harmonic's
 * type-ahead search. Never throws: no key, a refusal or a slow answer is an
 * empty list.
 */
export async function harmonicTypeahead(
  query: string,
  options: { size?: number; now?: number } = {},
): Promise<HarmonicHit[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < 2 || !harmonicConfigured()) return [];
  const size = options.size ?? 6;
  const now = options.now ?? Date.now();
  const cacheKey = `${q.toLowerCase()}|${size}`;
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_MS) return cached.hits;

  let failed = false;
  const one = async (type: 'PERSON' | 'COMPANY'): Promise<TypeaheadRow[]> => {
    try {
      const body = (await call('/search/typeahead', {
        query: q,
        search_type: type,
      })) as { results?: TypeaheadRow[] } | null;
      if (!body) failed = true;
      return Array.isArray(body?.results) ? body.results.slice(0, size) : [];
    } catch (error) {
      failed = true;
      log.warn('Harmonic search failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return [];
    }
  };
  const [people, companies] = await Promise.all([one('PERSON'), one('COMPANY')]);
  const hits: HarmonicHit[] = [];
  for (const row of [...people, ...companies]) {
    const parsed = typeof row.entity_urn === 'string' ? parseHarmonicUrn(row.entity_urn) : null;
    const name = typeof row.text === 'string' ? row.text.trim() : '';
    if (!parsed || !name) continue;
    const alt = typeof row.alt_text === 'string' ? row.alt_text.trim() : '';
    hits.push({ ...parsed, name, sub: alt && alt !== name ? alt.slice(0, 120) : null });
  }
  // A failed call is not remembered, so the next keystroke tries again.
  if (!failed) {
    cache.set(cacheKey, { at: now, hits });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return hits;
}

/**
 * What Harmonic answers for one query, for the signed-in check route: status
 * codes, counts and the first result's URN and text. Never the key.
 */
export async function harmonicCheck(query: string): Promise<Record<string, unknown>> {
  const key = env().harmonicApiKey;
  if (!key) return { configured: false };
  const out: Record<string, unknown> = { configured: true };
  for (const type of ['PERSON', 'COMPANY'] as const) {
    const started = Date.now();
    try {
      const res = await fetch(
        `${HARMONIC_BASE}/search/typeahead?${new URLSearchParams({ query, search_type: type })}`,
        {
          headers: { apikey: key, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
          cache: 'no-store',
        },
      );
      const raw = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Not JSON; the length below says enough.
      }
      const results = (obj(body)?.results as unknown[] | undefined) ?? [];
      const first = obj(results[0]);
      out[type] = {
        status: res.status,
        ms: Date.now() - started,
        count: Array.isArray(results) ? results.length : null,
        keys: first ? Object.keys(first) : obj(body) ? Object.keys(obj(body)!) : null,
        firstUrn: first?.entity_urn ?? null,
        firstText: first?.text ?? null,
        firstAlt: first?.alt_text ?? null,
        error: res.ok ? null : raw.slice(0, 200),
      };
    } catch (error) {
      out[type] = {
        error: error instanceof Error ? error.name : 'unknown',
        ms: Date.now() - started,
      };
    }
  }
  return out;
}

/* ------------------------------------------------------------- profiles */

export interface HarmonicProfile {
  kind: HarmonicKind;
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  linkedin: string | null;
  website: string | null;
  description: string | null;
  /** A person's current roles ("Title at Company"); a company's size and stage. */
  lines: string[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A LinkedIn URL wherever Harmonic puts it: socials.LINKEDIN.url, linkedin_url, … */
function linkedinOf(row: Record<string, unknown>): string | null {
  const socials = obj(row.socials);
  const fromSocials = socials ? text(obj(socials.LINKEDIN ?? socials.linkedin)?.url) : null;
  const url = fromSocials ?? text(row.linkedin_url) ?? text(row.linkedin);
  return url && /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(url) ? url : null;
}

function locationOf(row: Record<string, unknown>): string | null {
  const loc = obj(row.location);
  if (!loc) return text(row.location);
  return (
    text(loc.location) ??
    ([text(loc.city), text(loc.state), text(loc.country)].filter(Boolean).join(', ') || null)
  );
}

/** Read one person or company. Fields are read defensively: a missing one is left out. */
export async function harmonicProfile(
  kind: HarmonicKind,
  id: string,
): Promise<HarmonicProfile | null> {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  let raw: unknown;
  try {
    raw = await call(kind === 'person' ? `/persons/${id}` : `/companies/${id}`);
  } catch {
    return null;
  }
  const row = obj(raw);
  if (!row) return null;
  const name = text(row.full_name) ?? text(row.name);
  if (!name) return null;
  const lines: string[] = [];
  if (kind === 'person') {
    const experience = Array.isArray(row.experience) ? row.experience : [];
    for (const e of experience) {
      const job = obj(e);
      if (!job || job.is_current_position === false || text(job.end_date)) continue;
      const company = text(job.company_name) ?? text(obj(job.company)?.name);
      const line = [text(job.title), company].filter(Boolean).join(' at ');
      if (line) lines.push(line);
      if (lines.length >= 4) break;
    }
  } else {
    if (typeof row.headcount === 'number' && row.headcount > 0) {
      lines.push(`${row.headcount.toLocaleString('en-US')} people`);
    }
    const stage = text(row.stage);
    if (stage) lines.push(stage.replace(/_/g, ' ').toLowerCase());
  }
  const website = text(obj(row.website)?.url) ?? text(row.website);
  return {
    kind,
    id,
    name,
    headline: text(row.headline) ?? text(row.short_description),
    location: locationOf(row),
    linkedin: linkedinOf(row),
    website: website && /^https?:\/\//i.test(website) ? website : null,
    description: kind === 'company' ? text(row.description) : text(row.about),
    lines,
  };
}
