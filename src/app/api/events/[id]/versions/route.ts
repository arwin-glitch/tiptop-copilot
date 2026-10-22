import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { createNamedVersion, listVersions } from '@/lib/services/event-versions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** The History drawer: versions newest first, each with what changed since the one before. */
export async function GET(request: NextRequest, context: Context) {
  const gate = await eventsAuth('versions', { max: 120, write: false });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50');
  const versions = await listVersions(getStore(), ownerActor(gate.owner), id, {
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return respond(versions, (list) => ({ versions: list }));
}

const BODY = z.object({ name: z.string().max(120) }).strict();

/** Name the current draft ("Before Morgan's pass"). Named versions are kept forever. */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('versions-name', { max: 30 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Give the version a name.' });
  const { id } = await context.params;
  const version = await createNamedVersion(
    getStore(),
    ownerActor(gate.owner),
    id,
    parsed.data.name,
  );
  return respond(version, (v) => ({ version: v }));
}
