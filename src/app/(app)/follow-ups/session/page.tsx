import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { canSend } from '@/lib/google/gmail-send';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { readEmailSession } from '@/lib/services/email-session';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/feedback';
import { EmailSessionClient } from '@/components/followups/email-session-client';
import { relativeTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Email session' };
export const dynamic = 'force-dynamic';

export default async function EmailSessionPage() {
  const auth = await requireAuth();
  const store = getStore();
  const now = new Date();
  const [session, integration] = await Promise.all([
    readEmailSession(store, auth.organizationId, { now }),
    getPrimaryIntegration(store, auth.organizationId),
  ]);

  return (
    <PageShell>
      <Link
        href="/follow-ups"
        className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden /> Follow-ups
      </Link>
      <PageHeader
        title="Email session"
        subtitle={
          session.runAt
            ? `One email at a time, most important first. Queue checked ${relativeTime(session.runAt, now)}.`
            : 'One email at a time, most important first.'
        }
      />
      {session.state === 'ok' ? (
        <EmailSessionClient
          items={session.items}
          canSend={canSend(integration) && !auth.isDemo}
          mailbox={integration?.account_email ?? DEFAULT_MAILBOX}
          isDemo={auth.isDemo}
        />
      ) : (
        <Notice>
          <p>
            {session.state === 'unavailable'
              ? 'The email queue could not be read right now. Try again in a minute.'
              : 'Your email queue fills after the next For Nick refresh.'}
          </p>
        </Notice>
      )}
    </PageShell>
  );
}
