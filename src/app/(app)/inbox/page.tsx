import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { inboxThreadParam } from '@/lib/email/thread-links';
import { getStore } from '@/lib/runtime';
import { listLiveThreads, openFromLink } from '@/lib/services/inbox-live';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { SkeletonText } from '@/components/ui/feedback';
import { LiveInbox } from '@/components/inbox/live-inbox';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        subtitle="Nick's Gmail, live: read, reply, archive and star right here. Replies send from his inbox only when someone taps Send, with 8 seconds to undo."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <InboxContent searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

/**
 * `?thread=<id>` (a thread or a message id, from a "Copilot" email link
 * anywhere in the app) opens that conversation in the reading pane, wherever
 * it is filed, alongside the Primary list. Opening it changes nothing in
 * Gmail; a bad or unknown id says it couldn't open the email.
 */
async function InboxContent({ searchParams }: { searchParams: SearchParams }) {
  const [auth, params] = await Promise.all([requireAuth(), searchParams]);
  const store = getStore();
  const wanted = inboxThreadParam(params);
  const [initial, opened] = await Promise.all([
    listLiveThreads(store, auth.organizationId, { tab: 'primary' }),
    wanted ? openFromLink(store, auth.organizationId, wanted) : null,
  ]);
  return (
    <LiveInbox
      key={wanted ?? 'inbox'}
      initial={initial}
      timeZone={auth.profile.timezone}
      opened={opened}
    />
  );
}
