import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { gmailThreadUrl } from '@/lib/deals/links';
import { getStore } from '@/lib/runtime';
import { spaceMemberEmail } from '@/lib/services/space-content';
import { getSpaceAccess, teamPeople } from '@/lib/services/spaces';
import { single } from '@/lib/util/page-tabs';
import { formatDateTime } from '@/lib/util/time';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Notice, PlainText } from '@/components/ui/feedback';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Space email' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * A Space member's own email, read-only, inside the Space (D-081). Opened
 * from a contributor's row on the Space's Emails tab or Overview: Kraken's
 * Inbox reads the main mailbox alone, so a contributor's thread is read here,
 * for this Space's members only, and only while it matches the Space's rules
 * and nobody hid it. No reply, label or archive: nothing changes in their
 * Gmail, not even read or unread. "Open in Gmail" opens it in their own
 * account.
 */
export default async function SpaceEmailPage({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const auth = await requireAuth();
  const store = getStore();
  const access = await getSpaceAccess(store, auth, id);
  if (!access.ok || !access.value.canView) notFound();
  const item = single(query.item) ?? '';
  const email = await spaceMemberEmail(store, access.value, item);
  const back = `/spaces/${access.value.space.id}?tab=emails`;
  const team = await teamPeople(store, auth.organizationId);

  return (
    <PageShell>
      <Link
        href={back}
        className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {access.value.space.name}
      </Link>
      {!email.ok ? (
        <>
          <PageHeader title="Email" />
          <Notice tone="warn">{email.error.message}</Notice>
        </>
      ) : (
        <>
          <PageHeader
            title={email.value.subject || '(no subject)'}
            meta={
              <span className="text-xs text-[var(--fg-muted)]">
                From{' '}
                {email.value.owner === auth.userId
                  ? 'your'
                  : `${(team.find((p) => p.userId === email.value.owner)?.name ?? 'a member').split(/\s+/)[0]}'s`}{' '}
                mail · read-only, shown to this Space&apos;s members only
              </span>
            }
            actions={
              gmailThreadUrl(email.value.threadId, email.value.mailbox) ? (
                <a
                  href={gmailThreadUrl(email.value.threadId, email.value.mailbox)!}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open in Gmail: ${email.value.subject}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2.5 text-xs font-medium hover:bg-[var(--bg-hover)]"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  Gmail
                </a>
              ) : null
            }
          />
          <ol className="space-y-3" data-testid="space-email-messages">
            {email.value.messages.map((m, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-card)] border border-[var(--border)] px-4 py-3"
              >
                <p className="text-sm font-medium">{m.from}</p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {m.to ? `To ${m.to}` : null}
                  {m.cc ? ` · Cc ${m.cc}` : null}
                  {m.at ? ` · ${formatDateTime(m.at, auth.profile.timezone)}` : null}
                </p>
                <PlainText text={m.text} className="mt-2 text-sm" />
              </li>
            ))}
          </ol>
        </>
      )}
    </PageShell>
  );
}
