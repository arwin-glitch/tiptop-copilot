import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { answerBridgeQuestion, listPendingBridgeQuestions } from '@/lib/services/ask-bridge';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The Ask bridge: lets a question asked on the Ask page be answered by an
 * external Claude session with live Gmail/Calendar/Slack access, instead of
 * the in-app Anthropic call, which only ever sees data already synced into
 * this app's own tables.
 *
 * GET lists questions waiting for an answer. POST delivers one. Both share
 * the same token-authenticated shape as the briefing webhook, and the same
 * reasoning: the sender is a cloud routine or local task, and a routine's own
 * prompt — where this token lives — is returned in full by the routines API
 * on every `get`, `run`, and run log, so the value is assumed public. Holding
 * it should let someone read pending questions and answer them — nothing
 * more; it cannot ask a question, read any other table, or act as a user.
 */

const ANSWER_SCHEMA = z.object({
  message_id: z.string().uuid(),
  answer: z.string().trim().min(1).max(20_000),
});

function checkToken(request: NextRequest): NextResponse | null {
  const token = env().askBridgeToken;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'not_configured', message: 'ASK_BRIDGE_TOKEN is not set.' },
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

  return null;
}

export async function GET(request: NextRequest) {
  const denied = checkToken(request);
  if (denied) return denied;

  const organizationId = await soleOrganizationId('ask-bridge-webhook');
  if (!organizationId) return NextResponse.json({ ok: true, pending: [] });

  const pending = await listPendingBridgeQuestions(getStore(), organizationId);
  return NextResponse.json({ ok: true, pending });
}

export async function POST(request: NextRequest) {
  const denied = checkToken(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: true, skipped: 'body is not JSON' });
  }

  const parsed = ANSWER_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Ask bridge answer payload failed validation', { issues: parsed.error.issues.length });
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const organizationId = await soleOrganizationId('ask-bridge-webhook');
  if (!organizationId) {
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
  }

  const result = await answerBridgeQuestion(
    getStore(),
    organizationId,
    parsed.data.message_id,
    parsed.data.answer,
  );
  if (!result.ok) return NextResponse.json({ ok: true, skipped: result.reason });
  return NextResponse.json({ ok: true, message_id: parsed.data.message_id });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
