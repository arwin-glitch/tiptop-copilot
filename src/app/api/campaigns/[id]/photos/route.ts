import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { UPLOAD_CHUNK_BYTES } from '@/lib/campaigns/limits';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStorage, getStore } from '@/lib/runtime';
import {
  addPhotoChunk,
  assignPhoto,
  matchPhotosByName,
  removePhoto,
} from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const header = (request: NextRequest, name: string) => request.headers.get(name) ?? '';

/**
 * One piece of a per-recipient photo, as the raw request body: the same
 * pieces-under-the-proxy's-buffer upload as attachments. When the last piece
 * lands, the photo joins the campaign's set and is given to the one recipient
 * its file name names, if exactly one does.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('upload', 240);
  if (!gate.ok) return gate.response;
  const length = Number(header(request, 'content-length') || 0);
  if (length > UPLOAD_CHUNK_BYTES + 1024) {
    return fail({ code: 'too_large', message: 'That piece is too large. Reload and try again.' });
  }
  let name = '';
  try {
    name = decodeURIComponent(header(request, 'x-file-name'));
  } catch {
    return fail({ code: 'invalid_input', message: 'That file name is not valid.' });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const { id } = await context.params;
  const result = await addPhotoChunk(
    getStore(),
    getStorage(),
    gate.auth.organizationId,
    id,
    {
      uploadId: header(request, 'x-upload-id'),
      index: Number(header(request, 'x-chunk-index')),
      count: Number(header(request, 'x-chunk-count')),
      name,
      type: header(request, 'x-file-type').slice(0, 200),
      size: Number(header(request, 'x-file-size')),
    },
    bytes,
  );
  return respond(result, (r) => ({ ...r }));
}

const PATCH_BODY = z.union([
  z.object({ recipientId: z.string().max(64), photoId: z.string().max(64).nullable() }),
  z.object({ match: z.literal(true) }),
]);

/**
 * Give a recipient a photo from the set, change or clear it (`photoId` null),
 * or run the match by file name again for the photos nobody has (`match`).
 */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit', 300);
  if (!gate.ok) return gate.response;
  const parsed = PATCH_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return fail({ code: 'invalid_input', message: 'That change was not valid.' });
  const { id } = await context.params;
  const store = getStore();
  const org = gate.auth.organizationId;
  if ('match' in parsed.data) {
    return respond(await matchPhotosByName(store, org, id), (r) => ({ ...r }));
  }
  const result = await assignPhoto(store, org, id, {
    recipientId: parsed.data.recipientId,
    photoId: parsed.data.photoId,
  });
  return respond(result, (photos) => ({ photos }));
}

/** Take a photo out of the set (`?photo=<id>`), and off whoever had it. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const photo = request.nextUrl.searchParams.get('photo') ?? '';
  const result = await removePhoto(getStore(), getStorage(), gate.auth.organizationId, id, photo);
  return respond(result, (photos) => ({ photos }));
}
