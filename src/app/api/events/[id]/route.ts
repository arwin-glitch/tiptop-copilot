import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, done, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import {
  deleteEvent,
  getEvent,
  getEventSessions,
  updateEventSettings,
  type EventSettingsPatch,
} from '@/lib/services/events';
import type { EventRecord } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The row without the page documents or the password hash. */
function settingsOf(event: EventRecord) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { draft_doc, published_doc, password_hash, ...settings } = event;
  return settings;
}

/**
 * One event's settings and sessions (signed in). The page documents are not
 * included: Studio reads the draft from …/draft.
 */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('read', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const store = getStore();
  const event = await getEvent(store, gate.auth.organizationId, id);
  if (!event.ok) return fail(event.error);
  const sessions = await getEventSessions(store, gate.auth.organizationId, id);
  if (!sessions.ok) return fail(sessions.error);
  return done({ event: settingsOf(event.value), sessions: sessions.value });
}

/**
 * Change settings (the Settings tab, Registration, Pause editing). The shape
 * is checked loosely here and strictly in the service, which merges objects
 * over their current values.
 */
const PATCH_BODY = z
  .object({
    title: z.string().max(200),
    slug: z.string().max(60),
    visibility: z.enum(['public', 'unlisted', 'private']),
    access: z.enum(['open', 'approval', 'invite_only']),
    time_zone: z.string().max(64),
    starts_at: z.string().max(40).nullable(),
    ends_at: z.string().max(40).nullable(),
    venue: z.record(z.string(), z.unknown()),
    capacity: z.number().int().nullable(),
    registration: z.record(z.string(), z.unknown()),
    questions: z.array(z.unknown()).max(50),
    comms: z.record(z.string(), z.unknown()),
    editing_paused: z.boolean(),
  })
  .partial()
  .strict();

export async function PATCH(request: NextRequest, context: Context) {
  const gate = await eventsAuth('settings', { max: 60 });
  if (!gate.ok) return gate.response;
  const parsed = PATCH_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'Those settings could not be read.' });
  }
  const { id } = await context.params;
  const updated = await updateEventSettings(
    getStore(),
    gate.owner,
    id,
    parsed.data as EventSettingsPatch,
  );
  return respond(updated, (event) => ({ event: settingsOf(event) }));
}

/** Delete a draft that was never published (or a template). Everything else is archived. */
export async function DELETE(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('delete', { max: 20 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const deleted = await deleteEvent(getStore(), gate.owner, id);
  return respond(deleted, () => ({}));
}
