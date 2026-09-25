'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRefreshLoading } from '@/components/shell/refresh-status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { readTasksView, withTasksView, type TasksView } from '@/lib/tasks/tasks-view';

/**
 * The To do and Completed tabs of the Tasks page.
 *
 * The server renders both panels once and a click only switches between them.
 * As on Deals, the clicked tab shows at once, from state, and is then written
 * to the URL with `history.pushState`, which Next folds into `useSearchParams`
 * without a server render, so a reload, a shared link and Back keep it. That
 * write waits while a row action's `router.refresh()` is loading: Next would
 * apply the URL on top of the refresh and hold every update until it lands.
 */
export function TasksTabs({
  todoCount,
  completedCount,
  todo,
  completed,
}: {
  todoCount: number;
  completedCount: number;
  todo: React.ReactNode;
  completed: React.ReactNode;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const refreshLoading = useRefreshLoading();

  const inUrl = readTasksView(params.get('view'));
  // The tab last clicked, until the URL holds it.
  const [chosen, setChosen] = React.useState<TasksView | null>(null);
  if (chosen && chosen === inUrl) setChosen(null);
  const view = chosen ?? inUrl;

  const query = params.toString();
  React.useEffect(() => {
    if (!chosen || refreshLoading) return;
    const current = new URLSearchParams(window.location.search).toString();
    const next = withTasksView(window.location.search, chosen).toString();
    if (next === current) return;
    window.history.pushState(null, '', next ? `${pathname}?${next}` : pathname);
  }, [chosen, refreshLoading, pathname, query]);

  React.useEffect(() => {
    // Back and Forward land on a URL of their own; a click not yet written
    // there must not override it.
    const drop = () => setChosen(null);
    window.addEventListener('popstate', drop);
    return () => window.removeEventListener('popstate', drop);
  }, []);

  return (
    <Tabs value={view} onValueChange={(value) => setChosen(readTasksView(value))}>
      <TabsList aria-label="Tasks">
        <TabsTrigger value="todo">
          To do <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{todoCount}</span>
        </TabsTrigger>
        <TabsTrigger value="completed">
          Completed <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{completedCount}</span>
        </TabsTrigger>
      </TabsList>
      {/* Both stay mounted, so a pending row action and "Show more" survive a switch. */}
      <TabsContent value="todo" forceMount className="pt-6 data-[state=inactive]:hidden">
        {todo}
      </TabsContent>
      <TabsContent value="completed" forceMount className="pt-6 data-[state=inactive]:hidden">
        {completed}
      </TabsContent>
    </Tabs>
  );
}
