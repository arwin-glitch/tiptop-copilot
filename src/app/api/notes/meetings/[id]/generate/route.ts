import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { GENERATE_NOTES } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { generateNotes } from '@/lib/services/notes-generate';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Generate or regenerate the notes, optionally with another template (GenerateNotesRequest). */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'generate', max: 20, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, GENERATE_NOTES);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const note = await generateNotes(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.templateId,
  );
  return note.ok ? done({ note: note.value }) : fail(note.error);
}
