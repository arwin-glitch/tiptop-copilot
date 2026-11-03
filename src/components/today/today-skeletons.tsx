import { Card, CardContent } from '@/components/ui/card';
import { Skeleton, SkeletonText } from '@/components/ui/feedback';

/**
 * The Brief and Dossier places while they load: two cards side by side in the
 * same grid the real ones use, so they hold the top of Today from the first
 * paint and nothing below moves when they fill in.
 */
export function TodayBriefingsSkeleton() {
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2" aria-hidden="true">
      {[0, 1].map((i) => (
        <Card key={i}>
          <CardContent className="pt-5">
            <Skeleton className="mb-3 h-5 w-32" />
            <SkeletonText lines={4} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
