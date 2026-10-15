'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LayoutGrid, MoreHorizontal, Plus, Table2 } from 'lucide-react';
import { deleteCrmViewAction, saveCrmViewAction } from '@/app/actions/crm-views';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CRM_VIEW_NAME_MAX, type CrmSavedView, type CrmViewState } from '@/lib/crm/saved-views';
import { crmListHref, crmViewParams, type CrmListParams } from '@/lib/crm/view';
import { cn } from '@/lib/util/cn';

type Dialogs =
  | { kind: 'new' }
  | { kind: 'rename'; view: CrmSavedView }
  | { kind: 'delete'; view: CrmSavedView }
  | null;

function failed(message: string | undefined, fallback: string, stillUsable?: string): void {
  toast.error(message ?? fallback, { description: stillUsable });
}

/**
 * The view switcher at the top of a list, like Affinity's view tabs: the
 * built-in All view, then the list's saved views. Changing what the page
 * shows (a filter, the sort, the columns, the layout) marks the view
 * changed, with Save, Save as new view and Reset beside it; a saved view
 * also renames and deletes from its menu. Saved views belong to the list,
 * so everyone on it sees them.
 */
export function ViewTabs({
  listId,
  listName,
  params,
  views,
  active,
  dirty,
  state,
  canWrite,
}: {
  listId: string;
  listName: string;
  params: CrmListParams;
  views: readonly CrmSavedView[];
  active: CrmSavedView | null;
  /** The page shows something other than the active view as saved. */
  dirty: boolean;
  /** What "Save" would store: the page's state as it stands. */
  state: CrmViewState;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<Dialogs>(null);
  const [saving, startSaving] = React.useTransition();
  const hrefFor = (viewId: string) => crmListHref(listId, crmViewParams(params, viewId));

  const saveActive = () => {
    if (!active) return;
    startSaving(async () => {
      const result = await saveCrmViewAction(listId, { id: active.id, state }).catch(() => null);
      if (!result) return failed(undefined, 'The view could not be saved: no connection.');
      if (!result.ok) {
        return failed(
          result.error?.message,
          'The view could not be saved.',
          result.error?.stillUsable,
        );
      }
      toast.success(`Saved “${active.name}”.`);
      router.push(hrefFor(active.id), { scroll: false });
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2 border-b border-[var(--border)]">
        <nav aria-label="Views" className="-mb-px min-w-0 flex-1">
          <ul className="-mx-1 flex scrollbar-thin gap-1 overflow-x-auto px-1">
            <ViewTab href={hrefFor('')} current={!active} label="All" layout="table" />
            {views.map((view) => (
              <ViewTab
                key={view.id}
                href={hrefFor(view.id)}
                current={active?.id === view.id}
                label={view.name}
                layout={view.view}
              />
            ))}
          </ul>
        </nav>
        {canWrite ? (
          <div className="flex shrink-0 items-center gap-1 pb-1">
            {active ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Options for the ${active.name} view`}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent aria-label={`${active.name} view`} className="w-48">
                  <ul className="space-y-0.5">
                    <li>
                      <PopoverClose asChild>
                        <button
                          type="button"
                          onClick={() => setDialog({ kind: 'rename', view: active })}
                          className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                        >
                          Rename view
                        </button>
                      </PopoverClose>
                    </li>
                    <li>
                      <PopoverClose asChild>
                        <button
                          type="button"
                          onClick={() => setDialog({ kind: 'delete', view: active })}
                          className="w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--danger)] hover:bg-[var(--bg-hover)]"
                        >
                          Delete view
                        </button>
                      </PopoverClose>
                    </li>
                  </ul>
                </PopoverContent>
              </Popover>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'new' })}>
              <Plus aria-hidden="true" />
              New view
            </Button>
          </div>
        ) : null}
      </div>

      {dirty ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-1.5 text-sm"
        >
          <span className="min-w-0 flex-1 text-[var(--fg-muted)]">
            {active ? `Unsaved changes to “${active.name}”` : 'Showing a changed view of All'}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {canWrite && active ? (
              <Button size="sm" variant="primary" onClick={saveActive} loading={saving}>
                Save view
              </Button>
            ) : null}
            {canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'new' })}>
                Save as new view
              </Button>
            ) : null}
            <Button asChild size="sm" variant="ghost">
              <Link href={hrefFor(active?.id ?? '')} scroll={false}>
                Reset
              </Link>
            </Button>
          </span>
        </div>
      ) : null}

      <NameDialog
        key={dialog?.kind === 'rename' ? `rename-${dialog.view.id}` : (dialog?.kind ?? 'none')}
        open={dialog?.kind === 'new' || dialog?.kind === 'rename'}
        mode={dialog?.kind === 'rename' ? 'rename' : 'new'}
        initial={dialog?.kind === 'rename' ? dialog.view.name : ''}
        listName={listName}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const result = await saveCrmViewAction(
            listId,
            dialog?.kind === 'rename' ? { id: dialog.view.id, name } : { name, state },
          ).catch(() => null);
          if (!result) {
            failed(undefined, 'The view could not be saved: no connection.');
            return false;
          }
          if (!result.ok || !result.data) {
            failed(
              result.error?.message,
              'The view could not be saved.',
              result.error?.stillUsable,
            );
            return false;
          }
          const saved = result.data.view;
          setDialog(null);
          if (dialog?.kind === 'rename') {
            toast.success(`Renamed the view to “${saved.name}”.`);
            router.refresh();
          } else {
            toast.success(`Saved the view “${saved.name}”.`);
            router.push(hrefFor(saved.id), { scroll: false });
          }
          return true;
        }}
      />

      <Dialog open={dialog?.kind === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog?.kind === 'delete' ? (
          <DialogContent
            title={`Delete “${dialog.view.name}”?`}
            description={`The view goes for everyone on ${listName}. The list and its entries are untouched.`}
          >
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                loading={saving}
                onClick={() =>
                  startSaving(async () => {
                    const view = dialog.view;
                    const result = await deleteCrmViewAction(listId, view.id).catch(() => null);
                    if (!result)
                      return failed(undefined, 'The view could not be deleted: no connection.');
                    if (!result.ok) {
                      return failed(
                        result.error?.message,
                        'The view could not be deleted.',
                        result.error?.stillUsable,
                      );
                    }
                    setDialog(null);
                    toast.success(`Deleted the view “${view.name}”.`);
                    router.push(hrefFor(''), { scroll: false });
                  })
                }
              >
                Delete view
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function ViewTab({
  href,
  current,
  label,
  layout,
}: {
  href: string;
  current: boolean;
  label: string;
  layout: 'table' | 'board';
}) {
  const Icon = layout === 'board' ? LayoutGrid : Table2;
  return (
    <li className="shrink-0">
      <Link
        href={href}
        scroll={false}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'relative inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-[var(--motion-fast)]',
          current
            ? 'border-[var(--accent)] text-[var(--fg)]'
            : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
        )}
      >
        <Icon className="size-3.5 opacity-70" aria-hidden="true" />
        {label}
      </Link>
    </li>
  );
}

function NameDialog({
  open,
  mode,
  initial,
  listName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'new' | 'rename';
  initial: string;
  listName: string;
  onClose: () => void;
  /** Resolves true when saved (the dialog then closes). */
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = React.useState(initial);
  const [pending, startPending] = React.useTransition();
  const id = React.useId();
  const trimmed = name.trim();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <DialogContent
          title={mode === 'rename' ? 'Rename view' : 'Save as new view'}
          description={
            mode === 'rename'
              ? `Views are shared by everyone on ${listName}.`
              : `Saves the columns, sort, filters and layout on screen as a view of ${listName}, for everyone on it.`
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!trimmed) return;
              startPending(async () => {
                await onSubmit(trimmed);
              });
            }}
          >
            <Field label="View name" htmlFor={id}>
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={CRM_VIEW_NAME_MAX}
                autoFocus
                placeholder="e.g. Active pipeline"
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={pending}
                disabled={!trimmed || pending}
              >
                {mode === 'rename' ? 'Rename' : 'Save view'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
