import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Layers, Lock, Users } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { PAGE_HEADERS } from '@/lib/shell/page-headers';
import { seedFrom, spaceCards, suggestSpaces } from '@/lib/services/space-content';
import { spacesReady } from '@/lib/services/spaces';
import { single } from '@/lib/util/page-tabs';
import { relativeTime } from '@/lib/util/time';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { SpaceFormDialog, type SpaceFormValues } from '@/components/spaces/space-form';
import { MakeSuggestedSpace } from '@/components/spaces/space-controls';

export const metadata: Metadata = { title: 'Spaces' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = Record<string, string | string[] | undefined>;

/**
 * Spaces: one card per Space the viewer is in (or invited to), the Spaces
 * Kraken suggests making, and New Space. `?new=1` opens the form; with
 * `from=record:<id>` or `from=deal:<id>` ("Make a Space" on a profile or a
 * deal) it starts filled in. Before the migration the page says it needs a
 * database update and shows nothing else.
 */
export default async function SpacesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const auth = await requireAuth();
  const store = getStore();
  const ready = await spacesReady(store, auth.organizationId);
  if (!ready) {
    return (
      <PageShell>
        <PageHeader title={PAGE_HEADERS.spaces.title} subtitle={PAGE_HEADERS.spaces.subtitle} />
        <Notice tone="warn">
          Spaces need a database update before they can be used. Nothing else changes.
        </Notice>
      </PageShell>
    );
  }

  const from = single(params.from) ?? '';
  const [kind, ref] = from.split(':');
  const seed =
    (kind === 'record' || kind === 'deal') && ref && UUID.test(ref)
      ? await seedFrom(store, auth.organizationId, { kind, id: ref })
      : null;
  const initial: Partial<SpaceFormValues> | undefined = seed
    ? { name: seed.name, domains: seed.domains.join(', '), emails: seed.emails.join(', ') }
    : undefined;

  return (
    <PageShell>
      <PageHeader
        title={PAGE_HEADERS.spaces.title}
        subtitle={PAGE_HEADERS.spaces.subtitle}
        actions={
          <span data-tour="spaces-new">
            <SpaceFormDialog
              mode="create"
              initial={initial}
              defaultOpen={single(params.new) === '1' || Boolean(seed)}
              source={
                seed && seed.sourceKind !== 'manual' && seed.sourceKind !== 'suggested'
                  ? { kind: seed.sourceKind, ref: seed.sourceRef }
                  : undefined
              }
            />
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[3fr_1fr]">
        <Suspense fallback={<SkeletonText lines={6} />}>
          <SpaceList />
        </Suspense>
        <Suspense fallback={<SkeletonText lines={4} />}>
          <Suggestions />
        </Suspense>
      </div>
    </PageShell>
  );
}

async function SpaceList() {
  const auth = await requireAuth();
  const cards = await spaceCards(getStore(), auth);
  if (!cards.ok) {
    return <Notice tone="warn">{cards.error.message}</Notice>;
  }
  if (!cards.value.length) {
    return (
      <EmptyState
        icon={<Layers className="size-6" aria-hidden="true" />}
        title="No Spaces yet"
        description="Make one for a client or project, or start from a suggestion. Only you can see it until you invite people."
      />
    );
  }
  return (
    <section aria-label="Your Spaces" data-tour="spaces-list">
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.value.map((card) => (
          <li key={card.id}>
            <Link
              href={`/spaces/${card.id}`}
              className="block h-full rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3 transition-colors hover:border-[var(--border-control)] hover:bg-[var(--bg-hover)]"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-serif text-base font-semibold">{card.name}</p>
                {card.invited ? (
                  <span className="rounded-full border border-[var(--gold)] px-2 py-0.5 text-xs text-[var(--fg)]">
                    Invite waiting
                  </span>
                ) : card.others === 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)]">
                    <Lock className="size-3" aria-hidden="true" />
                    Only you
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)]">
                    <Users className="size-3" aria-hidden="true" />
                    {card.others + 1} people
                  </span>
                )}
              </div>
              {card.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-[var(--fg-muted)]">
                  {card.description}
                </p>
              ) : null}
              {card.counts ? (
                <>
                  <p className="tabular mt-2 text-sm">
                    {card.counts.emails} emails · {card.counts.meetings} meetings ·{' '}
                    {card.counts.openItems} open items
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                    {card.counts.lastActivityAt
                      ? `Last activity ${relativeTime(card.counts.lastActivityAt)}`
                      : 'No activity yet'}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-[var(--fg-muted)]">
                  Open to accept or decline the invite.
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function Suggestions() {
  const auth = await requireAuth();
  const suggestions = await suggestSpaces(getStore(), auth).catch(() => []);
  return (
    <section aria-labelledby="suggested-spaces" data-tour="spaces-suggested">
      <h2 id="suggested-spaces" className="font-serif text-base font-semibold">
        Suggested Spaces
      </h2>
      <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
        Companies with a lot of mail and meetings and no Space yet.
      </p>
      {suggestions.length ? (
        <ul className="mt-2 space-y-2">
          {suggestions.map((s) => (
            <li
              key={s.domain}
              className="rounded-[var(--radius-card)] border border-[var(--border)] px-3 py-2.5"
            >
              <p className="text-sm font-medium">{s.name}</p>
              <p className="text-xs text-[var(--fg-muted)]">
                {s.domain} · {s.emails} emails · {s.meetings} meetings
              </p>
              <div className="mt-2">
                <MakeSuggestedSpace domain={s.domain} name={s.name} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          No suggestions right now. They come from companies you email and meet often.
        </p>
      )}
    </section>
  );
}
