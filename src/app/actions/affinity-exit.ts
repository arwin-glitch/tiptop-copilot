'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAuth, requireRole } from '@/lib/auth/session';
import {
  AFFINITY_EXIT_TOOL_LABEL_MAX,
  type AffinityExitChange,
  type AffinityExitSettings,
} from '@/lib/crm/affinity-exit';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { changeAffinityExitSettings } from '@/lib/services/affinity-exit';
import {
  AFFINITY_EXIT_IMPORT_KINDS,
  publicAffinityExitImportStep,
  runAffinityExitImportStep,
  type PublicAffinityExitImportStep,
} from '@/lib/services/affinity-exit-import';
import { affinitySyncOrganization } from '@/lib/services/affinity-sync';
import type { AppError } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * The Affinity exit checklist on Knowledge → Affinity import.
 *
 * Changing the checklist (the notice date, "Cancelled", the outside tools) is
 * for members and above, the CRM's write floor. The two copies read the whole
 * of Affinity with the deployment's one key and write the CRM or the tasks,
 * so they are the owner's, as "Sync now" is. Every action is rate-limited and
 * answers with a result, never a throw.
 */

/** A step is short here so the page can show progress between calls. */
const STEP_BUDGET_MS = 20_000;

function fail(error: Pick<AppError, 'code' | 'message' | 'stillUsable'>): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

const CHANGE = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('date'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  }),
  z.object({ op: z.literal('cancelled'), cancelled: z.boolean() }),
  z.object({
    op: z.literal('add-tool'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(AFFINITY_EXIT_TOOL_LABEL_MAX * 2),
  }),
  z.object({ op: z.literal('tick-tool'), id: z.string().min(1).max(64), done: z.boolean() }),
  z.object({ op: z.literal('remove-tool'), id: z.string().min(1).max(64) }),
]);

export async function changeAffinityExitAction(
  input: AffinityExitChange,
): Promise<ActionResult<AffinityExitSettings>> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) return fail({ ...role.error, message: 'Only members can change the checklist.' });
  const limited = rateLimit(`affinity-exit:${auth.userId}`, 60, 60_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = CHANGE.safeParse(input);
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message:
        input && typeof input === 'object' && 'op' in input && input.op === 'add-tool'
          ? `A tool's name is 1 to ${AFFINITY_EXIT_TOOL_LABEL_MAX} characters.`
          : 'That change could not be read. Reload the page and try again.',
    });
  }
  const result = await changeAffinityExitSettings(getStore(), auth.organizationId, parsed.data, {
    userId: auth.userId,
  });
  if (!result.ok) return fail(result.error);
  revalidatePath('/knowledge');
  revalidatePath('/today');
  return { ok: true, data: result.value };
}

const IMPORT = z.object({
  kind: z.enum(AFFINITY_EXIT_IMPORT_KINDS),
  fresh: z.boolean(),
});

/**
 * One step of an opt-in copy (contacts on no list, or open reminders as
 * tasks). The page calls it in a loop until `done`, `capped` or an error,
 * showing the progress, exactly as "Sync now" loops the sync.
 */
export async function runAffinityExitImportAction(input: {
  kind: string;
  fresh: boolean;
}): Promise<ActionResult<PublicAffinityExitImportStep>> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'owner');
  if (!role.ok) {
    return fail({ ...role.error, message: 'Only the workspace owner can copy from Affinity.' });
  }
  const limited = rateLimit(`affinity-exit-import:${auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error);
  const parsed = IMPORT.safeParse(input);
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'That copy is not one this page offers.' });
  }
  const { kind, fresh } = parsed.data;

  // The demo has no Affinity account behind it: an invented, finished copy.
  if (auth.isDemo) {
    const copied = kind === 'contacts' ? 24 : 3;
    return {
      ok: true,
      data: publicAffinityExitImportStep({
        kind,
        done: true,
        busy: false,
        rateLimited: false,
        capped: false,
        phase: 'done',
        scanned: kind === 'contacts' ? 61 : 5,
        existing: kind === 'contacts' ? 35 : 0,
        copied,
        runCopied: copied,
        skipped: kind === 'contacts' ? 2 : 2,
        errors: 0,
        openTotal: kind === 'reminders' ? 3 : null,
      }),
    };
  }

  const apiKey = env().affinityApiKey;
  if (!apiKey) {
    return fail({
      code: 'not_configured',
      message:
        'Affinity is not connected: AFFINITY_API_KEY is not set, so there is nothing to copy from.',
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

  const step = await runAffinityExitImportStep(store, auth.organizationId, kind, {
    apiKey,
    userId: auth.userId,
    fresh,
    budgetMs: STEP_BUDGET_MS,
  });
  if (!step.ok) return fail(step.error);
  if (step.value.done || step.value.capped) {
    revalidatePath('/knowledge');
    if (kind === 'reminders') revalidatePath('/tasks');
  }
  return { ok: true, data: publicAffinityExitImportStep(step.value) };
}
