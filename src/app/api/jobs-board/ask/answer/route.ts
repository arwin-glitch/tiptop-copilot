import type { NextRequest } from 'next/server';
import { jobsChatDone, jobsChatFail, jobsChatGate } from '@/lib/jobs-board/route-helpers';
import { publicChatSetup, readJobsChatAnswer } from '@/lib/services/jobs-chat';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The board assistant's poll for a routine answer: pending, answered (plain
 * text, made safe on the way in) or expired. Public: no session, read-only,
 * braked per address (the widget asks every few seconds for up to three
 * minutes).
 */
export async function GET(request: NextRequest) {
  const gate = jobsChatGate(request, { bucket: 'jobs-chat-answer', max: 90, windowMs: 600_000 });
  if (!gate.ok) return gate.response;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!UUID.test(id)) {
    return jobsChatFail({ code: 'not_found', message: 'That question is not here any more.' });
  }
  const setup = await publicChatSetup();
  if (!setup.ok) {
    return jobsChatFail({
      code: 'not_found',
      message: 'The assistant is not available right now.',
    });
  }
  const view = await readJobsChatAnswer(setup.store, setup.organizationId, id);
  if (!view) {
    return jobsChatFail({ code: 'not_found', message: 'That question is not here any more.' });
  }
  return jobsChatDone({ status: view.status, answer: view.answer });
}
