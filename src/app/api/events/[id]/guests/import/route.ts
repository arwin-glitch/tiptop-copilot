import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { IMPORT_MAX_BYTES } from '@/lib/events/csv';
import { readHostBody } from '@/lib/events/host-routes';
import { UUID_RE } from '@/lib/events/registration';
import { eventsAuth, fail, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { importGuests } from '@/lib/services/event-guests';

/**
 * POST /api/events/[id]/guests/import — CSV import (D-075). With
 * commit:false it returns a preview: the detected email column, the header
 * mapping (to names, company, title, phone, tags or questions), a sample,
 * how many are new or already on the list, and the rows without an email.
 * With commit:true it adds them (deduplicated on email), with the chosen
 * sessions, tags and status, and audits the import.
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const target = z
  .string()
  .regex(
    /^(email|first_name|last_name|full_name|company|title|phone|tags|ignore|question:[0-9a-fA-F-]{36})$/,
  );

const body = z.strictObject({
  csv: z.string().min(1).max(IMPORT_MAX_BYTES),
  mapping: z.record(z.string().max(200), target).optional(),
  sessionIds: z.array(z.string().regex(UUID_RE)).max(20).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),
  status: z.enum(['invited', 'going']).default('invited'),
  commit: z.boolean().default(false),
});

export async function POST(request: NextRequest, context: Context) {
  const gate = await eventsAuth('guests-import', { max: 30 });
  if (!gate.ok) return gate.response;
  const read = await readHostBody(request, IMPORT_MAX_BYTES + 64 * 1024);
  if (!read.ok) return read.response;
  const parsed = body.safeParse(read.body);
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'That file could not be read.',
    });
  }
  const { id } = await context.params;
  const result = await importGuests(getStore(), gate.owner, id, {
    ...parsed.data,
    mapping: parsed.data.mapping as Parameters<typeof importGuests>[3]['mapping'],
  });
  return respond(result, (preview) => ({ preview }));
}
