import { ExternalLink, Flame } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { gmailThreadUrl } from '@/lib/deals/links';
import { getStore } from '@/lib/runtime';
import { buildReaders, readDocSendViews, type DocSendReader } from '@/lib/services/docsend';
import { readFollowUps, type LpStage } from '@/lib/services/follow-ups';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import { SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { relativeTime } from '@/lib/util/time';

const STAGE_LABEL: Record<LpStage, string> = {
  target: 'Target',
  contacted: 'Contacted',
  meeting: 'Meeting',
  materials: 'Materials sent',
  soft_commit: 'Soft commit',
  committed: 'Committed',
  passed: 'Passed',
};

const SHOWN = 10;

/**
 * Fund II: who is reading the DocSend links right now. Hot readers (a view in
 * the last three days, or a repeat view or download in the last two weeks)
 * sit on top; they are the people to follow up with.
 */
export async function DocSendReaders() {
  const auth = await requireAuth();
  const now = new Date();
  const store = getStore();
  const followUps = await readFollowUps(store, auth.organizationId, { now }).catch(() => null);
  if (followUps?.state !== 'ok') return null;
  const result = await readDocSendViews(store, auth.organizationId, { now });
  if (result.state !== 'ok') return null;

  const readers = buildReaders(result.views, {
    ownDomain: result.ownDomain,
    lps: followUps.snapshot.lpPipeline?.lps ?? [],
    now,
  });
  const prospects = readers.filter((r) => r.kind === 'prospect');
  const lps = readers.filter((r) => r.kind === 'lp');
  const hot = prospects.filter((r) => r.hot);
  const shown = prospects.slice(0, Math.max(SHOWN, hot.length));
  const rest = prospects.slice(shown.length);

  return (
    <section aria-labelledby="docsend-heading" className="mb-8">
      <SectionHeading count={hot.length}>
        <span id="docsend-heading">Reading your DocSend</span>
      </SectionHeading>
      <p className="-mt-2 mb-3 text-sm text-[var(--fg-muted)]">
        People outside TipTop who opened the prospective-partner update or a deck, from
        DocSend&apos;s emails in your inbox. Hot means a view in the last 3 days, or a repeat view
        or download in the last 2 weeks: follow up while it&apos;s fresh. Checked{' '}
        {relativeTime(result.checkedAt, now)}.
      </p>
      {prospects.length === 0 ? (
        <p className="text-sm text-[var(--fg-subtle)]">
          Nobody has opened fundraising material in the last 6 months.
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <ReaderRow key={r.email} reader={r} now={now} />
          ))}
        </ul>
      )}
      {rest.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[var(--accent)]">
            {rest.length} earlier {rest.length === 1 ? 'reader' : 'readers'}
          </summary>
          <ul className="mt-2 space-y-2">
            {rest.map((r) => (
              <ReaderRow key={r.email} reader={r} now={now} />
            ))}
          </ul>
        </details>
      ) : null}
      {lps.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[var(--fg-muted)]">
            {lps.length} {lps.length === 1 ? 'person' : 'people'} read the LP update
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-[var(--fg-muted)]">
            {lps.map((r) => (
              <li key={r.email}>
                {r.name ?? r.email}
                {r.name ? (
                  <span className="text-[var(--fg-subtle)]"> · {r.email}</span>
                ) : null} · {relativeTime(r.lastAt, now)}
                {r.downloaded ? ' · downloaded' : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ReaderRow({ reader: r, now }: { reader: DocSendReader; now: Date }) {
  const href = gmailThreadUrl(r.threadId, DEFAULT_MAILBOX);
  return (
    <li>
      <Card>
        <CardContent className="flex items-start gap-3 pt-3.5 pb-3.5">
          <Flame
            className={`mt-0.5 size-4 shrink-0 ${r.hot ? 'text-[var(--warn)]' : 'text-[var(--fg-subtle)]'}`}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">
                {r.hot ? <span className="sr-only">Hot: </span> : null}
                {r.name ?? r.email}
              </span>
              {r.domain && r.name ? <span className="text-sm text-[var(--fg-muted)]">{r.domain}</span> : null}
              {r.match ? (
                <Badge tone="info">{STAGE_LABEL[r.match.stage]}</Badge>
              ) : (
                <Badge tone="neutral">Not in pipeline</Badge>
              )}
              {r.downloaded ? <Badge tone="ok">Downloaded</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-sm">{r.documents[0]}</p>
            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
              {r.name ? `${r.email} · ` : ''}
              {r.views} {r.views === 1 ? 'view' : 'views'} · last {relativeTime(r.lastAt, now)}
              {r.views > 1 ? ` · first ${relativeTime(r.firstAt, now)}` : ''}
            </p>
          </div>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
            >
              Open in Gmail <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}
