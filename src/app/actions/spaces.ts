'use server';

import { z } from 'zod';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { rulesFromForm } from '@/lib/spaces/rules';
import { askSpace, SUMMARY_QUESTION, type SpaceAnswer } from '@/lib/services/space-ask';
import { addSpaceTask, itemOwner } from '@/lib/services/space-content';
import {
  answerInvite,
  createSpace,
  deleteSpace,
  getSpaceAccess,
  inviteMember,
  removeMember,
  setItemHidden,
  updateSpace,
} from '@/lib/services/spaces';
import type { AppError, Result } from '@/lib/util/result';
import type { ActionResult } from './index';

/**
 * Spaces: the signed-in boundary between the browser and
 * lib/services/spaces*.ts. Every action is signed in, rate-limited and
 * returns a Result, never a throw. Membership is checked in the services on
 * every call: a Space the person is not in reads as not found. Nothing here
 * sends, labels or changes mail.
 */

const ID = z.uuid();
const RULES = z.object({
  domains: z.string().max(4_000).optional(),
  emails: z.string().max(4_000).optional(),
  keywords: z.string().max(4_000).optional(),
});

function fail(error: Pick<AppError, 'message' | 'code' | 'stillUsable'>): ActionResult<never> {
  return {
    ok: false,
    error: { message: error.message, code: error.code, stillUsable: error.stillUsable },
  };
}

function from<T, U>(result: Result<T>, map: (v: T) => U): ActionResult<U> {
  return result.ok ? { ok: true, data: map(result.value) } : fail(result.error);
}

async function signedIn(bucket: string, max = 60) {
  const auth = await requireAuth();
  const limited = rateLimit(`spaces-${bucket}:${auth.userId}`, max, 60_000);
  return { auth, limited };
}

const bad = (message: string) => fail({ code: 'invalid_input', message });

export async function createSpaceAction(input: {
  name: string;
  description?: string;
  domains?: string;
  emails?: string;
  keywords?: string;
  sourceKind?: 'manual' | 'suggested' | 'company' | 'person' | 'deal';
  sourceRef?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  const parsed = RULES.extend({
    name: z.string().max(200),
    description: z.string().max(1_000).optional(),
    sourceKind: z.enum(['manual', 'suggested', 'company', 'person', 'deal']).optional(),
    sourceRef: z.string().max(200).optional(),
  }).safeParse(input);
  if (!parsed.success) return bad('Check the name and rules.');
  const { rules, invalid } = rulesFromForm(parsed.data);
  if (invalid.length) return bad(`These could not be read: ${invalid.slice(0, 5).join(', ')}`);
  const made = await createSpace(getStore(), auth, {
    name: parsed.data.name,
    description: parsed.data.description,
    rules,
    sourceKind: parsed.data.sourceKind,
    sourceRef: parsed.data.sourceRef,
  });
  return from(made, (s) => ({ id: s.id }));
}

export async function updateSpaceAction(
  spaceId: string,
  input: {
    name?: string;
    description?: string;
    domains?: string;
    emails?: string;
    keywords?: string;
  },
): Promise<ActionResult<{ id: string }>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success) return bad('Unknown Space.');
  const parsed = RULES.extend({
    name: z.string().max(200).optional(),
    description: z.string().max(1_000).optional(),
  }).safeParse(input);
  if (!parsed.success) return bad('Check the name and rules.');
  const touchesRules =
    parsed.data.domains !== undefined ||
    parsed.data.emails !== undefined ||
    parsed.data.keywords !== undefined;
  const { rules, invalid } = rulesFromForm(parsed.data);
  if (invalid.length) return bad(`These could not be read: ${invalid.slice(0, 5).join(', ')}`);
  const updated = await updateSpace(getStore(), auth, spaceId, {
    name: parsed.data.name,
    description: parsed.data.description,
    rules: touchesRules ? rules : undefined,
  });
  return from(updated, (s) => ({ id: s.id }));
}

