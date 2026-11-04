import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton, SkeletonText } from '@/components/ui/feedback';
import type { PageHeaderText } from '@/lib/shell/page-headers';
import { cn } from '@/lib/util/cn';

/**
 * What a tab shows the instant it is clicked, while the server gathers its
 * data: the real header band (same words, so nothing moves when the page
 * arrives), the subtab bar's shape, and placeholder shapes that follow the
 * page's own layout. Rendered by each tab's `loading.tsx`, which Next.js
 * prefetches with the navigation links, so it needs no server round trip.
 *
 * Tokens only: the shapes are the shared `skeleton` class and the card
 * border; the gold stays on the header band's hairline.
 */
export function TabLoading({
  header,
  tabs,
  body = 'list',
  className,
}: {
  header: PageHeaderText;
  /** The page shell's own width, when the page is wider than most (the Inbox). */
  className?: string;
  /** The subtab labels, when the page has a subtab bar. */
  tabs?: readonly string[];
  body?: LoadingBody;
}) {
  return (
    <PageShell aria-busy="true" className={className}>
      <PageHeader title={header.title} subtitle={header.subtitle} eyebrow={header.eyebrow} />
      {tabs && tabs.length > 0 ? <TabBarSkeleton labels={tabs} /> : null}
      <LoadingBodyShape body={body} />
      <span className="sr-only" role="status">
        Loading {header.title}
      </span>
    </PageShell>
  );
}

export type LoadingBody = 'list' | 'cards' | 'calendar' | 'inbox' | 'form' | 'detail';

/**
 * The subtab bar as plain text in the bar's own frame and height: no tab is
 * marked current, since the skeleton cannot know which one the URL opens.
 */
function TabBarSkeleton({ labels }: { labels: readonly string[] }) {
  return (
    <div
      aria-hidden="true"
      className="-mx-[var(--gutter)] mb-5 border-b border-[var(--border)] px-[var(--gutter)]"
    >
      <div className="-mb-px flex overflow-hidden sm:gap-1">
        {labels.map((label) => (
          <span
            key={label}
            className="inline-flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-2 text-sm font-medium whitespace-nowrap text-[var(--fg-subtle)] sm:px-3 lg:min-h-10"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function LoadingBodyShape({ body, className }: { body: LoadingBody; className?: string }) {
  switch (body) {
    case 'cards':
      return (
        <div
          className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', className)}
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="mb-3 h-5 w-1/2" />
                <SkeletonText lines={3} />
              </CardContent>
            </Card>
          ))}
        </div>
      );
    case 'calendar':
      return (
        <div className={cn('space-y-4', className)} aria-hidden="true">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-9 w-56" />
            <Skeleton className="h-9 w-40" />
          </div>
          <Card>
            <CardContent className="grid grid-cols-7 gap-2 pt-5">
              {Array.from({ length: 28 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </CardContent>
          </Card>
        </div>
      );
    case 'inbox':
      return (
        // The Inbox's Gmail layout: the search bar, then the folder nav beside
        // the list (toolbar, rows), as Gmail opens with no reading pane split.
        <div className={cn('space-y-3', className)} aria-hidden="true">
          <Skeleton className="h-12 w-full rounded-full" />
          <div className="grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <div className="hidden space-y-2 lg:block">
              <Skeleton className="mb-3 h-14 w-36 rounded-2xl" />
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-6 w-5/6" />
              ))}
            </div>
            <div className="min-w-0">
              <Card>
                <CardContent className="space-y-4 pt-4">
                  <Skeleton className="h-8 w-full" />
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="space-y-1.5">
                      <Skeleton className="h-3.5 w-1/3" />
                      <Skeleton className="h-3.5 w-5/6" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      );
    case 'form':
      return (
        <div className={cn('space-y-6', className)} aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-3 pt-5">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-9 w-full max-w-md" />
                <Skeleton className="h-9 w-full max-w-md" />
              </CardContent>
            </Card>
          ))}
        </div>
      );
    case 'detail':
      return (
        <div
          className={cn('grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]', className)}
          aria-hidden="true"
        >
          <Card>
            <CardContent className="pt-5">
              <SkeletonText lines={8} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <SkeletonText lines={5} />
            </CardContent>
          </Card>
        </div>
      );
    case 'list':
    default:
      return (
        <Card className={className} aria-hidden="true">
          <CardContent className="divide-y divide-[var(--border)] pt-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3 py-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      );
  }
}

/**
 * The header band with placeholder bars, for a page whose header words are
 * only known on the server (Today greets the signed-in person by name).
 */
export function HeaderSkeleton() {
  return (
    <header className="dark relative mb-10 text-[var(--fg)]" aria-hidden="true">
      <span className="pointer-events-none absolute inset-x-0 -top-[100vh] -bottom-5 -z-20 bg-[var(--bg-band)] shadow-[0_0_0_100vmax_var(--bg-band)] [clip-path:inset(0_-100vmax)]" />
      <span className="pointer-events-none absolute inset-x-0 -bottom-5 h-px bg-[var(--gold-rule)] shadow-[0_0_0_100vmax_var(--gold-rule)] [clip-path:inset(0_-100vmax)]" />
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="h-8 w-64 max-w-full sm:h-10" />
      <Skeleton className="mt-2.5 h-4 w-96 max-w-full" />
    </header>
  );
}

/**
 * A page inside a tab (a deal, a company, a meeting, a list), the moment its
 * link is clicked: without its own skeleton it would borrow the tab's, whose
 * header and subtab bar are not this page's.
 */
export function DetailLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <PageShell aria-busy="true">
      <Skeleton className="mb-4 h-4 w-28" />
      <HeaderSkeleton />
      <LoadingBodyShape body="detail" />
      <span className="sr-only" role="status">
        {label}
      </span>
    </PageShell>
  );
}
