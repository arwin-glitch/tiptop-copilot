import { PageShell } from '@/components/shell/page-header';
import { HeaderSkeleton, LoadingBodyShape } from '@/components/shell/tab-loading';
import { TodayBriefingsSkeleton } from '@/components/today/today-skeletons';

/**
 * Today the moment it is clicked: the header band (its greeting needs the
 * signed-in name, so bars stand in), the Brief and Dossier places at the top,
 * then the list below.
 */
export default function TodayLoading() {
  return (
    <PageShell aria-busy="true">
      <HeaderSkeleton />
      <TodayBriefingsSkeleton />
      <LoadingBodyShape body="list" />
      <span className="sr-only" role="status">
        Loading Today
      </span>
    </PageShell>
  );
}
