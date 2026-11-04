import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getStore } from '@/lib/runtime';
import {
  canSend,
  setThreadLabels,
  type InboxLabel,
  type UserLabelId,
} from '@/lib/google/gmail-send';
import {
  MAX_LABELS_PER_CHANGE,
  planLabelChange,
  USER_LABEL_ID,
  type LabelChange,
} from '@/lib/email/inbox-actions';
import { SYSTEM_ACTIONS, type SystemAction } from '@/lib/email/inbox-modify';
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import {
  forgetThreads,
  readLabelChoices,
  setDemoSystemLabels,
  setDemoThreadLabels,
} from '@/lib/services/inbox-live';
import type { DataStore } from '@/lib/db/store';
import type { Integration } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

const LABEL_IDS = z.array(z.string().regex(USER_LABEL_ID)).max(MAX_LABELS_PER_CHANGE).default([]);
/** Where "Move to" may take a thread from or to: the inbox or one of the person's own labels. */
const PLACE = z.union([z.literal('INBOX'), z.string().regex(USER_LABEL_ID)]);

const BODY = z.object({
  ids: z
    .array(z.string().regex(/^[0-9a-f]{10,24}$/i))
    .min(1)
    .max(100),
  action: z.enum([
    ...(Object.keys(SYSTEM_ACTIONS) as [SystemAction, ...SystemAction[]]),
    'label',
    'move',
  ]),
  /** For `label` only: the person's own label ids to put on and take off. */
  add: LABEL_IDS,
  remove: LABEL_IDS,
  /** For `move` only: where it goes, and the folder it leaves (Gmail's "Move to"). */
  to: PLACE.optional(),
  from: PLACE.nullish(),
});

type Change = { add: (InboxLabel | UserLabelId)[]; remove: (InboxLabel | UserLabelId)[] };

/**
 * Every change the Inbox tab makes to mail, each from a person's tap:
 * archive and back, read/unread, star, important, Delete (Trash) and back,
 * Report spam and Not spam, Label as and Move to. Delete and spam are Gmail
 * labels, so each is undone by taking the label off: nothing here deletes
 * for good, and there is no "Delete forever" or "Empty trash". A label
 * change takes only the person's own labels, checked against their Gmail
 * label list, and picking a numbered label moves the thread out of the
 * others (planLabelChange). In demo mode every change is kept on the demo
 * mailbox and never reaches Gmail.
 */
export async function POST(request: NextRequest) {
  const s = await sessionAuth();
  if (!s.ok) return s.response;
  const limited = rateLimit(`inbox-modify:${s.auth.userId}`, 120, 60_000);
  if (!limited.ok) return fail(limited.error, 429);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Nothing to change.' });
  const { ids, action } = parsed.data;
  const store = getStore();
  if (action === 'move' && !parsed.data.to) {
    return fail({ code: 'invalid_input', message: 'Pick where to move it.' });
  }

  if (s.auth.isDemo) return demoChange(store, s.auth.organizationId, parsed.data);

  if (!s.integration || !canSend(s.integration)) {
    return fail(
      {
        code: 'forbidden',
        message: 'Changing mail from the app needs sending turned on. Do it in Gmail instead.',
      },
      409,
    );
  }

  let change: Partial<Change>;
  if (action === 'label') {
    const plan = await planAgainstGmail(store, s.integration, parsed.data);
    if (!plan.ok) return fail({ code: 'invalid_input', message: plan.message });
    change = { add: plan.add as UserLabelId[], remove: plan.remove as UserLabelId[] };
  } else if (action === 'move') {
    const planned = await planMove(store, s.integration, parsed.data.to!, parsed.data.from ?? null);
    if (!planned.ok) return fail({ code: 'invalid_input', message: planned.message });
    change = planned.change;
  } else {
    change = SYSTEM_ACTIONS[action];
  }

  let done = 0;
  for (const id of ids) {
    const res = await setThreadLabels(store, s.integration, id, change);
    if (res.ok) done++;
  }
  // Whatever happened, the cached copies of these threads may be stale now.
  forgetThreads(ids);
  if (done === 0) {
    return fail({ code: 'provider_unavailable', message: 'Gmail did not take that. Try again.' });
  }
  return NextResponse.json({
    ok: true,
    done,
    ...(action === 'label' || action === 'move' ? { add: change.add, remove: change.remove } : {}),
  });
}

