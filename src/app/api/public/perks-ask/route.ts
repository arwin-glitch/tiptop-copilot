import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { publicDone, publicFail, readJson } from '@/lib/booking/route-helpers';
import { answerPerksQuestion } from '@/lib/perks-ask/service';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit, rateLimitHasRoom } from '@/lib/security/limits';

export const dynamic = 'force-dynamic';

/**
 * The Ask Arwin widget on perks.tiptop.vc (D-079) — the one route in the app
 * that answers a different site. CORS is therefore explicit here: only the
 * perks site's origin is allowed, with Vary: Origin on every response. The
 * Origin check is hygiene, not authentication — a scripted caller can forge
 * the header — so the real bounds are the per-address and shared brakes below
 * plus the dedicated key's own workspace spend cap (see lib/perks-ask).
 */

const PERKS_ORIGIN = 'https://perks.tiptop.vc';

/** Only user turns are accepted: client-supplied assistant turns are the
 * classic persona-priming vector, so the contract does not even admit them. */
const ASK_REQUEST = z
  .object({
    messages: z
      .array(z.object({ role: z.literal('user'), content: z.string().min(1).max(1_500) }).strict())
      .min(1)
      .max(6),
  })
  .strict();

/** The combined questions a single turn may carry into the prompt. */
const MAX_COMBINED_CHARS = 6_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': PERKS_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};

function withCors(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(corsHeaders)) response.headers.set(name, value);
  return response;
}

export function OPTIONS(): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin') ?? '';
  if (origin !== PERKS_ORIGIN) {
    return withCors(
      publicFail({ code: 'forbidden', message: 'That request did not come from the perks site.' }),
    );
  }

  // Brakes: a narrow per-address window, then a shared ceiling so one flood
  // cannot spend the whole key. Checked before charging, per lib/security/limits.
  const key = addressKey(request.headers);
  if (!rateLimitHasRoom('perks-ask:all', 120)) {
    return withCors(
      publicFail({
        code: 'rate_limited',
        message: 'Ask Arwin is busy - try again in a few minutes.',
      }),
    );
  }
  const narrow = rateLimit(`perks-ask:${key}`, 10, 60_000);
  if (!narrow.ok) return withCors(publicFail(narrow.error));
  const shared = rateLimit('perks-ask:all', 120, 600_000);
  if (!shared.ok) return withCors(publicFail(shared.error));

  const body = await readJson(request, 12_000);
  const parsed = ASK_REQUEST.safeParse(body ?? {});
  if (!parsed.success) {
    return withCors(
      publicFail({ code: 'invalid_input', message: 'That question could not be read.' }),
    );
  }

  // Trim oldest questions until the combined size is modest; the newest
  // question is what actually matters for the answer.
  const questions = parsed.data.messages.map((m) => m.content);
  while (questions.length > 1 && questions.join('\n').length > MAX_COMBINED_CHARS) {
    questions.shift();
  }

  const answer = await answerPerksQuestion(questions);
  if (!answer.ok) return withCors(publicFail(answer.error));
  return withCors(publicDone({ reply: answer.value.reply }));
}
