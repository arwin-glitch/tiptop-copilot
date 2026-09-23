'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { refreshUpdatesAction } from '@/app/actions';
import { Button } from '@/components/ui/button';

export function RefreshUpdatesButton() {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshUpdatesAction();
          if (result.ok) {
            router.refresh();
            toast.success(
              result.data?.throttled
                ? 'Checked moments ago — showing the latest copy'
                : 'Updates refreshed',
            );
          } else {
            toast.error(result.error?.message ?? 'Could not refresh the updates', {
              description: result.error?.stillUsable,
            });
          }
        })
      }
    >
      <RefreshCw aria-hidden="true" />
      Refresh
    </Button>
  );
}
