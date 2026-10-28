import type { NextRequest } from 'next/server';
import {
  jobsChatDone,
  jobsChatFail,
  jobsChatGate,
  readSmallJson,
} from '@/lib/jobs-board/route-helpers';
import { answerJobsQuestion, JOBS_CHAT_REQUEST, publicChatSetup } from '@/lib/services/jobs-chat';

export const dynamic = 'force-dynamic';

/**
 * "Ask Arwin" on the public job board: one question, answered from the
 * published roles, then the written answers, then (only when set up and
 * switched on) the jobs assistant routine on Arwin's own Claude plan. Public:
 * no session and no cookie, from the board's own page, braked per address
 * before anything is read. Served on the board's own host too
 * (lib/jobs-board/host.ts).
 */
export async function POST(request: NextRequest) {
  const gate = jobsChatGate(request, {
    write: true,
    bucket: 'jobs-chat',
    max: 30,
    windowMs: 600_000,
  });
  if (!gate.ok) return gate.response;
  const body = await readSmallJson(request, 4_000);
  const parsed = JOBS_CHAT_REQUEST.safeParse(body ?? {});
  if (!parsed.success) {
    return jobsChatFail({ code: 'invalid_input', message: 'That question could not be read.' });
  }
  const setup = await publicChatSetup();
  if (!setup.ok) {
    return jobsChatFail({
      code: 'not_found',
      message: 'The assistant is not available right now.',
    });
  }
  const reply = await answerJobsQuestion(parsed.data, {
    store: setup.store,
    organizationId: setup.organizationId,
    board: setup.board,
    assistant: setup.assistant,
    base: gate.visitor.base,
    ipHash: gate.visitor.ipHash,
  });
  return jobsChatDone({ reply });
}
