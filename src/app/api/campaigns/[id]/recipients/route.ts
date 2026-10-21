import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import {
  addRecipientsFromList,
  addRecipientsFromPaste,
  fillRecipientMerge,
  removeRecipients,
} from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const ADD = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('list'),
    listId: z.string().max(64),
    statuses: z.array(z.string().max(500)).max(200).optional(),
  }),
  z.object({ source: z.literal('paste'), text: z.string().max(500_000) }),
]);

/** Add people to a draft: from a CRM list (filtered by status) or pasted addresses. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const parsed = ADD.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Choose who to add.' });
  const { id } = await context.params;
  const store = getStore();
  const org = gate.auth.organizationId;
  const result =
    parsed.data.source === 'list'
      ? await addRecipientsFromList(store, org, id, {
          listId: parsed.data.listId,
          statuses: parsed.data.statuses,
        })
      : await addRecipientsFromPaste(store, org, id, parsed.data.text);
  return respond(result, (summary) => ({ summary }));
}

const REMOVE = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().max(64)).min(1).max(2_000) }),
]);

/** Take people off a draft. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit', 300);
  if (!gate.ok) return gate.response;
  const parsed = REMOVE.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Choose who to remove.' });
  const { id } = await context.params;
  const result = await removeRecipients(
    getStore(),
    gate.auth.organizationId,
    id,
    'all' in parsed.data ? { all: true } : { ids: parsed.data.ids },
  );
  return respond(result, (r) => r);
}

const FILL = z.object({
  recipientId: z.string().max(64),
  values: z
    .object({
      first_name: z.string().max(1_000).optional(),
      name: z.string().max(1_000).optional(),
      company: z.string().max(1_000).optional(),
    })
    .strict(),
  saveToContact: z.boolean().optional(),
});

/**
 * Fill in merge values one recipient is missing (from the review), and with
 * `saveToContact` also on the CRM person they came from. Changes the draft,
 * so the review is read again before it can be confirmed.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const parsed = FILL.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Type what to fill in.' });
  const { id } = await context.params;
  const result = await fillRecipientMerge(
    getStore(),
    gate.auth.organizationId,
    id,
    { userId: gate.auth.userId },
    {
      recipientId: parsed.data.recipientId,
      values: parsed.data.values,
      saveToContact: parsed.data.saveToContact === true,
    },
  );
  return respond(result, ({ filled, contact }) => ({ filled, contact }));
}
