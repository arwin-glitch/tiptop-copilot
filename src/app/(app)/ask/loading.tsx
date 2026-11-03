import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Skeleton, SkeletonText } from '@/components/ui/feedback';

/** Ask Arwin the moment it is opened: the title, then the conversation's shape. */
export default function AskLoading() {
  return (
    <PageShell aria-busy="true" className="max-w-4xl">
      <PageHeader title="Ask Arwin" />
      <Skeleton className="mb-5 h-11 w-full" />
      <div className="grid gap-6 lg:grid-cols-[1fr_220px]" aria-hidden="true">
        <Skeleton className="h-64 w-full" />
        <SkeletonText lines={6} />
      </div>
      <span className="sr-only" role="status">
        Loading Ask Arwin
      </span>
    </PageShell>
  );
}
