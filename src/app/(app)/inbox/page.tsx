import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration, listInbox } from '@/lib/services/inbox';
import { listDeals } from '@/lib/services/deals';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { SkeletonText } from '@/components/ui/feedback';
import { InboxClient, type InboxMessageView } from '@/components/inbox/inbox-client';
import type { EmailAttachment, EmailCategory } from '@/lib/types/domain';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';
  const category = single(params.category) ?? '';
  const unread = single(params.unread) === '1';
  const days = single(params.days) ?? '';
  const selectedId = single(params.message) ?? null;

  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        subtitle="Metadata is synced by default. Full message text is fetched when you open a message or when the classifier flags it as consequential."
      />
      <Suspense fallback={<SkeletonText lines={8} />}>
        <InboxContent
          q={q}
          category={category}
          unread={unread}
          days={days}
          selectedId={selectedId}
        />
      </Suspense>
    </PageShell>
  );
}

async function InboxContent({
  q,
  category,
  unread,
  days,
  selectedId,
}: {
  q: string;
  category: string;
  unread: boolean;
  days: string;
  selectedId: string | null;
}) {
  const auth = await requireAuth();
  const store = getStore();

  const [messages, deals, integration] = await Promise.all([
    listInbox(auth.organizationId, {
      search: q || undefined,
      category: (category || undefined) as EmailCategory | undefined,
      unreadOnly: unread,
      sinceDays: days ? Number(days) : undefined,
      includeIgnored: false,
      limit: 100,
    }),
    listDeals(auth.organizationId),
    getPrimaryIntegration(store, auth.organizationId),
  ]);

  const withAttachments: InboxMessageView[] = [];
  for (const message of messages) {
    const attachments = message.has_attachments
      ? ((await store.list('email_attachments', auth.organizationId, {
          eq: { message_id: message.id },
        })) as EmailAttachment[])
      : [];
    withAttachments.push({ ...message, attachments });
  }

  return (
    <InboxClient
      messages={withAttachments}
      deals={deals.map((d) => ({ id: d.id, company_name: d.company_name }))}
      selectedId={selectedId}
      mailboxConnected={Boolean(integration && integration.status === 'connected')}
      filters={{ q, category, unread, days }}
    />
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