export async function deleteSpaceAction(spaceId: string): Promise<ActionResult<true>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success) return bad('Unknown Space.');
  return from(await deleteSpace(getStore(), auth, spaceId), () => true as const);
}

export async function inviteSpaceMemberAction(
  spaceId: string,
  userId: string,
): Promise<ActionResult<true>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success || !ID.safeParse(userId).success)
    return bad('Unknown person.');
  return from(await inviteMember(getStore(), auth, spaceId, userId), () => true as const);
}

export async function answerSpaceInviteAction(
  spaceId: string,
  answer: 'accept' | 'decline',
): Promise<ActionResult<true>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success || !['accept', 'decline'].includes(answer)) {
    return bad('Unknown invite.');
  }
  return from(await answerInvite(getStore(), auth, spaceId, answer), () => true as const);
}

export async function removeSpaceMemberAction(
  spaceId: string,
  userId: string,
): Promise<ActionResult<true>> {
  const { auth, limited } = await signedIn('write', 30);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success || !ID.safeParse(userId).success)
    return bad('Unknown person.');
  return from(await removeMember(getStore(), auth, spaceId, userId), () => true as const);
}

const ITEM = z.object({
  kind: z.enum(['email', 'meeting', 'note', 'suggestion']),
  id: z.string().min(1).max(200),
});

export async function setSpaceItemHiddenAction(
  spaceId: string,
  item: { kind: 'email' | 'meeting' | 'note' | 'suggestion'; id: string },
  hidden: boolean,
): Promise<ActionResult<true>> {
  const { auth, limited } = await signedIn('hide', 120);
  if (!limited.ok) return fail(limited.error);
  const parsed = ITEM.safeParse(item);
  if (!ID.safeParse(spaceId).success || !parsed.success) return bad('Unknown item.');
  const store = getStore();
  const access = await getSpaceAccess(store, auth, spaceId);
  if (!access.ok) return fail(access.error);
  const owner =
    parsed.data.kind === 'suggestion'
      ? null
      : await itemOwner(store, access.value, parsed.data.kind, parsed.data.id);
  return from(
    await setItemHidden(store, auth, access.value, { ...parsed.data, owner }, Boolean(hidden)),
    () => true as const,
  );
}

export async function addSpaceTaskAction(
  spaceId: string,
  input: {
    title: string;
    detail?: string | null;
    dueAt?: string | null;
    assignedTo?: string | null;
    suggested?: boolean;
  },
): Promise<ActionResult<{ id: string }>> {
  const { auth, limited } = await signedIn('write', 60);
  if (!limited.ok) return fail(limited.error);
  const parsed = z
    .object({
      title: z.string().min(1).max(300),
      detail: z.string().max(2_000).nullish(),
      dueAt: z.iso.datetime({ offset: true }).nullish(),
      assignedTo: z.uuid().nullish(),
      suggested: z.boolean().optional(),
    })
    .safeParse(input);
  if (!ID.safeParse(spaceId).success || !parsed.success) return bad('Check the action item.');
  const store = getStore();
  const access = await getSpaceAccess(store, auth, spaceId);
  if (!access.ok) return fail(access.error);
  return from(await addSpaceTask(store, auth, access.value, parsed.data), (t) => ({ id: t.id }));
}

export async function askSpaceAction(
  spaceId: string,
  question: string,
  options: { summary?: boolean } = {},
): Promise<ActionResult<SpaceAnswer>> {
  const { auth, limited } = await signedIn('ask', 20);
  if (!limited.ok) return fail(limited.error);
  if (!ID.safeParse(spaceId).success) return bad('Unknown Space.');
  if (typeof question !== 'string' || question.length > 2_000)
    return bad('Type a shorter question.');
  const store = getStore();
  const access = await getSpaceAccess(store, auth, spaceId);
  if (!access.ok) return fail(access.error);
  const summary = Boolean(options.summary);
  return from(
    await askSpace(store, auth, access.value, summary ? SUMMARY_QUESTION : question, { summary }),
    (a) => a,
  );
}
