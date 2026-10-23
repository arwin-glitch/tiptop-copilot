import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { NOTES_CHAT } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { askAboutMeetings, readMeetingChatAnswer } from '@/lib/services/notes-chat';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ask about this meeting, a person, a company or all meetings
 * (NotesChatRequest → NotesChatResponse). Through the Ask bridge the answer
 * is 'pending': poll GET with its messageId.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'chat', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, NOTES_CHAT);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const answer = await askAboutMeetings({ store: getStore(), auth: gate.auth }, id, body.value);
  return answer.ok ? done({ ...answer.value }) : fail(answer.error);
}

/** GET ?messageId=: a pending answer, once Arwin's routine has posted it (NotesChatResponse). */
export async function GET(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'chat-read', max: 240 });
  if (!gate.ok) return gate.response;
  const messageId = request.nextUrl.searchParams.get('messageId') ?? '';
  if (!UUID.test(messageId)) {
    return fail({ code: 'invalid_input', message: 'Say which answer to read (messageId).' });
  }
  const { id } = await context.params;
  const answer = await readMeetingChatAnswer({ store: getStore(), auth: gate.auth }, id, messageId);
  return answer.ok ? done({ ...answer.value }) : fail(answer.error);
}
