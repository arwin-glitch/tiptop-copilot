import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { unpublishEvent } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The public URL answers 404 again; every guest is kept. */
export async function POST(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('unpublish', { max: 20 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const result = await unpublishEvent(getStore(), gate.owner, id);
  return respond(result, (event) => ({
    event: { id: event.id, status: event.status, publishedVersion: event.published_version },
  }));
}
