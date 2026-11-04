import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { USER_LABEL_ID } from '@/lib/email/inbox-actions';
import { isGmailLabelColor } from '@/lib/email/label-colors';
import { getStore } from '@/lib/runtime';
import { canSend, createLabel, deleteLabel, updateLabel } from '@/lib/google/gmail-send';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import {
  createDemoLabel,
  demoLabelList,
  forgetLabelNames,
  readLabelChoices,
  removeDemoLabel,
  updateDemoLabel,
} from '@/lib/services/inbox-live';

export const dynamic = 'force-dynamic';

const NAME = z.string().trim().min(1).max(225);
const BODY = z.object({ name: NAME });
const COLOR = z
  .object({ bg: z.string().regex(/^#[0-9a-f]{6}$/i), fg: z.string().regex(/^#[0-9a-f]{6}$/i) })
  .refine(isGmailLabelColor, 'Gmail takes only its own label colours.');
const PATCH_BODY = z
  .object({ id: z.string().regex(USER_LABEL_ID), name: NAME.optional(), color: COLOR.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.color !== undefined, 'Nothing to change.');

/** A rename carries at most this many sublabels along. */
const MAX_SUBLABELS = 50;

const NEEDS_SEND = 'Changing labels needs sending turned on. Do it in Gmail.';

/**
 * A new Gmail label of the person's own, from the nav's "+", Add sublabel,
 * or the Label menu (a tap). The demo keeps its labels in this process.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-labels:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Name the label first.' });
  if (s.auth.isDemo) {
    return NextResponse.json({ ok: true, label: createDemoLabel(parsed.data.name) });
  }
  if (!s.integration || !canSend(s.integration)) {
    return fail({ code: 'forbidden', message: NEEDS_SEND }, 409);
  }
  const made = await createLabel(getStore(), s.integration, parsed.data.name);
  if (!made.ok) return fail(made.error);
  forgetLabelNames();
  return NextResponse.json({ ok: true, label: made.value });
}

/**
 * Gmail's label ⋮ menu: Label colour (Gmail's palette only) and Edit (a
 * rename, which carries the label's sublabels along as Gmail's does). Only
 * the person's own labels; only from a click.
 */
export async function PATCH(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-labels:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = PATCH_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'That change could not be read.',
    });
  }
  const { id, name, color } = parsed.data;
  if (s.auth.isDemo) {
    const done = updateDemoLabel(id, { name, color });
    if (!done) return fail({ code: 'not_found', message: 'That label is gone.' });
    return NextResponse.json({ ok: true, labels: demoLabelList() });
  }
  if (!s.integration || !canSend(s.integration)) {
    return fail({ code: 'forbidden', message: NEEDS_SEND }, 409);
  }
  const store = getStore();
  const labels = await readLabelChoices(store, s.integration, { fresh: true });
  const label = labels.find((l) => l.id === id);
  if (!label) return fail({ code: 'not_found', message: 'That label is gone from Gmail.' });
  const done = await updateLabel(store, s.integration, id, { name, color });
  if (!done.ok) return fail(done.error);
  if (name && name !== label.name) {
    const children = labels
      .filter((l) => l.name.startsWith(`${label.name}/`))
      .slice(0, MAX_SUBLABELS);
    for (const child of children) {
      await updateLabel(store, s.integration, child.id, {
        name: `${name}${child.name.slice(label.name.length)}`,
      });
    }
  }
  forgetLabelNames();
  await recordAudit(store, {
    organizationId: s.auth.organizationId,
    userId: s.auth.userId,
    action: 'inbox.label_changed',
    entityType: 'gmail_label',
    entityId: null,
    metadata: { renamed: Boolean(name), recoloured: Boolean(color) },
  }).catch(() => undefined);
  return NextResponse.json({
    ok: true,
    labels: await readLabelChoices(store, s.integration, { fresh: true }),
  });
}

/**
 * Gmail's "Remove label", after the person confirms: the label comes off
 * every conversation and is deleted. The mail itself is not deleted.
 */
export async function DELETE(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-labels:${s.auth.userId}`, 20, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!USER_LABEL_ID.test(id)) return fail({ code: 'invalid_input', message: 'Unknown label.' });
  if (s.auth.isDemo) {
    if (!removeDemoLabel(id)) return fail({ code: 'not_found', message: 'That label is gone.' });
    return NextResponse.json({ ok: true });
  }
  if (!s.integration || !canSend(s.integration)) {
    return fail({ code: 'forbidden', message: NEEDS_SEND }, 409);
  }
  const store = getStore();
  const labels = await readLabelChoices(store, s.integration, { fresh: true });
  if (!labels.some((l) => l.id === id)) {
    return fail({ code: 'not_found', message: 'That label is gone from Gmail.' });
  }
  const done = await deleteLabel(store, s.integration, id);
  if (!done.ok) return fail(done.error);
  forgetLabelNames();
  await recordAudit(store, {
    organizationId: s.auth.organizationId,
    userId: s.auth.userId,
    action: 'inbox.label_deleted',
    entityType: 'gmail_label',
    entityId: null,
    metadata: {},
  }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
