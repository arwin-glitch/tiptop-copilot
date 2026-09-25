'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useReportRefresh } from '@/components/shell/refresh-status';

type ActionOutcome = { ok: boolean; error?: { message: string } };

interface TaskActionHost {
  /** Runs `fn`, toasts the outcome and refreshes the page, as one reported refresh. */
  run: (fn: () => Promise<ActionOutcome>, messages: { success: string; error: string }) => void;
}

const HostContext = React.createContext<TaskActionHost | null>(null);

/**
 * Runs the Undo in a task toast. The row that showed the toast is gone once
 * its refresh lands, so the Undo cannot use that row's transition. This host
 * is mounted once around every page and never unmounts, so its transition
 * stays pending until the Undo's refresh lands, and the Tasks tabs hold their
 * URL write for it the same way they do for a row action.
 */
export function TaskActionHost({ children }: { children: React.ReactNode }) {
  const [pending, startTransition] = React.useTransition();
  const reportRefresh = useReportRefresh(pending);
  const router = useRouter();

  const run = React.useCallback<TaskActionHost['run']>(
    (fn, messages) => {
      reportRefresh();
      startTransition(async () => {
        const result = await fn();
        if (result.ok) {
          toast.success(messages.success);
          router.refresh();
        } else {
          toast.error(result.error?.message ?? messages.error);
        }
      });
    },
    [reportRefresh, router],
  );

  const value = React.useMemo(() => ({ run }), [run]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useTaskActionHost(): TaskActionHost {
  const host = React.useContext(HostContext);
  if (!host) throw new Error('useTaskActionHost needs a TaskActionHost above it (the app layout).');
  return host;
}
