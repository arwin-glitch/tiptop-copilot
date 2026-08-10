import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { generateDailyBrief } from '@/lib/services/brief';
import { ensureGmailWatch } from '@/lib/services/gmail-watch';
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

  // `?tasks=sync` runs the mailbox sync and the watch renewal but skips brief
  // generation. This exists because the two want completely different
  // cadences: mail should be picked up every few minutes, while the outlook is
  // a once-a-morning artefact. Regenerating it on every poll would be ~40
  // deep-tier calls a day per organization — free today with no API key, and
  // the single largest line on the bill the moment there is one.
  const tasks = new URL(request.url).searchParams.get('tasks') ?? 'all';
  const briefsEnabled = tasks !== 'sync';

  const store = getStore();
  const results: {
    organization: string;
    sync: string;
    watch: string;
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
        watch: 'skipped',
        brief: 'skipped',
      });
      continue;
    }

    const profile = (await store.userProfileById(owner.user_id)) as UserProfile | null;
    if (!profile) {
      results.push({
        organization: organization.name,
        sync: 'skipped: no profile',
        watch: 'skipped',
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

    // Registers on the first run and renews thereafter. Gmail caps a watch at
    // seven days, and a lapsed one stops delivering silently — a mailbox that
    // has stopped notifying looks exactly like a quiet mailbox.
    let watchStatus: string;
    try {
      const watch = await ensureGmailWatch(auth);
      watchStatus = watch.ok ? watch.value.state : `failed: ${watch.error.code}`;
    } catch (error) {
      watchStatus = `failed: ${(error as Error)?.message?.slice(0, 120)}`;
      log.error('Cron watch renewal failed', { organizationId: organization.id });
    }

    let briefStatus: string;
    if (!briefsEnabled) {
      briefStatus = 'skipped: tasks=sync';
    } else {
      try {
        const brief = await generateDailyBrief(auth, { force: true });
        briefStatus = brief.ok ? 'ok' : `skipped: ${brief.error.code}`;
      } catch (error) {
        briefStatus = `failed: ${(error as Error)?.message?.slice(0, 120)}`;
        log.error('Cron brief generation failed', { organizationId: organization.id });
      }
    }

    results.push({
      organization: organization.name,
      sync: syncStatus,
      watch: watchStatus,
      brief: briefStatus,
    });
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
