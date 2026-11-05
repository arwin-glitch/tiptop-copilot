import { SkeletonText } from '@/components/ui/feedback';
import { PageShell } from '@/components/shell/page-header';

/** Shown while a Space member's email is read (read-only viewer). */
export default function SpaceEmailLoading() {
  return (
    <PageShell>
      <SkeletonText lines={10} />
    </PageShell>
  );
}
