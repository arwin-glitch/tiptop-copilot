import type { NextRequest } from 'next/server';
import { UPLOAD_CHUNK_BYTES } from '@/lib/campaigns/limits';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStorage, getStore } from '@/lib/runtime';
import { addAttachmentChunk, removeAttachment } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const header = (request: NextRequest, name: string) => request.headers.get(name) ?? '';

/**
 * One piece of an attachment, as the raw request body. The page cuts each
 * file into pieces under the proxy's 10MB request buffer (which would cut a
 * larger body short) and names the piece in headers.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await campaignAuth('upload', 120);
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
  const result = await addAttachmentChunk(
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
  return respond(result, (r) => r);
}

/** Take an attachment off a draft (`?attachment=<id>`). */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const attachment = request.nextUrl.searchParams.get('attachment') ?? '';
  const result = await removeAttachment(
    getStore(),
    getStorage(),
    gate.auth.organizationId,
    id,
    attachment,
  );
  return respond(result, (attachments) => ({ attachments }));
}
