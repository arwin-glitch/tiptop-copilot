import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * The Today-page briefing card, posted by the Daily Overview and Daily Recap
 * cloud routines rather than generated in-app.
 *
 * `summary` is stored and rendered as plain text, never HTML. The routines
 * are Claude sessions reading Nick's live mailbox and calendar — trusted in
 * the sense that their output is Claude's own prose, but the underlying
 * emails they summarise are third-party content the routines are instructed
 * to treat as data, not always successfully. Rendering their output as text
 * only closes the one class of failure that would matter here: a summary
 * that echoes something injection-shaped from a message can never become
 * markup on this page.
 */
export const ROUTINE_BRIEFING_SCHEMA = z.object({
  kind: z.enum(['morning', 'afternoon']),
  /** Local calendar date the routine ran for, in the user's timezone. */
  date_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_key must be YYYY-MM-DD'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type RoutineBriefingPayload = z.infer<typeof ROUTINE_BRIEFING_SCHEMA>;

/**
 * Replace the organization's briefing card.
 *
 * Upserted on `organization_id` alone, so there is at most one row per
 * organization ever: a morning post and an afternoon post the same day are
 * two calls to this function, the second overwriting the first. The existing
 * row's id is preserved explicitly — passing a fresh id on every call would
 * still upsert correctly, but would churn the primary key for no reason.
 */
export async function ingestRoutineBriefing(
  store: DataStore,
  organizationId: string,
  payload: RoutineBriefingPayload,
  now: Date = new Date(),
): Promise<RoutineBriefing> {
  const existing = await store.findOne('routine_briefings', organizationId, {});
  const nowIso = now.toISOString();
  const row: RoutineBriefing = {
    id: existing?.id ?? crypto.randomUUID(),
    organization_id: organizationId,
    kind: payload.kind,
    date_key: payload.date_key,
    title: payload.title,
    summary: payload.summary,
    source_url: payload.source_url ?? null,
    posted_at: nowIso,
    updated_at: nowIso,
  };
  const result = await store.upsert('routine_briefings', row, ['organization_id']);
  return result.row;
}

/** The organization's current briefing card, or null if none has posted yet. */
export async function getCurrentBriefing(
  store: DataStore,
  organizationId: string,
): Promise<RoutineBriefing | null> {
  return store.findOne('routine_briefings', organizationId, {});
}
