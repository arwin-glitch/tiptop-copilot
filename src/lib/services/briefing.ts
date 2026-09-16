import 'server-only';
import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import type { RoutineBriefing } from '@/lib/types/domain';

/**
 * The Today-page briefing card(s), posted by the Daily Overview and Daily
 * Recap cloud routines rather than generated in-app.
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
  kind: z.enum(['morning', 'afternoon', 'dossier']),
  /** Local calendar date the routine ran for, in the user's timezone. */
  date_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_key must be YYYY-MM-DD'),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(20_000),
  source_url: z.string().url().max(2000).nullish(),
});

export type RoutineBriefingPayload = z.infer<typeof ROUTINE_BRIEFING_SCHEMA>;

/**
 * Replace one slot of the organization's briefing.
 *
 * Upserted on `(organization_id, kind)`, so there is at most one row per
 * organization per kind: a morning post and an afternoon post the same day
 * are two independent rows, and posting the afternoon one does not touch the
 * dossier row at all. The existing row's id is preserved explicitly — passing
 * a fresh id on every call would still upsert correctly, but would churn the
 * primary key for no reason.
 */
export async function ingestRoutineBriefing(
  store: DataStore,
  organizationId: string,
  payload: RoutineBriefingPayload,
  now: Date = new Date(),
): Promise<RoutineBriefing> {
  const existing = await store.findOne('routine_briefings', organizationId, {
    eq: { kind: payload.kind },
  });
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
  const result = await store.upsert('routine_briefings', row, ['organization_id', 'kind']);
  return result.row;
}

/**
 * The organization's current brief — whichever of the morning overview or
 * the afternoon recap is current for *today* — or null if neither has
 * posted yet.
 *
 * "Current" is decided by date_key first, not just posted_at: without that,
 * yesterday's 3pm afternoon post would outrank this morning's fresh brief
 * (posted_at 6am today is earlier in the day than 3pm yesterday was, but the
 * calendar date is what actually matters here). Within the same date_key the
 * afternoon post always wins — that is the entire point of the Recap.
 */
export async function getCurrentBrief(
  store: DataStore,
  organizationId: string,
): Promise<RoutineBriefing | null> {
  const [morning, afternoon] = await Promise.all([
    store.findOne('routine_briefings', organizationId, { eq: { kind: 'morning' } }),
    store.findOne('routine_briefings', organizationId, { eq: { kind: 'afternoon' } }),
  ]);
  if (!morning) return afternoon;
  if (!afternoon) return morning;
  if (afternoon.date_key !== morning.date_key) {
    return afternoon.date_key > morning.date_key ? afternoon : morning;
  }
  return afternoon;
}

/**
 * The organization's current meeting dossier, or null if the Daily Overview
 * has never posted one. Independent of `getCurrentBrief` — an afternoon
 * Recap has no dossier of its own, so this is untouched by the brief swap
 * and only changes when the next Overview posts a fresh one.
 */
export async function getCurrentDossier(
  store: DataStore,
  organizationId: string,
): Promise<RoutineBriefing | null> {
  return store.findOne('routine_briefings', organizationId, { eq: { kind: 'dossier' } });
}
