'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { FileText, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MENU_ITEM } from '@/components/inbox/inbox-menus';

export interface ComposeTemplate {
  id: string;
  name: string;
  subject: string;
  html: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

/**
 * Gmail's "Templates" in the compose window: insert a saved template, save
 * the compose box as one (a name already used overwrites it, after asking),
 * or delete one (after asking). Templates are the workspace's, kept by
 * Kraken (lib/services/inbox-templates.ts). Inserting only fills the box;
 * nothing here sends.
 */
export function TemplatesMenu({
  disabled,
  current,
  onInsert,
  className,
}: {
  disabled?: boolean;
  /** The compose box now, for Save draft as template. */
  current: () => { subject: string; html: string };
  onInsert: (template: ComposeTemplate) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [list, setList] = React.useState<ComposeTemplate[] | null>(null);
  const [ready, setReady] = React.useState(true);
  const [mode, setMode] = React.useState<'menu' | 'save' | 'delete'>('menu');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = React.useCallback(async () => {
    const res = await fetch('/api/inbox/templates', { cache: 'no-store' });
    if (!res.ok) {
      setList([]);
      return;
    }
    const j = (await res.json()) as { ready: boolean; templates: ComposeTemplate[] };
    setReady(j.ready);
    setList(j.templates);
  }, []);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setMode('menu');
      setName('');
      void load();
    }
  };

  const save = async () => {
    const clean = name.trim();
    if (!clean) return;
    const existing = list?.find((t) => t.name.toLowerCase() === clean.toLowerCase());
    if (existing) {
      setOpen(false);
      const yes = await confirm({
        title: `Overwrite “${existing.name}”?`,
        description: 'The saved template is replaced with what is in this compose box now.',
        confirmLabel: 'Overwrite',
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/inbox/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean, ...current() }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, 'Could not save the template. Try again.'));
        return;
      }
      toast.success(`Template “${clean}” saved`);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: ComposeTemplate) => {
    setOpen(false);
    const yes = await confirm({
      title: `Delete template “${t.name}”?`,
      description:
        'It is gone for everyone in the workspace. Emails already written stay as they are.',
      confirmLabel: 'Delete template',
      tone: 'danger',
    });
    if (!yes) return;
    const res = await fetch(`/api/inbox/templates?id=${encodeURIComponent(t.id)}`, {
      method: 'DELETE',
    });
    if (res.ok) toast.success(`Template “${t.name}” deleted`);
    else toast.error(await errorMessage(res, 'Could not delete the template. Try again.'));
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label="Templates"
            title="Templates"
            disabled={disabled}
            className={className}
          >
            <FileText className="size-4" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" aria-label="Templates" className="w-72 p-1">
          {list === null ? (
            <p className="px-2 py-1.5 text-sm text-[var(--fg-muted)]">Loading…</p>
          ) : !ready ? (
            <p className="px-2 py-1.5 text-sm text-[var(--fg-muted)]">
              Templates need a database update before they can be used. Nothing else changes.
            </p>
          ) : mode === 'save' ? (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label htmlFor="template-name" className="text-sm text-[var(--fg-muted)]">
                Template name
              </label>
              <input
                id="template-name"
                autoFocus
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                className="h-8 w-full rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] px-2 text-sm"
              />
              <div className="flex justify-end gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => setMode('menu')}>
                  Back
                </Button>
                <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>
                  Save
                </Button>
              </div>
            </form>
          ) : (
            <div role="menu" className="space-y-px">
              <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-[var(--fg-muted)]">
                {mode === 'delete' ? 'Delete template' : 'Insert template'}
              </p>
              {list.length === 0 ? (
                <p className="px-2 py-1 text-sm text-[var(--fg-subtle)]">No saved templates</p>
              ) : (
                list.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      if (mode === 'delete') void remove(t);
                      else {
                        setOpen(false);
                        onInsert(t);
                      }
                    }}
                  >
                    {mode === 'delete' ? (
                      <Trash2 className="size-4 text-[var(--fg-muted)]" aria-hidden />
                    ) : (
                      <FileText className="size-4 text-[var(--fg-muted)]" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  </button>
                ))
              )}
              <div role="separator" className="my-1 h-px bg-[var(--border)]" />
              {mode === 'delete' ? (
                <button type="button" className={MENU_ITEM} onClick={() => setMode('menu')}>
                  <span className="min-w-0 flex-1">Back</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => setMode('save')}
                  >
                    <Save className="size-4 text-[var(--fg-muted)]" aria-hidden />
                    <span className="min-w-0 flex-1">Save draft as template</span>
                  </button>
                  {list.length ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM}
                      onClick={() => setMode('delete')}
                    >
                      <Trash2 className="size-4 text-[var(--fg-muted)]" aria-hidden />
                      <span className="min-w-0 flex-1">Delete template</span>
                    </button>
                  ) : null}
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {confirmDialog}
    </>
  );
}
