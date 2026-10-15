'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import {
  affinitySyncOrganization,
  emptyAffinitySyncCounts,
  publicAffinitySyncStep,
  runAffinitySyncStep,
  type PublicAffinitySyncStep,
} from '@/lib/services/affinity-sync';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * "Sync now" on Knowledge → Affinity import: one step of the daily Affinity
 * sync, for the owner. The page calls it in a loop until `done`, showing the
 * progress, exactly as the daily job loops /api/cron/affinity-sync.
 *
 * Owner only: the sync writes the whole CRM from one deployment-wide key. The
 * key is read here, on the server, and never leaves it.
 */

/** A step is short here so the page can show progress between calls. */
const STEP_BUDGET_MS = 20_000;

function fail(error: Pick<AppError, 'code' | 'message' | 'stillUsable'>): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

export async function syncAffinityNowAction(): Promise<ActionResult<PublicAffinitySyncStep>> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'owner');
  if (!role.ok)
    return fail({ ...role.error, message: 'Only the workspace owner can sync Affinity.' });
  const limited = rateLimit(`affinity-sync:${auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error);

  // The demo has no Affinity account behind it: an invented, finished run.
  if (auth.isDemo) {
    const counts = emptyAffinitySyncCounts();
    counts.listsDone = 12;
    counts.entries.unchanged = 37;
    counts.records.unchanged = 41;
    counts.notes.unchanged = 18;
    return {
      ok: true,
      data: publicAffinitySyncStep({
        done: true,
        busy: false,
        rateLimited: false,
        phase: 'done',
        listsDone: 12,
        listsTotal: 12,
        counts,
        pages: 0,
      }),
    };
  }

  const apiKey = env().affinityApiKey;
  if (!apiKey) {
    return fail({
      code: 'not_configured',
      message: 'Affinity is not connected yet: add AFFINITY_API_KEY on Render first.',
    });
  }

  const store = getStore();
  const organization = await affinitySyncOrganization(store);
  if (!organization.ok) return fail(organization.error);
  if (organization.value !== auth.organizationId) {
    return fail({
      code: 'forbidden',
      message: 'The Affinity key on this deployment belongs to another workspace.',
    });
  }

  const step = await runAffinitySyncStep(store, auth.organizationId, {
    apiKey,
    trigger: 'manual',
    budgetMs: STEP_BUDGET_MS,
    userId: auth.userId,
  });
  if (!step.ok) return fail(step.error);
  if (step.value.done) revalidatePath('/knowledge');
  return { ok: true, data: publicAffinitySyncStep(step.value) };
}
