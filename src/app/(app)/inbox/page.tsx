import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { inboxThreadParam, wantsGmail } from '@/lib/email/thread-links';
import { getStore } from '@/lib/runtime';
import { gmailHrefForLink, listLiveThreads, openFromLink } from '@/lib/services/inbox-live';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { SkeletonText } from '@/components/ui/feedback';
import { LiveInbox } from '@/components/inbox/live-inbox';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  // A synced email's "Gmail" link comes by way of here (`&open=gmail`): only
  // the server can look up its Gmail id. When the id stands for no email,
  // the Inbox opens and says so instead.
  const params = await searchParams;
  const wanted = inboxThreadParam(params);
  if (wanted && wantsGmail(params)) {
    const auth = await requireAuth();
    const href = await gmailHrefForLink(getStore(), auth.organizationId, wanted);
    if (href) redirect(href);
  }
  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        subtitle="Nick's Gmail, live: read, reply, archive and star right here. Replies send from his inbox only when someone taps Send, with 8 seconds to undo."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <InboxContent wanted={wanted} query={searchQuery(params.q)} />
      </Suspense>
    </PageShell>
  );
}

/** `?q=` opens the Inbox on that search (the Calendar card's "Search the Inbox for …"). */
function searchQuery(value: string | string[] | undefined): string {
  const q = typeof value === 'string' ? value.trim() : '';
  return q.slice(0, 200);
}

/**
 * `?thread=<id>` (a thread or a message id, or Copilot's id for a synced
 * email, from a "Copilot" email link anywhere in the app; `?message=` in
 * older links) opens that conversation in the reading pane, wherever it is
 * filed, alongside the Primary list. Opening it changes nothing in Gmail; a
 * bad or unknown id says it couldn't open the email.
 */
async function InboxContent({ wanted, query }: { wanted: string | null; query: string }) {
  const auth = await requireAuth();
  const store = getStore();
  const [initial, opened] = await Promise.all([
    listLiveThreads(store, auth.organizationId, { tab: 'primary', q: query || undefined }),
    wanted ? openFromLink(store, auth.organizationId, wanted) : null,
  ]);
  return (
    <LiveInbox
      key={`${wanted ?? 'inbox'}|${query}`}
      initial={initial}
      timeZone={auth.profile.timezone}
      opened={opened}
      initialQuery={query}
    />
  );
}
