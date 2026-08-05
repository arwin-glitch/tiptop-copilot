import 'server-only';
import type { DataStore } from '@/lib/db/store';
import {
  DEFAULT_DEAL_STAGES,
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_THRESHOLDS,
  type ThesisVersion,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';

/**
 * Thesis configuration.
 *
 * Versioned and append-only: an analysis records the thesis version it was
 * scored against, so changing the weights later does not silently rewrite the
 * meaning of past recommendations.
 *
 * The seeded default contains only what TipTop states publicly. Check size,
 * ownership, geography and traction thresholds ship empty and are excluded
 * from scoring until they are configured — the product never invents an
 * investment parameter.
 */

export const DEFAULT_THESIS_NOTES = `TipTop VC invests at pre-seed and seed into vertical AI and AI-native vertical software: industry-specific platforms sold to the people who do the work.

We look for founders or experienced operators with strong founder-market fit, products that replace or reinvent meaningful industry workflows, and businesses with the potential to become the intelligent operating system for a vertical.

We prioritise companies where TipTop can add value through GTM strategy, fundraising, hiring, and its operator network.

Check size, ownership target, geography and traction requirements are not set here. Leave them unset rather than assuming a value.`;

export async function getActiveThesis(
  store: DataStore,
  organizationId: string,
  createdBy: string | null = null,
): Promise<ThesisVersion> {
  const existing = await store.list(
    'thesis_versions',
    organizationId,
    { eq: { is_active: true } },
    { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
  );
  if (existing[0]) return existing[0];

  const seeded: ThesisVersion = {
    id: newId(),
    organization_id: organizationId,
    version: 1,
    preferred_stages: ['Pre-seed', 'Seed'],
    preferred_industries: [
      'Vertical AI',
      'AI-native vertical software',
      'Industry-specific platforms',
    ],
    excluded_industries: [],
    geographic_preferences: [],
    typical_check_range: null,
    target_ownership: null,
    follow_on_strategy: null,
    required_traction: null,
    thesis_notes: DEFAULT_THESIS_NOTES,
    hard_disqualifiers: [],
    scoring_weights: DEFAULT_SCORING_WEIGHTS,
    thresholds: DEFAULT_THRESHOLDS,
    deal_stages: DEFAULT_DEAL_STAGES,
    is_active: true,
    created_by: createdBy,
    created_at: new Date().toISOString(),
  };
  await store.insert('thesis_versions', seeded);
  return seeded;
}

export type ThesisPatch = Partial<
  Omit<
    ThesisVersion,
    'id' | 'organization_id' | 'version' | 'is_active' | 'created_at' | 'created_by'
  >
>;

/** Creates a new version rather than mutating; the old one stays queryable. */
export async function updateThesis(
  store: DataStore,
  organizationId: string,
  userId: string,
  patch: ThesisPatch,
): Promise<ThesisVersion> {
  const current = await getActiveThesis(store, organizationId, userId);
  await store.update('thesis_versions', organizationId, current.id, { is_active: false });

  const next: ThesisVersion = {
    ...current,
    ...patch,
    id: newId(),
    version: current.version + 1,
    is_active: true,
    created_by: userId,
    created_at: new Date().toISOString(),
  };
  await store.insert('thesis_versions', next);
  return next;
}

/** Keywords used to detect thesis alignment in source text. */
export function thesisKeywords(thesis: ThesisVersion): string[] {
  const fromLists = [
    ...thesis.preferred_industries,
    ...thesis.preferred_stages,
    ...thesis.geographic_preferences,
  ];
  const fromNotes = thesis.thesis_notes
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 5);
  const structural = [
    'vertical',
    'workflow',
    'operator',
    'industry',
    'practice',
    'clinic',
    'contractor',
    'operating system',
  ];
  return Array.from(
    new Set([...fromLists.map((s) => s.toLowerCase()), ...fromNotes, ...structural]),
  );
}

/**
 * Which configured criteria are actually set. The UI uses this to show
 * "not configured" instead of pretending a blank field is a requirement, and
 * the scorer uses it to skip unset criteria rather than fail against them.
 */
export function configuredCriteria(thesis: ThesisVersion): {
  configured: string[];
  unconfigured: string[];
} {
  const entries: [string, unknown][] = [
    ['Preferred stages', thesis.preferred_stages.length ? thesis.preferred_stages : null],
    [
      'Preferred industries',
      thesis.preferred_industries.length ? thesis.preferred_industries : null,
    ],
    ['Excluded industries', thesis.excluded_industries.length ? thesis.excluded_industries : null],
    [
      'Geographic preferences',
      thesis.geographic_preferences.length ? thesis.geographic_preferences : null,
    ],
    ['Typical check range', thesis.typical_check_range],
    ['Target ownership', thesis.target_ownership],
    ['Follow-on strategy', thesis.follow_on_strategy],
    ['Required traction', thesis.required_traction],
    ['Hard disqualifiers', thesis.hard_disqualifiers.length ? thesis.hard_disqualifiers : null],
  ];
  return {
    configured: entries.filter(([, v]) => v != null).map(([k]) => k),
    unconfigured: entries.filter(([, v]) => v == null).map(([k]) => k),
  };
}