/**
 * Plan a label change against the mailbox's own labels. An id the cached
 * list does not hold (a label made in Gmail a moment ago) earns one fresh
 * read before the change is refused.
 */
async function planAgainstGmail(
  store: DataStore,
  integration: Integration | null,
  change: LabelChange,
) {
  const first = planLabelChange(await readLabelChoices(store, integration), change);
  if (first.ok || first.reason !== 'unknown' || !integration) return first;
  return planLabelChange(await readLabelChoices(store, integration, { fresh: true }), change);
}

/**
 * Gmail's "Move to": on with the place picked, off with the folder it is
 * leaving. A user label on either side is checked against the person's
 * labels the way Label as is, numbered families included.
 */
async function planMove(
  store: DataStore,
  integration: Integration | null,
  to: string,
  from: string | null,
): Promise<{ ok: true; change: Change } | { ok: false; message: string }> {
  if (to === from) return { ok: false, message: 'It is already there.' };
  const userAdd = to === 'INBOX' ? [] : [to];
  const userRemove = from && from !== 'INBOX' ? [from] : [];
  let plan: { add: string[]; remove: string[] } = { add: [], remove: [] };
  if (userAdd.length || userRemove.length) {
    const planned = await planAgainstGmail(store, integration, {
      add: userAdd,
      remove: userRemove,
    });
    if (planned.ok) plan = planned;
    // Out of a numbered label and into the inbox only: the label stays, as the sorter would
    // put one back. Anything else refused is refused.
    else if (!(planned.reason === 'conflict' && userAdd.length === 0)) {
      return { ok: false, message: planned.message };
    }
  }
  const add = [...(to === 'INBOX' ? ['INBOX'] : []), ...plan.add] as Change['add'];
  const remove = [
    ...(from === 'INBOX' || (from === null && to !== 'INBOX') ? ['INBOX'] : []),
    ...plan.remove,
  ] as Change['remove'];
  return { ok: true, change: { add, remove: remove.filter((l) => !add.includes(l)) } };
}

async function demoChange(
  store: DataStore,
  organizationId: string,
  body: z.infer<typeof BODY>,
): Promise<NextResponse> {
  const { ids, action } = body;
  let system: Partial<Change> = {};
  let user: { add: string[]; remove: string[] } | null = null;
  if (action === 'label') {
    const plan = planLabelChange(await readLabelChoices(store, null), body);
    if (!plan.ok) return fail({ code: 'invalid_input', message: plan.message });
    user = plan;
  } else if (action === 'move') {
    const planned = await planMove(store, null, body.to!, body.from ?? null);
    if (!planned.ok) return fail({ code: 'invalid_input', message: planned.message });
    const isUser = (l: string) => USER_LABEL_ID.test(l);
    system = {
      add: planned.change.add.filter((l) => !isUser(l)),
      remove: planned.change.remove.filter((l) => !isUser(l)),
    };
    user = {
      add: planned.change.add.filter(isUser),
      remove: planned.change.remove.filter(isUser),
    };
  } else {
    system = SYSTEM_ACTIONS[action];
  }
  let done = 0;
  for (const id of ids) {
    let res: { ok: boolean } = { ok: true };
    if (user && (user.add.length || user.remove.length)) {
      res = await setDemoThreadLabels(store, organizationId, id, user);
    }
    if (res.ok && (system.add?.length || system.remove?.length)) {
      res = await setDemoSystemLabels(store, organizationId, id, system);
    }
    if (res.ok) done++;
  }
  if (done === 0) return fail({ code: 'not_found', message: 'That conversation is gone.' });
  return NextResponse.json({
    ok: true,
    done,
    ...(user ? { add: user.add, remove: user.remove } : {}),
  });
}
