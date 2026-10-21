'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRefreshLoading } from '@/components/shell/refresh-status';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TaskPerson } from '@/lib/tasks/task-people';
import {
  readTasksView,
  readTasksWho,
  withTasksView,
  withTasksWho,
  type TasksView,
  type TasksWho,
} from '@/lib/tasks/tasks-view';
import { cn } from '@/lib/util/cn';

const ROVING_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

interface WhoContextValue {
  who: TasksWho;
  setWho: (who: TasksWho) => void;
  people: readonly TaskPerson[];
}

const WhoContext = React.createContext<WhoContextValue>({
  who: 'all',
  setWho: () => {},
  people: [],
});

/** Whose tasks To do and Money & legal show, and the people to choose from. */
export function useTasksWho(): WhoContextValue {
  return React.useContext(WhoContext);
}

/**
 * The To do, Snoozed, Completed and Money & legal tabs of the Tasks page.
 *
 * The server renders every panel once and a click only switches between them.
 * As on Deals, the clicked tab shows at once, from state, and is then written
 * to the URL with `history.pushState`, which Next folds into `useSearchParams`
 * without a server render, so a reload, a shared link and Back keep it. That
 * write waits while a row action's `router.refresh()` is loading: Next would
 * apply the URL on top of the refresh and hold every update until it lands.
 * The person filter (`?who=`) is kept the same way, and shared by the lists
 * through `useTasksWho`.
 */
export function TasksTabs({
  todoCount,
  snoozedCount,
  completedCount,
  moneyCount,
  todo,
  snoozed,
  completed,
  money,
  people = [],
}: {
  todoCount: number;
  snoozedCount: number;
  completedCount: number;
  moneyCount: number;
  todo: React.ReactNode;
  snoozed: React.ReactNode;
  completed: React.ReactNode;
  money: React.ReactNode;
  people?: readonly TaskPerson[];
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const refreshLoading = useRefreshLoading();

  const inUrl = readTasksView(params.get('view'));
  // The tab last clicked, until the URL holds it.
  const [chosen, setChosen] = React.useState<TasksView | null>(null);
  if (chosen && chosen === inUrl) setChosen(null);
  const view = chosen ?? inUrl;

  const whoInUrl = readTasksWho(params.get('who'));
  const [chosenWho, setChosenWho] = React.useState<TasksWho | null>(null);
  if (chosenWho !== null && chosenWho === whoInUrl) setChosenWho(null);
  const who = chosenWho ?? whoInUrl;

  const query = params.toString();
  React.useEffect(() => {
    if ((!chosen && chosenWho === null) || refreshLoading) return;
    const current = new URLSearchParams(window.location.search).toString();
    let next = window.location.search;
    if (chosen) next = withTasksView(next, chosen).toString();
    if (chosenWho !== null) next = withTasksWho(next, chosenWho).toString();
    if (next === current) return;
    window.history.pushState(null, '', next ? `${pathname}?${next}` : pathname);
  }, [chosen, chosenWho, refreshLoading, pathname, query]);

  React.useEffect(() => {
    // Back and Forward land on a URL of their own; a click not yet written
    // there must not override it.
    const drop = () => {
      setChosen(null);
      setChosenWho(null);
    };
    window.addEventListener('popstate', drop);
    return () => window.removeEventListener('popstate', drop);
  }, []);

  // The keys Radix moves focus with still switch tabs, but focus alone does
  // not: a toast hands focus back to the tab clicked before its Undo when it
  // closes, and that must not switch the tab back seconds later.
  const arrowed = React.useRef(false);
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (!ROVING_KEYS.includes(event.key)) return;
    arrowed.current = true;
    // Radix moves focus in a timeout of its own, queued before this one.
    window.setTimeout(() => (arrowed.current = false));
  };
  const onTriggerFocus = (value: TasksView) => () => {
    if (!arrowed.current) return;
    arrowed.current = false;
    setChosen(value);
  };

  const whoValue = React.useMemo(
    () => ({ who, setWho: (next: TasksWho) => setChosenWho(next), people }),
    [who, people],
  );

  return (
    <WhoContext.Provider value={whoValue}>
      <Tabs
        value={view}
        activationMode="manual"
        onValueChange={(value) => setChosen(readTasksView(value))}
      >
        <TabsList aria-label="Tasks" data-tour="tasks-tabs" onKeyDown={onListKeyDown}>
          <TabsTrigger value="todo" onFocus={onTriggerFocus('todo')}>
            To do <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{todoCount}</span>
          </TabsTrigger>
          <TabsTrigger value="snoozed" onFocus={onTriggerFocus('snoozed')}>
            Snoozed <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{snoozedCount}</span>
          </TabsTrigger>
          <TabsTrigger value="completed" onFocus={onTriggerFocus('completed')}>
            Completed{' '}
            <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{completedCount}</span>
          </TabsTrigger>
          <TabsTrigger value="money" onFocus={onTriggerFocus('money')} data-tour="tasks-money">
            Money &amp; legal{' '}
            <span className="tabular ml-0.5 text-[var(--fg-subtle)]">{moneyCount}</span>
          </TabsTrigger>
        </TabsList>
        {/* All stay mounted, so a pending row action and "Show more" survive a switch. */}
        <TabsContent value="todo" forceMount className="pt-6 data-[state=inactive]:hidden">
          {todo}
        </TabsContent>
        <TabsContent value="snoozed" forceMount className="pt-6 data-[state=inactive]:hidden">
          {snoozed}
        </TabsContent>
        <TabsContent value="completed" forceMount className="pt-6 data-[state=inactive]:hidden">
          {completed}
        </TabsContent>
        <TabsContent value="money" forceMount className="pt-6 data-[state=inactive]:hidden">
          {money}
        </TabsContent>
      </Tabs>
    </WhoContext.Provider>
  );
}

/**
 * Everyone, or one person's tasks: the filter over To do and Money & legal.
 * Shown only when the team has more than one person.
 */
export function WhoFilter({ className }: { className?: string }) {
  const { who, setWho, people } = useTasksWho();
  if (people.length < 2) return null;
  const options: { value: TasksWho; label: string }[] = [
    { value: 'all', label: 'Everyone' },
    ...people.map((p) => ({ value: p.id, label: p.short })),
  ];
  return (
    <div
      role="group"
      aria-label="Whose tasks"
      className={cn(
        'inline-flex flex-wrap rounded-md border border-[var(--border)] p-0.5 text-sm',
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={who === option.value}
          onClick={() => setWho(option.value)}
          className={
            who === option.value
              ? 'rounded bg-[var(--bg-hover)] px-3 py-1 font-medium'
              : 'rounded px-3 py-1 text-[var(--fg-muted)] hover:text-[var(--fg)]'
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
