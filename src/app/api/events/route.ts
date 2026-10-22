import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { createEvent, listEvents } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

const TABS = ['upcoming', 'drafts', 'past', 'templates'] as const;

/** The Events library: GET /api/events?tab=upcoming|drafts|past|templates&q= */
export async function GET(request: NextRequest) {
  const gate = await eventsAuth('list', { max: 240, write: false });
  if (!gate.ok) return gate.response;
  const tabParam = request.nextUrl.searchParams.get('tab');
  const tab = TABS.find((t) => t === tabParam);
  const search = request.nextUrl.searchParams.get('q')?.slice(0, 140) ?? undefined;
  const events = await listEvents(getStore(), gate.auth.organizationId, { tab, search });
  return respond(events, (list) => ({ events: list }));
}

const iso = z.string().max(40).nullable().optional();

const BODY = z.object({
  title: z.string().max(140),
  slug: z.string().max(50).optional(),
  timeZone: z.string().max(64).optional(),
  startsAt: iso,
  endsAt: iso,
  sessions: z
    .array(
      z.object({
        name: z.string().max(120),
        startsAt: z.string().max(40).nullable(),
        endsAt: z.string().max(40).nullable(),
        capacity: z.number().int().min(0).max(100_000).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
  venue: z
    .object({
      kind: z.enum(['in_person', 'online', 'hybrid']).optional(),
      name: z.string().max(200).nullable().optional(),
      address: z.string().max(400).nullable().optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      place_id: z.string().max(200).nullable().optional(),
      maps_url: z.string().max(2000).nullable().optional(),
      online_url: z.string().max(2000).nullable().optional(),
      reveal: z.enum(['public', 'registered', 'going']).optional(),
      notes: z.string().max(2000).nullable().optional(),
    })
    .optional(),
  starterId: z.string().max(64).optional(),
  themePresetId: z.string().max(64).optional(),
});

/** Create a draft event (the New event dialog). Nothing is public until Publish. */
export async function POST(request: NextRequest) {
  const gate = await eventsAuth('create', { max: 30 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That event could not be read.' });
  const created = await createEvent(getStore(), gate.owner, parsed.data);
  return respond(created, (event) => ({ id: event.id, slug: event.slug }));
}
