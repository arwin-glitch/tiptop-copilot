import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getUpdatesFeed } from '@/lib/runtime';
import { readUpdates } from '@/lib/services/updates';
import { channelLabel } from '@/lib/updates/sources';
import type { UpdatePost, UpdateSourceView } from '@/lib/updates/types';
import { relativeTime } from '@/lib/util/time';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { EmptyState, ErrorState, Notice, SkeletonText } from '@/components/ui/feedback';
import { RefreshUpdatesButton } from '@/components/updates/refresh-updates-button';
import { SetupBanner, SourceStatusStrip } from '@/components/updates/source-status';
import { UpdatePostCard } from '@/components/updates/update-card';
import { UpdatesBrowser } from '@/components/updates/updates-browser';
import { panelKey, updatesHref, viewForGroup, type UpdatesFilter } from '@/lib/updates/view';

export const metadata: Metadata = { title: 'Dealflow reports' };
export const dynamic = 'force-dynamic';

export default async function UpdatesPage() {
  return (
    <PageShell>
      <PageHeader
        title="Dealflow reports"
        subtitle="Weekly dealflow reports and Nick's update digests, read live from Slack. Read-only."
        actions={<RefreshUpdatesButton />}
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <UpdatesContent />
      </Suspense>
    </PageShell>
  );
}

/** A dealflow report or digest run — what "latest" and the counts are about. */
function isRoutine(post: UpdatePost): boolean {
  return post.type === 'dealflow' || post.type === 'digest';
}

async function UpdatesContent() {
  const auth = await requireAuth();
  const now = new Date();
  const feed = getUpdatesFeed(now);
  if (!feed) {
    return (
      <Notice tone="warn">
        <p className="font-medium">
          This tab stays closed until sign-in is limited to TipTop accounts.
        </p>
        <p className="mt-1">
          The channels behind it hold confidential deal reports and investors-only updates, and
          right now any Google account can sign in. Set <code>AUTH_ALLOWED_EMAIL_DOMAINS</code> (for
          example <code>tiptop.vc</code>) on Render and redeploy.
        </p>
      </Notice>
    );
  }
  const snapshot = await readUpdates(feed, { now }).catch(() => null);
  if (!snapshot) {
    return (
      <ErrorState
        title="Updates could not be loaded"
        message="Reading the Slack channels failed unexpectedly. Try Refresh in a minute."
        stillUsable="Every other page."
      />
    );
  }

  const timeZone = auth.profile.timezone;
  const botHandle = snapshot.workspace.botHandle;
  const readable = snapshot.sources.some((v) => v.access.state === 'ok' || v.stale);

  // Every filter's panel is rendered from this one read, so switching chips
  // is instant and never goes back to Slack.
  const panel = ({ view, source }: UpdatesFilter) => {
    const shown = source
      ? snapshot.sources.filter((v) => v.source.key === source)
      : snapshot.sources.filter((v) => view === 'all' || viewForGroup(v.source.group) === view);
    return (
      <>
        <SourceStatusStrip views={shown} now={now} botHandle={botHandle} setup={snapshot.setup} />
        {!readable ? (
          <EmptyState
            title="Nothing to show until Slack access is fixed"
            description="Follow the steps above, then press Refresh."
          />
        ) : view === 'all' ? (
          <LatestFeed views={shown} now={now} timeZone={timeZone} />
        ) : view === 'dealflow' ? (
          <div className="space-y-8">
            {shown.map((v) => (
              <DealflowSection key={v.source.key} view={v} now={now} timeZone={timeZone} />
            ))}
          </div>
        ) : (
          <div className="space-y-8">
            {shown.map((v) => (
              <DigestSection key={v.source.key} view={v} now={now} timeZone={timeZone} />
            ))}
          </div>
        )}
      </>
    );
  };
  const filters: UpdatesFilter[] = [
    { view: 'all', source: null },
    { view: 'dealflow', source: null },
    { view: 'digests', source: null },
    ...snapshot.sources.map((v) => ({ view: viewForGroup(v.source.group), source: v.source.key })),
  ];

  return (
    <div className="space-y-5">
      <p className="text-mini text-[var(--fg-subtle)]">
        Checked {relativeTime(snapshot.checkedAt, now)} · read live from Slack · nothing is stored
      </p>

      {snapshot.setup ? (
        <SetupBanner setup={snapshot.setup} botHandle={botHandle} views={snapshot.sources} />
      ) : null}

      <UpdatesBrowser
        sources={snapshot.sources.map((v) => ({
          key: v.source.key,
          label: v.source.label,
          group: v.source.group,
          count: v.posts.filter(isRoutine).length,
        }))}
        panels={Object.fromEntries(filters.map((f) => [panelKey(f), panel(f)]))}
      />
    </div>
  );
}

