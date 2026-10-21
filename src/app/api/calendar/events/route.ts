import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { calendarSource } from '@/lib/calendar/range-reader';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  type WriteContext,
} from '@/lib/calendar/write';
import { getStore } from '@/lib/runtime';
import type { AuthContext } from '@/lib/auth/session';
import type { Result } from '@/lib/util/result';
import { isSupportedTimezone } from '@/lib/util/time';

export const dynamic = 'force-dynamic';

/**
 * Create (POST), change or move (PATCH) and delete (DELETE) one event, from
 * the Calendar tab on a person's tap. Every request names `notify`: 'send'
 * only when the person chose Send in the guests prompt, which is the only way
 * Google emails anyone. lib/calendar/write.ts refuses unless calendar editing
 * is on, the calendar is writable and the event is one this account may change.
 */

const CALENDAR_ID = z.string().trim().min(1).max(320);
// Google event ids are base32hex; an instance adds `_` and its start.
const EVENT_ID = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_\-.@]+$/);
const NOTIFY = z.enum(['send', 'dont_send']);
const SCOPE = z.enum(['this', 'all']);

const DRAFT = z.object({
  title: z.string().max(1024),
  allDay: z.boolean(),
  start: z.string().min(10).max(40),
  end: z.string().min(10).max(40),
  timeZone: z.string().min(1).max(64).refine(isSupportedTimezone),
  description: z.string().max(8000).optional(),
  location: z.string().max(1024).optional(),
  guests: z.array(z.string().trim().max(254)).max(100).optional(),
  meet: z.boolean().optional(),
  colorId: z
    .string()
    .regex(/^\d{1,2}$/)
    .nullable()
    .optional(),
});

const CREATE = z
  .object({ calendarId: CALENDAR_ID, draft: DRAFT.strict(), notify: NOTIFY })
  .strict();

const UPDATE = z
  .object({
    calendarId: CALENDAR_ID,
    eventId: EVENT_ID,
    scope: SCOPE,
    notify: NOTIFY,
    changes: DRAFT.partial().strict(),
    destinationCalendarId: CALENDAR_ID.nullish(),
  })
  .strict();

const DELETE_BODY = z
  .object({ calendarId: CALENDAR_ID, eventId: EVENT_ID, scope: SCOPE, notify: NOTIFY })
  .strict();

async function context(auth: AuthContext): Promise<WriteContext | null> {
  const store = getStore();
  const found = await calendarSource(store, auth.organizationId, auth.profile.email);
  if (!found.ok) return null;
  return {
    store,
    organizationId: auth.organizationId,
    userId: auth.userId,
    source: found.source,
  };
}

function respond(result: Result<{ event: unknown; reload: boolean }>) {
  return result.ok
    ? done({ event: result.value.event, reload: result.value.reload })
    : fail(result.error);
}

const NOT_CONNECTED = { code: 'not_configured' as const, message: 'No calendar is connected.' };
const INVALID = (message: string) => ({ code: 'invalid_input' as const, message });

export async function POST(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const parsed = CREATE.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(INVALID('Check the event and try again.'));
  const ctx = await context(gate.auth);
  if (!ctx) return fail(NOT_CONNECTED);
  return respond(await createCalendarEvent(ctx, parsed.data));
}

export async function PATCH(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const parsed = UPDATE.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(INVALID('Check the change and try again.'));
  const ctx = await context(gate.auth);
  if (!ctx) return fail(NOT_CONNECTED);
  return respond(await updateCalendarEvent(ctx, parsed.data));
}

export async function DELETE(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const parsed = DELETE_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(INVALID('That event could not be deleted.'));
  const ctx = await context(gate.auth);
  if (!ctx) return fail(NOT_CONNECTED);
  return respond(await deleteCalendarEvent(ctx, parsed.data));
}
