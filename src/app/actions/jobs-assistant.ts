'use server';

import { revalidatePath } from 'next/cache';
import { requireAuth, requireRole } from '@/lib/auth/session';
import type { JobsAssistantConfig, JobsAssistantPatch } from '@/lib/jobs-board/assistant-config';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { revalidatePublicBoard } from '@/lib/services/jobs-board';
import {
  readJobsAssistantPanel,
  saveJobsAssistant,
  type JobsAssistantPanel,
} from '@/lib/services/jobs-chat';
import type { ActionResult } from './index';

/**
 * Server actions for "Ask Arwin" on the public job board (Portfolio > Jobs >
 * Ask Arwin): read its settings and status, and save them. Signed in, member
 * role (the floor the board's tables set), like the board's other actions.
 * After a save the cached public pages are rebuilt, so the change is live.
 */

async function member(): Promise<
  { organizationId: string; userId: string; denied?: undefined } | { denied: ActionResult<never> }
> {
  const auth = await requireAuth();
  const role = requireRole(auth, 'member');
  if (!role.ok) {
    return { denied: { ok: false, error: { message: role.error.message, code: role.error.code } } };
  }
  const limited = rateLimit(`jobs-assistant:${auth.userId}`, 60, 60_000);
  if (!limited.ok) {
    return {
      denied: { ok: false, error: { message: limited.error.message, code: limited.error.code } },
    };
  }
  return { organizationId: auth.organizationId, userId: auth.userId };
}

export async function readJobsAssistantAction(): Promise<ActionResult<JobsAssistantPanel>> {
  const who = await member();
  if (who.denied) return who.denied;
  return { ok: true, data: await readJobsAssistantPanel(getStore(), who.organizationId) };
}

export async function saveJobsAssistantAction(
  patch: JobsAssistantPatch,
): Promise<ActionResult<JobsAssistantConfig>> {
  const who = await member();
  if (who.denied) return who.denied;
  const result = await saveJobsAssistant(
    getStore(),
    { organizationId: who.organizationId, userId: who.userId },
    patch,
  );
  if (!result.ok) {
    return { ok: false, error: { message: result.error.message, code: result.error.code } };
  }
  revalidatePath('/portfolio');
  revalidatePublicBoard();
  return { ok: true, data: result.value };
}