interface SectionProps {
  view: UpdateSourceView;
  now: Date;
  timeZone: string;
}

function StaleNotice({ view, now }: { view: UpdateSourceView; now: Date }) {
  if (!view.stale) return null;
  const reason =
    view.access.state === 'rate_limited'
      ? 'Slack asked us to slow down'
      : view.access.state === 'unreachable'
        ? "Slack didn't answer"
        : 'Slack refused the latest read';
  return (
    <Notice tone="info">
      Showing the copy from {relativeTime(view.stale.since, now)} — {reason}.
    </Notice>
  );
}

function NoPosts({ view }: { view: UpdateSourceView }) {
  return (
    <EmptyState
      title={`No reports in ${channelLabel(view.source)} yet`}
      description={`The routine posts ${view.source.cadence}.`}
    />
  );
}

/** The newest report or run per source, newest first. */
function LatestFeed({
  views,
  now,
  timeZone,
}: {
  views: UpdateSourceView[];
  now: Date;
  timeZone: string;
}) {
  const latest = views
    .map((v) => {
      const routine = v.posts.filter(isRoutine);
      return routine[0] ? { view: v, post: routine[0], earlier: routine.length - 1 } : null;
    })
    .filter((x): x is { view: UpdateSourceView; post: UpdatePost; earlier: number } => x !== null)
    .sort((a, b) => Number(b.post.ts) - Number(a.post.ts));

  return (
    <section>
      <SectionHeading>Latest</SectionHeading>
      {latest.length === 0 ? (
        <EmptyState
          title="No reports yet"
          description="The dealflow routines post on Fridays; the digest runs on Mondays and Fridays."
        />
      ) : (
        <div className="space-y-4">
          {latest.map(({ view, post, earlier }) => (
            <div key={view.source.key} className="space-y-2">
              <StaleNotice view={view} now={now} />
              <UpdatePostCard
                post={post}
                source={view.source}
                now={now}
                timeZone={timeZone}
                footer={
                  earlier > 0 ? (
                    <Link
                      href={updatesHref({
                        view: viewForGroup(view.source.group),
                        source: view.source.key,
                      })}
                      className="text-sm text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      {earlier} earlier from {view.source.label} →
                    </Link>
                  ) : undefined
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DealflowSection({ view, now, timeZone }: SectionProps) {
  const reports = view.posts.filter((p) => p.type === 'dealflow');
  const others = view.posts.filter((p) => p.type === 'other');
  const [latest, ...earlier] = reports;
  const readable = view.access.state === 'ok' || view.stale;

  return (
    <section>
      <SectionHeading count={reports.length}>{view.source.label}</SectionHeading>
      {!readable ? (
        <p className="text-sm text-[var(--fg-muted)]">
          Not readable yet — the steps above say what to fix.
        </p>
      ) : (
        <div className="space-y-3">
          <StaleNotice view={view} now={now} />
          {latest ? (
            <UpdatePostCard post={latest} source={view.source} now={now} timeZone={timeZone} />
          ) : (
            <NoPosts view={view} />
          )}
          {[...earlier.slice(0, 3), ...others].map((post) => (
            <UpdatePostCard
              key={post.ts}
              post={post}
              source={view.source}
              now={now}
              timeZone={timeZone}
              compact
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DigestSection({ view, now, timeZone }: SectionProps) {
  const roster = view.posts.find((p) => p.type === 'roster');
  const runs = view.posts.filter((p) => p.type === 'digest');
  const others = view.posts.filter((p) => p.type === 'other');
  const [latest, ...earlier] = runs;
  const readable = view.access.state === 'ok' || view.stale;

  if (!readable) {
    return (
      <section>
        <SectionHeading>{view.source.label}</SectionHeading>
        <p className="text-sm text-[var(--fg-muted)]">
          Not readable yet — the steps above say what to fix.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <StaleNotice view={view} now={now} />
      {roster ? (
        <UpdatePostCard post={roster} source={view.source} now={now} timeZone={timeZone} compact />
      ) : null}
      <SectionHeading count={runs.length} className="pt-2">
        Digest runs
      </SectionHeading>
      {latest ? (
        <UpdatePostCard post={latest} source={view.source} now={now} timeZone={timeZone} />
      ) : (
        <NoPosts view={view} />
      )}
      {[...earlier.slice(0, 5), ...others].map((post) => (
        <UpdatePostCard
          key={post.ts}
          post={post}
          source={view.source}
          now={now}
          timeZone={timeZone}
          compact
        />
      ))}
    </section>
  );
}
