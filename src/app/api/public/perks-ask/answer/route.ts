import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { publicDone, publicFail } from '@/lib/booking/route-helpers';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { readPerksAnswer } from '@/lib/perks-ask/bridge';
import { getStore } from '@/lib/runtime';
import { addressKey } from '@/lib/security/client-address';
import { rateLimit } from '@/lib/security/limits';

export const dynamic = 'force-dynamic';

/**
 * The perks widget's poll for a routine answer (D-079): pending, answered
 * (plain text, made safe on the way in) or expired. Public and cross-origin
 * like its POST sibling - same CORS, read-only, braked per address (the
 * widget asks every few seconds for up to two and a half minutes).
 */

const PERKS_ORIGIN = 'https://perks.tiptop.vc';

const corsHeaders = {
  'Access-Control-Allow-Origin': PERKS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin') ?? '';
  if (origin !== PERKS_ORIGIN) {
    return withCors(
      publicFail({ code: 'forbidden', message: 'That request did not come from the perks site.' }),
    );
  }
  const key = addressKey(request.headers);
  const braked = rateLimit(`perks-ask-answer:${key}`, 90, 600_000);
  if (!braked.ok) return withCors(publicFail(braked.error));

  const id = request.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return withCors(
      publicFail({ code: 'not_found', message: 'That question is not here any more.' }),
    );
  }
  const organizationId = await soleOrganizationId('perks-ask-answer');
  if (!organizationId) {
    return withCors(
      publicFail({ code: 'not_configured', message: 'Ask Arwin is not switched on yet.' }),
    );
  }
  const view = await readPerksAnswer(getStore(), organizationId, id);
  if (!view) {
    return withCors(
      publicFail({ code: 'not_found', message: 'That question is not here any more.' }),
    );
  }
  return withCors(publicDone({ status: view.status, answer: view.answer }));
}
