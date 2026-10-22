import 'server-only';
import type { NextResponse } from 'next/server';
import { fail } from '@/lib/events/route-helpers';

/**
 * Shared by WS4's signed-in host routes (/api/events/[id]/guests,
 * /registration, /checkin): a size-capped JSON body. Auth is
 * route-helpers' eventsAuth, as for every /api/events route.
 */
export async function readHostBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) {
    return {
      ok: false,
      response: fail({ code: 'too_large', message: 'That request is too large.' }),
    };
  }
  const text = await request.text().catch(() => '');
  if (text.length > maxBytes) {
    return {
      ok: false,
      response: fail({ code: 'too_large', message: 'That request is too large.' }),
    };
  }
  try {
    return { ok: true, body: JSON.parse(text || 'null') as unknown };
  } catch {
    return {
      ok: false,
      response: fail({ code: 'invalid_input', message: 'That request could not be read.' }),
    };
  }
}
