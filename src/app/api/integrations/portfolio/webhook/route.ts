import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { ingestPortfolioCompanies, PORTFOLIO_INGEST_SCHEMA } from '@/lib/services/portfolio-ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * New portfolio companies, posted by the watchers that notice a new
 * investment (the Schedule of Investments sheet check and the closed-deal
 * mailbox routine).
 *
 * Token-authenticated like the briefing webhook, and for the same reason: a
 * sender that lives in a routine's prompt is assumed public. This token can
 * only add companies that are not already listed, or fill a blank stage,
 * website or founder on one that is — it cannot overwrite a value, archive
 * or read anything.
 */
export async function POST(request: NextRequest) {
  const token = env().portfolioBridgeToken;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'PORTFOLIO_BRIDGE_TOKEN is not set, so this endpoint accepts no posts.',
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

  const parsed = PORTFOLIO_INGEST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Portfolio webhook payload failed validation', { issues: parsed.error.issues.length });
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const organizationId = await soleOrganizationId('portfolio-webhook');
  if (!organizationId) {
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
  }

  const result = await ingestPortfolioCompanies(getStore(), organizationId, parsed.data);
  return NextResponse.json({ ok: true, ...result });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
