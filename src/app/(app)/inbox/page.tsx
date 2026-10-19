import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listLiveThreads } from '@/lib/services/inbox-live';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { SkeletonText } from '@/components/ui/feedback';
import { LiveInbox } from '@/components/inbox/live-inbox';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default function InboxPage() {
  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        subtitle="Nick's Gmail, live: read, reply, archive and star right here. Replies send from his inbox only when someone taps Send, with 8 seconds to undo."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <InboxContent />
      </Suspense>
    </PageShell>
  );
}

async function InboxContent() {
  const auth = await requireAuth();
  const initial = await listLiveThreads(getStore(), auth.organizationId, { tab: 'primary' });
  return <LiveInbox initial={initial} timeZone={auth.profile.timezone} />;
}
