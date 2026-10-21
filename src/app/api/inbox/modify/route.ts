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
import { rateLimit } from '@/lib/security/limits';
import { fail, sessionAuth } from '@/lib/services/email-session-auth';
import { forgetThreads, readLabelChoices, setDemoThreadLabels } from '@/lib/services/inbox-live';
import type { DataStore } from '@/lib/db/store';
import type { Integration } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

const ACTIONS: Record<string, { add?: InboxLabel[]; remove?: InboxLabel[] }> = {
  archive: { remove: ['INBOX'] },
  inbox: { add: ['INBOX'] },
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
};

const LABEL_IDS = z.array(z.string().regex(USER_LABEL_ID)).max(MAX_LABELS_PER_CHANGE).default([]);

const BODY = z.object({
  ids: z
    .array(z.string().regex(/^[0-9a-f]{10,24}$/i))
    .min(1)
    .max(100),
  action: z.enum(['archive', 'inbox', 'read', 'unread', 'star', 'unstar', 'label']),
  /** For `label` only: the person's own label ids to put on and take off. */
  add: LABEL_IDS,
  remove: LABEL_IDS,
});

/**
 * Archive, move back to the inbox, read/unread, star and label, from a
 * person's tap in the Inbox tab. Nothing is deleted: there is no trash or
 * delete action. A label change takes only the person's own labels, checked
 * against their Gmail label list, and picking a numbered label moves the
 * thread out of the others (planLabelChange). In demo mode a label change is
 * kept on the demo messages; the other actions stay off there.
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

  if (action === 'label' && s.auth.isDemo) {
    const plan = planLabelChange(await readLabelChoices(store, null), parsed.data);
    if (!plan.ok) return fail({ code: 'invalid_input', message: plan.message });
    let done = 0;
    for (const id of ids) {
      const res = await setDemoThreadLabels(store, s.auth.organizationId, id, plan);
      if (res.ok) done++;
    }
    if (done === 0) return fail({ code: 'not_found', message: 'That conversation is gone.' });
    return NextResponse.json({ ok: true, done, add: plan.add, remove: plan.remove });
  }

  if (!s.integration || !canSend(s.integration) || s.auth.isDemo) {
    return fail(
      {
        code: 'forbidden',
        message: 'Changing mail from the app needs sending turned on. Do it in Gmail instead.',
      },
      409,
    );
  }

  let change: { add?: (InboxLabel | UserLabelId)[]; remove?: (InboxLabel | UserLabelId)[] };
  if (action === 'label') {
    const plan = await planAgainstGmail(store, s.integration, parsed.data);
    if (!plan.ok) return fail({ code: 'invalid_input', message: plan.message });
    change = { add: plan.add as UserLabelId[], remove: plan.remove as UserLabelId[] };
  } else {
    change = ACTIONS[action]!;
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
    ...(action === 'label' ? { add: change.add, remove: change.remove } : {}),
  });
}

/**
 * Plan a label change against the mailbox's own labels. An id the cached
 * list does not hold (a label made in Gmail a moment ago) earns one fresh
 * read before the change is refused.
 */
async function planAgainstGmail(store: DataStore, integration: Integration, change: LabelChange) {
  const first = planLabelChange(await readLabelChoices(store, integration), change);
  if (first.ok || first.reason !== 'unknown') return first;
  return planLabelChange(await readLabelChoices(store, integration, { fresh: true }), change);
}
