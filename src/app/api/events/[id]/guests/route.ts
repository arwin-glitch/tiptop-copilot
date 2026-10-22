import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { readHostBody } from '@/lib/events/host-routes';
import { UUID_RE } from '@/lib/events/registration';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import {
  addGuests,
  bulkGuests,
  listGuests,
  peopleFromCopilot,
  peopleFromEmails,
} from '@/lib/services/event-guests';

/**
 * The host's guest list (D-075, signed in):
 *   GET    → { roster } — every guest with per-session status, answers, tags, funnel
 *   POST   → add guests: manual, pasted emails, a CRM list, CRM records or Network
 *            contacts; as Invited, or directly as Going (skips approval and capacity)
 *   PATCH  → a bulk action: approve, decline, going, waitlist, not_going, promote,
 *            add/remove session, add/remove tag, rotate links, remove (hard delete)
 * Every change is audited; nothing is emailed.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const uuid = z.string().regex(UUID_RE);
const person = z.strictObject({
  email: z.string().trim().max(320).optional(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
});
const common = {
  sessionIds: z.array(uuid).max(20).default([]),
  status: z.enum(['invited', 'going']).default('invited'),
  tags: z.array(z.string().max(40)).max(20).default([]),
};
const addBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), people: z.array(person).min(1).max(50), ...common }),
  z.strictObject({ kind: z.literal('emails'), text: z.string().max(200_000), ...common }),
  z.strictObject({ kind: z.literal('list'), listId: uuid, ...common }),
  z.strictObject({
    kind: z.literal('records'),
    recordIds: z.array(uuid).min(1).max(2000),
    ...common,
  }),
  z.strictObject({
    kind: z.literal('network'),
    contactIds: z.array(uuid).min(1).max(2000),
    ...common,
  }),
]);

const bulkBody = z.strictObject({
  action: z.enum([
    'approve',
    'decline',
    'going',
    'waitlist',
    'not_going',
    'promote',
    'add_session',
    'remove_session',
    'add_tag',
    'remove_tag',
    'rotate_links',
    'remove',
  ]),
  guestIds: z.array(uuid).min(1).max(2000),
  sessionId: uuid.nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  tag: z.string().max(40).nullable().optional(),
  force: z.boolean().optional(),
});

export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('guests-read', { write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const result = await listGuests(getStore(), gate.owner.organizationId, id);
  return respond(result, (roster) => ({ roster }));
}

export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('guests-add', { max: 60 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 512 * 1024);
  if (!read.ok) return read.response;
  const parsed = addBody.safeParse(read.body);
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check the guests.',
    });
  }
  const { id } = await context.params;
  const store = getStore();
  const body = parsed.data;
  let people;
  let skipped = 0;
  let invalid: string[] = [];
  if (body.kind === 'manual') {
    people = body.people.map((p) => ({
      email: p.email?.toLowerCase() || null,
      first_name: p.firstName || null,
      last_name: p.lastName || null,
      company: p.company || null,
      title: p.title || null,
      phone: p.phone || null,
    }));
    if (
      people.some(
        (p) => !p.email || !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(p.email),
      )
    ) {
      return fail({ code: 'invalid_input', message: 'Every guest needs a valid email address.' });
    }
  } else if (body.kind === 'emails') {
    const parsedEmails = peopleFromEmails(body.text);
    people = parsedEmails.people;
    invalid = parsedEmails.invalid;
    if (!people.length)
      return fail({ code: 'invalid_input', message: 'No email addresses found in that text.' });
  } else {
    const source =
      body.kind === 'list'
        ? ({ kind: 'list', listId: body.listId } as const)
        : body.kind === 'records'
          ? ({ kind: 'records', recordIds: body.recordIds } as const)
          : ({ kind: 'network', contactIds: body.contactIds } as const);
    const found = await peopleFromCopilot(store, gate.owner.organizationId, source);
    if (!found.ok) return fail(found.error);
    people = found.value.people;
    skipped = found.value.skipped;
    if (!people.length) {
      return fail({
        code: 'invalid_input',
        message: 'None of those people have an email address.',
      });
    }
  }
  const result = await addGuests(store, gate.owner, id, {
    people,
    sessionIds: body.sessionIds,
    status: body.status,
    source: 'host',
    tags: body.tags,
  });
  return respond(result, (outcome) => ({
    added: outcome.added.length,
    merged: outcome.merged.length,
    overCapacity: outcome.overCapacity,
    skipped,
    invalid: invalid.slice(0, 20),
  }));
}

export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('guests-bulk', { max: 120 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, 256 * 1024);
  if (!read.ok) return read.response;
  const parsed = bulkBody.safeParse(read.body);
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'Check the selection.',
    });
  }
  const { id } = await context.params;
  const result = await bulkGuests(getStore(), gate.owner, id, parsed.data);
  return respond(result, (outcome) => ({ ...outcome }));
}
