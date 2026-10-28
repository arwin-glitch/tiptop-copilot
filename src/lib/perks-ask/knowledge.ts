import 'server-only';
import vm from 'node:vm';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Ask Arwin widget on perks.tiptop.vc (D-079) answers only from what that
 * site already publishes. Its catalog, perks-data.js, is a browser script
 * (`window.PERKS = [...]`), so this module fetches it, runs it in an empty VM
 * sandbox, and re-validates everything into plain capped strings — the VM is
 * an execution convenience for a first-party file, the validation below is
 * what makes the output data rather than code. Nothing here reads the app's
 * stores: the bot can never know more than the public site shows.
 */

const PERKS_SOURCE_URL = 'https://perks.tiptop.vc/perks-data.js';
const MAX_SOURCE_BYTES = 2_000_000;
const CACHE_MS = 10 * 60_000;
/** Perk pages live at the site root; used for the links the bot hands out. */
const PERK_PAGE = 'https://perks.tiptop.vc/perk.html?p=';

export interface PerkFact {
  slug: string;
  name: string;
  kindLabel: string;
  catLabel: string;
  tagline: string;
  stat: string;
  statLabel: string;
  bullets: string[];
  eligibility: string;
  provisional: boolean;
  redemptionType: string;
  redemptionNote: string;
  redemptionSteps: string[];
}

const cap = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

const capList = (value: unknown, maxItems: number, maxEach: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, maxItems)
        .map((item) => item.slice(0, maxEach))
    : [];

/** Run the catalog script in an empty sandbox and re-validate every field. */
export function parsePerksSource(code: string): Result<PerkFact[]> {
  const sandbox: { window: { PERKS?: unknown } } = { window: {} };
  try {
    vm.runInNewContext(code, sandbox, { timeout: 1_000 });
  } catch {
    return err('invalid_input', 'The perks catalog did not parse.');
  }
  const raw = sandbox.window.PERKS;
  if (!Array.isArray(raw) || raw.length === 0) {
    return err('invalid_input', 'The perks catalog held no perks.');
  }
  const perks: PerkFact[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const slug = cap(p.slug, 80);
    const name = cap(p.name, 120);
    if (!slug || !name) continue;
    const redemption =
      p.redemption && typeof p.redemption === 'object'
        ? (p.redemption as Record<string, unknown>)
        : {};
    perks.push({
      slug,
      name,
      kindLabel: cap(p.kindLabel, 60),
      catLabel: cap(p.catLabel, 60),
      tagline: cap(p.tagline, 400),
      stat: cap(p.stat, 40),
      statLabel: cap(p.statLabel, 80),
      bullets: capList(p.bullets, 8, 300),
      eligibility: cap(p.eligibility, 500),
      provisional: p.provisional === true,
      redemptionType: cap(redemption.type, 20),
      redemptionNote: cap(redemption.note, 500),
      redemptionSteps: capList(redemption.steps, 6, 200),
      // Deliberately NOT carried: redemption.email / url / code. Those unlock
      // on the perk page behind the founder email gate — the bot points there.
    });
  }
  if (perks.length === 0) return err('invalid_input', 'The perks catalog held no valid perks.');
  return ok(perks);
}

/** One perk, one block of plain lines for the system prompt. */
export function perkDigest(p: PerkFact): string {
  const lines = [
    `### ${p.name} (${p.kindLabel || 'Partner'} - ${p.catLabel || 'General'})`,
    `Page: ${PERK_PAGE}${p.slug}`,
  ];
  if (p.tagline) lines.push(`Offer: ${p.tagline}`);
  if (p.stat) lines.push(`Headline: ${p.stat} ${p.statLabel}`.trim());
  if (p.provisional) {
    lines.push(
      'Status: PROVISIONAL - no confirmed founder offer yet; today this listing is a warm introduction through Arwin.',
    );
  }
  if (p.bullets.length) lines.push(`Includes: ${p.bullets.join('; ')}`);
  if (p.eligibility) lines.push(`Eligibility: ${p.eligibility}`);
  if (p.redemptionNote || p.redemptionSteps.length) {
    let how = `Redeem (${p.redemptionType || 'email'}): ${p.redemptionNote}`.trim();
    if (p.redemptionSteps.length) how += ` Steps: ${p.redemptionSteps.join(' -> ')}`;
    lines.push(how);
  }
  // The voice rule bans em dashes; the catalog copy is full of them. Swap them
  // out here so the model never sees one to echo.
  return lines.join('\n').replace(/\s*—\s*/g, ' - ');
}

export interface PerksKnowledge {
  digest: string;
  count: number;
  softwareCount: number;
  consultantCount: number;
}

export function buildKnowledge(perks: PerkFact[]): PerksKnowledge {
  const software = perks.filter((p) => p.kindLabel.toLowerCase().includes('software'));
  const consultants = perks.filter((p) => !p.kindLabel.toLowerCase().includes('software'));
  const digest = [
    '=== SOFTWARE VENDORS ===',
    software.map(perkDigest).join('\n\n'),
    '',
    '=== CONSULTANTS & ADVISORS ===',
    consultants.map(perkDigest).join('\n\n'),
  ].join('\n');
  return {
    digest,
    count: perks.length,
    softwareCount: software.length,
    consultantCount: consultants.length,
  };
}

let cache: { knowledge: PerksKnowledge; at: number } | null = null;
let lastGood: PerksKnowledge | null = null;

/** Test hook. */
export function resetPerksKnowledgeCache(): void {
  cache = null;
  lastGood = null;
}

/**
 * The current knowledge block: fetched and rebuilt at most every ten minutes,
 * and on a bad fetch the last good copy keeps answering.
 */
export async function getPerksKnowledge(
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Result<PerksKnowledge>> {
  if (cache && now - cache.at < CACHE_MS) return ok(cache.knowledge);
  try {
    const res = await fetchImpl(PERKS_SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`catalog fetch ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_SOURCE_BYTES) throw new Error('catalog too large');
    const parsed = parsePerksSource(text);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const knowledge = buildKnowledge(parsed.value);
    cache = { knowledge, at: now };
    lastGood = knowledge;
    return ok(knowledge);
  } catch {
    if (lastGood) return ok(lastGood);
    return err('provider_unavailable', 'The perks catalog could not be read.');
  }
}
