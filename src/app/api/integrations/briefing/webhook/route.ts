import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { ingestRoutineBriefing, ROUTINE_BRIEFING_SCHEMA } from '@/lib/services/briefing';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The Today-page briefing card, posted by the Daily Overview (morning) and
 * Daily Recap (afternoon) cloud routines once each finishes its run.
 *
 * Token-authenticated the same way the Granola bridge is, and for the same
 * reason: the sender is a cloud routine, and the routines API returns a
 * routine's full prompt on every `get`, `run`, and run log, so any credential
 * living inside that prompt is assumed public the moment it is set. This
 * token can only overwrite the briefing card — nothing else accepts it.
 */
export async function POST(request: NextRequest) {
  const token = env().briefingBridgeToken;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'BRIEFING_BRIDGE_TOKEN is not set, so this endpoint accepts no posts.',
        },
      },
      { status: 503 },
    );
  }

  const provided = new URL(request.url).searchParams.get('token') ?? '';
  if (!constantTimeEquals(provided, token)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid webhook token.' } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, skipped: 'body is not JSON' });
  }

  const parsed = ROUTINE_BRIEFING_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Briefing webhook payload failed validation', { issues: parsed.error.issues.length });
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const organizationId = await soleOrganizationId('briefing-webhook');
  if (!organizationId) {
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
  }

  const briefing = await ingestRoutineBriefing(getStore(), organizationId, parsed.data);
  return NextResponse.json({ ok: true, kind: briefing.kind, date_key: briefing.date_key });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
