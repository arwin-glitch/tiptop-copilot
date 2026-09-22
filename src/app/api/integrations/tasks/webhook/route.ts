import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { ingestTasks, TASK_INGEST_SCHEMA } from '@/lib/services/task-ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * New follow-up tasks, posted by the watcher that notices something needing
 * a human's attention (an unanswered ask with a deadline, a promise made in
 * a meeting or on Slack).
 *
 * Token-authenticated like the portfolio and briefing webhooks, and for the
 * same reason: a sender that lives in a routine's prompt is assumed public.
 * This token can only add a task that does not already exist by title — it
 * cannot complete, edit or delete anything.
 */
export async function POST(request: NextRequest) {
  const token = env().taskBridgeToken;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'TASK_BRIDGE_TOKEN is not set, so this endpoint accepts no posts.',
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

  const parsed = TASK_INGEST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    log.warn('Task webhook payload failed validation', { issues: parsed.error.issues.length });
    return NextResponse.json({
      ok: true,
      skipped: 'payload failed validation',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const organizationId = await soleOrganizationId('task-webhook');
  if (!organizationId) {
    return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
  }

  const result = await ingestTasks(getStore(), organizationId, parsed.data);
  return NextResponse.json({ ok: true, ...result });
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
