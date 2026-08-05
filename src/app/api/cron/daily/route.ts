import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { generateDailyBrief } from '@/lib/services/brief';
import { syncMailbox } from '@/lib/services/inbox';
import type { AuthContext } from '@/lib/auth/session';
import type { Organization, OrganizationMember, UserProfile } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduled job: sync mailboxes and pre-generate the daily outlook.
 *
 * Authenticated with a bearer token compared in constant time. If CRON_SECRET
 * is unset the endpoint refuses every caller rather than running open — an
 * unauthenticated job that spends money is worse than a job that does not run.
 *
 * Every step is individually fault-tolerant: one organization failing does not
 * stop the rest, and the response reports exactly what succeeded.
 */
export async function POST(request: NextRequest) {
  const secret = env().cronSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'CRON_SECRET is not set. Scheduled jobs are disabled.',
        },
      },
      { status: 503 },
    );
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid cron token.' } },
      { status: 401 },
    );
  }

  const store = getStore();
  const results: {
    organization: string;
    sync: string;
    brief: string;
  }[] = [];

  let organizations: Organization[] = [];
  try {
    organizations = (await store.list('organizations', '', {})) as Organization[];
  } catch (error) {
    log.error('Cron could not enumerate organizations', {
      reason: (error as Error)?.message,
    });
    return NextResponse.json(
      { ok: false, error: { code: 'internal', message: 'Could not read organizations.' } },
      { status: 500 },
    );
  }

  for (const organization of organizations) {
    const members = (await store.list('organization_members', organization.id, {})) as
      OrganizationMember[] | [];
    const owner = members.find((m) => m.role === 'owner') ?? members[0];
    if (!owner) {
      results.push({
        organization: organization.name,
        sync: 'skipped: no members',
        brief: 'skipped',
      });
      continue;
    }

    const profile = (await store.userProfileById(owner.user_id)) as UserProfile | null;
    if (!profile) {
      results.push({
        organization: organization.name,
        sync: 'skipped: no profile',
        brief: 'skipped',
      });
      continue;
    }

    const auth: AuthContext = {
      userId: owner.user_id,
      organizationId: organization.id,
      role: owner.role,
      profile,
      organization,
      isDemo: env().demoMode,
    };

    let syncStatus: string;
    try {
      const sync = await syncMailbox(auth);
      syncStatus = sync.ok
        ? `ok: ${sync.value.created} new, ${sync.value.classified} classified`
        : `skipped: ${sync.error.code}`;
    } catch (error) {
      syncStatus = `failed: ${(error as Error)?.message?.slice(0, 120)}`;
      log.error('Cron sync failed', { organizationId: organization.id });
    }

    let briefStatus: string;
    try {
      const brief = await generateDailyBrief(auth, { force: true });
      briefStatus = brief.ok ? 'ok' : `skipped: ${brief.error.code}`;
    } catch (error) {
      briefStatus = `failed: ${(error as Error)?.message?.slice(0, 120)}`;
      log.error('Cron brief generation failed', { organizationId: organization.id });
    }

    results.push({ organization: organization.name, sync: syncStatus, brief: briefStatus });
  }

  return NextResponse.json(
    { ok: true, ranAt: new Date().toISOString(), results },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
