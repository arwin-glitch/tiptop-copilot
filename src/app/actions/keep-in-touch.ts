'use server';

import { z } from 'zod';
import { requireAuth, requireRole } from '@/lib/auth/session';
import { CADENCE_MAX_DAYS, CADENCE_MIN_DAYS, CADENCE_PRESETS } from '@/lib/crm/cadence';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor } from '@/lib/services/crm';
import { setCadence } from '@/lib/services/keep-in-touch';
import type { ActionResult } from './index';

/**
 * Keep-in-touch cadences on a profile. A file of its own, as the Lists
 * actions are; the rules are the same: signed in, a member or above (the
 * CRM's write floor), rate-limited, and a Result, never a throw.
 */

const INPUT = z.object({
  recordId: z.uuid(),
  choice: z.enum([...CADENCE_PRESETS, 'custom', 'off']),
  customDays: z.number().int().min(CADENCE_MIN_DAYS).max(CADENCE_MAX_DAYS).nullish(),
});

export async function setKeepInTouchAction(input: {
  recordId: string;
  choice: string;
  customDays?: number | null;
}): Promise<ActionResult<{ days: number | null; created: string[] }>> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) {
    return { ok: false, error: { message: role.error.message, code: role.error.code } };
  }
  const limited = rateLimit(`crm-write:${auth.userId}`, 120, 60_000);
  if (!limited.ok) {
    return { ok: false, error: { message: limited.error.message, code: limited.error.code } };
  }
  const parsed = INPUT.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        message: 'A custom cadence is a whole number of days from 1 to 365.',
        code: 'invalid_input',
      },
    };
  }
  const { recordId, choice, customDays } = parsed.data;
  const result = await setCadence(
    getStore(),
    auth.organizationId,
    recordId,
    { choice, customDays: customDays ?? null },
    crmActor(auth),
  );
  if (!result.ok) {
    return {
      ok: false,
      error: {
        message: result.error.message,
        code: result.error.code,
        stillUsable: result.error.stillUsable,
      },
    };
  }
  return {
    ok: true,
    data: { days: result.value.cadence?.days ?? null, created: result.value.created },
  };
}
