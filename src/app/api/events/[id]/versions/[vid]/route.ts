import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { ownerActor } from '@/lib/services/events';
import { getVersion } from '@/lib/services/event-versions';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; vid: string }> };

/** One version's page, for the read-only preview in Studio's canvas. */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('version', { max: 120, write: false });
  if (!gate.ok) return gate.response;
  const { id, vid } = await context.params;
  const result = await getVersion(getStore(), ownerActor(gate.owner), id, vid);
  return respond(result, ({ version, doc }) => ({
    version: {
      id: version.id,
      version: version.version,
      kind: version.kind,
      name: version.name,
      draftVersion: version.draft_version,
      authorName: version.author_name,
      createdAt: version.created_at,
    },
    doc,
  }));
}
