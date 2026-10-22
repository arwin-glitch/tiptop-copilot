import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { getPublishPreview, publishEvent } from '@/lib/services/events';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** What Publish would change (section-level diff with authors) and the Ready checklist. */
export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('publish-preview', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const preview = await getPublishPreview(getStore(), gate.owner, id);
  return respond(preview, (p) => ({ ...p }));
}

const BODY = z.object({ expectedDraftVersion: z.number().int().min(0) }).strict();

/**
 * Publish the draft the owner reviewed. 409 when it moved since the preview
 * (the dialog reloads the diff); 400 while an image lacks alt text.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('publish', { max: 20 });
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({ code: 'invalid_input', message: 'Reload the publish dialog and try again.' });
  }
  const { id } = await context.params;
  const published = await publishEvent(
    getStore(),
    gate.owner,
    id,
    parsed.data.expectedDraftVersion,
  );
  return respond(published, (r) => ({ ...r }));
}
