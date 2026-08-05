import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { capabilityReport, envLimits } from '@/lib/config/env';
import { getAI, getResearchProvider, getStore } from '@/lib/runtime';
import { getUsageWindow } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/**
 * Authenticated health check.
 *
 * Reports dependency reachability and capability status. Like the diagnostics
 * page, it reports presence and shape only — never a secret value.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const store = getStore();
  const ai = getAI();
  const research = getResearchProvider();
  const checks = capabilityReport();

  let databaseReachable = false;
  let databaseError: string | null = null;
  try {
    await store.count('deals', auth.value.organizationId);
    databaseReachable = true;
  } catch (error) {
    databaseError = (error as Error)?.message?.slice(0, 200) ?? 'unknown error';
  }

  const usage = await getUsageWindow(store, auth.value.organizationId, auth.value.userId).catch(
    () => null,
  );

  const missingRequired = checks
    .filter((c) => c.required && c.status === 'missing')
    .map((c) => c.key);

  const healthy = databaseReachable && missingRequired.length === 0;

  return NextResponse.json(
    {
      ok: healthy,
      status: healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      organization: auth.value.organization.name,
      dependencies: {
        database: {
          kind: store.kind,
          reachable: databaseReachable,
          error: databaseError,
        },
        ai: { kind: ai.kind, available: ai.available() },
        research: { kind: research.kind, available: research.available() },
      },
      capabilities: checks.map((c) => ({
        key: c.key,
        status: c.status,
        required: c.required,
      })),
      missingRequired,
      limits: envLimits(),
      usage: usage
        ? { requestsThisHour: usage.requestsThisHour, spendTodayUsd: usage.spendTodayUsd }
        : null,
    },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
