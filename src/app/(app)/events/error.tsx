'use client';

import { PageShell } from '@/components/shell/page-header';
import { ErrorState } from '@/components/ui/feedback';

/**
 * Something on an Events page failed to render. It says so, says the rest of
 * Kraken is fine, and offers to try again (this Next.js calls it `retry`).
 */
export default function EventsError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <PageShell>
      <ErrorState
        title="This Events page could not be shown"
        message="Something went wrong while loading it. Nothing was changed."
        stillUsable="Every other page in Kraken."
        retry={{ label: 'Try again', onClick: () => retry() }}
      />
    </PageShell>
  );
}
