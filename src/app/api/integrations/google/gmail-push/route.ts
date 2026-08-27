import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '@/lib/auth/session';
import { env } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { syncMailbox } from '@/lib/services/inbox';
import type {
  Integration,
  Organization,
  OrganizationMember,
  UserProfile,
} from '@/lib/types/domain';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Gmail push notifications, delivered by Cloud Pub/Sub.
 *
 * Gmail never calls an application directly. It publishes to a Pub/Sub topic;
 * a push subscription on that topic POSTs here. The body carries an email
 * address and a historyId and nothing else — not the message, not the sender.
 * So this endpoint is a doorbell: it identifies the mailbox and runs the same
 * incremental sync the Sync button runs.
 *
 * Authentication is a shared secret in the subscription URL, compared in
 * constant time. Pub/Sub can sign requests with an OIDC token instead, which is
 * stronger, but verifying it means fetching and caching Google's JWKS — worth
 * doing if this endpoint ever does more than trigger a sync it is already
 * possible to trigger from the UI.
 *
 * Always answers 2xx once the secret checks out, including on failure.
 * Pub/Sub retries anything else with backoff, and a mailbox that cannot sync
 * will not start syncing because Google asked four more times — it would just
 * wake a sleeping instance repeatedly. Failures are logged, not signalled.
 */
export async function POST(request: NextRequest) {
  const secret = env().cronSecret;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: 'CRON_SECRET is not set. Push notifications are disabled.',
        },
      },
      { status: 503 },
    );
  }

  const provided = new URL(request.url).searchParams.get('token') ?? '';
  if (!constantTimeEquals(provided, secret)) {
    return NextResponse.json(
      { ok: false, error: { code: 'unauthenticated', message: 'Invalid push token.' } },
      { status: 401 },
    );
  }

  const emailAddress = await readEmailAddress(request);
  if (!emailAddress) {
    // Malformed, or a Pub/Sub subscription verification ping. Acknowledge it:
    // returning an error would make Google retry a body that will never parse.
    return NextResponse.json({ ok: true, skipped: 'no email address in payload' });
  }

  const store = getStore();

  try {
    // A push notification names a mailbox, never an organization, so the
    // organization has to be resolved before anything scoped can be read.
    //
    // This used to list integrations with an empty organization id, meaning
    // "across every tenant". The demo store read that as "matches nothing" and
    // returned an empty array; Postgres read it as `organization_id = ''` and
    // rejected it as an invalid uuid. So every push in production died in the
    // catch below — logged as `handler_error`, answered 2xx, invisible — while
    // the suites, which run on the demo store, stayed green. `assertScoped`
    // now makes both stores refuse it identically.
    const organizationId = await soleOrganizationId('gmail-push');
    if (!organizationId) {
      return NextResponse.json({ ok: true, skipped: 'no unambiguous organization' });
    }

    const integrations = (await store.list('integrations', organizationId, {
      eq: { provider: 'google' },
    })) as Integration[];
    const integration = integrations.find(
      (i) => i.account_email?.toLowerCase() === emailAddress.toLowerCase(),
    );

    if (!integration) {
      log.warn('Gmail push for an unknown mailbox', { hasIntegration: false });
      return NextResponse.json({ ok: true, skipped: 'no matching integration' });
    }

    const auth = await authForIntegration(integration);
    if (!auth) {
      return NextResponse.json({ ok: true, skipped: 'integration has no resolvable owner' });
    }

    const sync = await syncMailbox(auth);
    if (!sync.ok) {
      log.warn('Gmail push sync did not complete', { code: sync.error.code });
      return NextResponse.json({ ok: true, synced: false, reason: sync.error.code });
    }

    return NextResponse.json({
      ok: true,
      synced: true,
      created: sync.value.created,
      classified: sync.value.classified,
    });
  } catch (error) {
    log.error('Gmail push handler failed', {
      reason: (error as Error)?.message?.slice(0, 200) ?? 'unknown',
    });
    // Still 2xx. See the note above on retries.
    return NextResponse.json({ ok: true, synced: false, reason: 'handler_error' });
  }
}

/**
 * Pull the mailbox address out of a Pub/Sub push envelope.
 *
 * The interesting payload is base64 inside `message.data`, and decodes to
 * `{"emailAddress":"…","historyId":…}`. The historyId is deliberately ignored:
 * `integrations.sync_cursor` already holds where the last sync finished, and
 * trusting the notification's id instead would skip anything that arrived
 * between the two.
 */
async function readEmailAddress(request: NextRequest): Promise<string | null> {
  try {
    const body = (await request.json()) as { message?: { data?: string } };
    const data = body?.message?.data;
    if (!data) return null;
    const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
      emailAddress?: string;
    };
    return decoded?.emailAddress ?? null;
  } catch {
    return null;
  }
}

/** The same shape the scheduled job builds, for the integration's own owner. */
async function authForIntegration(integration: Integration): Promise<AuthContext | null> {
  const store = getStore();

  const organization = (await store.organizationById(
    integration.organization_id,
  )) as Organization | null;
  if (!organization) return null;

  const profile = (await store.userProfileById(integration.user_id)) as UserProfile | null;
  if (!profile) return null;

  const members = (await store.list('organization_members', organization.id, {})) as
    OrganizationMember[] | [];
  const membership = members.find((m) => m.user_id === integration.user_id);
  if (!membership) return null;

  return {
    userId: integration.user_id,
    organizationId: organization.id,
    role: membership.role,
    profile,
    organization,
    isDemo: env().demoMode,
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
