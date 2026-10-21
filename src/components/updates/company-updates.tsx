import { digestedAt, digestIndex, type CompanyUpdate } from '@/lib/company-updates/classify';
import { getStore } from '@/lib/runtime';
import { readCompanyUpdates } from '@/lib/services/company-updates';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type { UpdatesSnapshot } from '@/lib/updates/types';
import { formatMonthDay, relativeTime } from '@/lib/util/time';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ThreadLinks } from '@/components/email/thread-links';

const SHOWN = 8;

const REASON_LABEL: Record<CompanyUpdate['reason'], string> = {
  portfolio: 'Portfolio company',
  emailed: "You've emailed them",
};

/**
 * Founder and investor updates from the last 30 days, read live from Gmail.
 * The Slack digest runs twice a week; this shows what landed in between. Each
 * row says why it is here, and whether the digest already carried it when
 * the digest's own Gmail link says so.
 */
export async function FreshCompanyUpdates({
  organizationId,
  snapshot,
  now,
  timeZone,
}: {
  organizationId: string;
  snapshot: UpdatesSnapshot | null;
  now: Date;
  timeZone: string;
}) {
  const result = await readCompanyUpdates(getStore(), organizationId, { now }).catch(() => null);

  const heading = (count?: number) => (
    <SectionHeading count={count}>
      <span id="fresh-updates-heading">Fresh company updates</span>
    </SectionHeading>
  );

  if (!result || result.state !== 'ok') {
    return (
      <section aria-labelledby="fresh-updates-heading">
        {heading()}
        <p className="text-sm text-[var(--fg-muted)]">
          {result?.state === 'not_connected'
            ? 'Connect Gmail in Settings to see founder updates that land between digests.'
            : "Gmail didn't answer, so fresh company updates are hidden for now. Try again in a minute."}
        </p>
      </section>
    );
  }

  const index = digestIndex(snapshot);
  const updates = result.updates;
  const shown = updates.slice(0, SHOWN);
  const rest = updates.slice(SHOWN);

  return (
    <section aria-labelledby="fresh-updates-heading">
      {heading(updates.length)}
      <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
        Founder and investor updates from the last 30 days, live from Gmail. Only portfolio
        companies and people you&apos;ve emailed are shown. Checked{' '}
        {relativeTime(result.checkedAt, now)}.
        {result.partial
          ? ' Still reading some of your mail - refresh in a minute for the rest.'
          : ''}
      </p>
      {updates.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">No company updates in the last 30 days.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((u) => (
            <UpdateRow
              key={u.messageId}
              update={u}
              digested={digestedAt(u, index)}
              now={now}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}
      {rest.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[var(--accent)]">
            {rest.length} more {rest.length === 1 ? 'update' : 'updates'}
          </summary>
          <ul className="mt-2 space-y-2">
            {rest.map((u) => (
              <UpdateRow
                key={u.messageId}
                update={u}
                digested={digestedAt(u, index)}
                now={now}
                timeZone={timeZone}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function UpdateRow({
  update: u,
  digested,
  now,
  timeZone,
}: {
  update: CompanyUpdate;
  digested: string | null;
  now: Date;
  timeZone: string;
}) {
  const title = u.company ?? u.sender;
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-3.5 pb-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium break-words">{title}</span>
              <Badge tone={u.reason === 'portfolio' ? 'jewel' : 'accent'}>
                {REASON_LABEL[u.reason]}
              </Badge>
              <Badge tone="neutral">{u.kindLabel}</Badge>
              {digested ? (
                <Badge tone="outline">
                  In the Slack digest · {formatMonthDay(digested, timeZone)}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm break-words">{u.subject}</p>
            {u.snippet ? (
              <p className="mt-0.5 truncate text-sm text-[var(--fg-muted)]">{u.snippet}</p>
            ) : null}
            <p className="mt-0.5 text-xs break-words text-[var(--fg-subtle)]">
              {u.company && u.company !== u.sender ? `From ${u.sender} · ` : ''}
              {relativeTime(u.receivedAt, now)}
              {u.bcc ? ' · you were bcc’d' : ''}
            </p>
          </div>
          {/* The update email, in Copilot's Inbox or in Gmail. */}
          <ThreadLinks
            id={u.threadId}
            mailbox={DEFAULT_MAILBOX}
            label={`${u.subject} (${title})`}
            variant="text"
            className="max-sm:flex-col max-sm:items-end max-sm:gap-1"
          />
        </CardContent>
      </Card>
    </li>
  );
}
