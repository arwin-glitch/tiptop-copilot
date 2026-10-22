import { PageShell } from '@/components/shell/page-header';
import { Skeleton, SkeletonText } from '@/components/ui/feedback';

/** The library while it loads: the header band and a few card shapes. */
export default function EventsLoading() {
  return (
    <PageShell>
      <div className="mb-10 space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-[var(--radius-card)] border border-[var(--border)] p-3">
            <Skeleton className="aspect-[1200/630] w-full" />
            <SkeletonText lines={3} className="mt-3" />
          </div>
        ))}
      </div>
    </PageShell>
  );
}
