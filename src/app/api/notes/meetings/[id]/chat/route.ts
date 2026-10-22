import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { NOTES_CHAT } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { chatAboutMeetings } from '@/lib/services/notes-generate';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Ask about this meeting, a person, a company or all meetings (NotesChatRequest → NotesChatResponse). */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'chat', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, NOTES_CHAT);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const answer = await chatAboutMeetings({ store: getStore(), auth: gate.auth }, id, body.value);
  return answer.ok ? done({ ...answer.value }) : fail(answer.error);
}
