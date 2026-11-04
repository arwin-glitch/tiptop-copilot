'use client';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SHORTCUT_GROUPS } from '@/lib/email/inbox-keys';

/** Gmail's `?` overlay: every Inbox shortcut, grouped as Gmail groups them. */
export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Keyboard shortcuts"
          description="Press ? any time in the Inbox to see these again."
          className="max-w-3xl"
        >
          <div className="grid gap-6 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title}>
                <h3 className="mb-2 text-sm font-semibold text-[var(--accent)]">{group.title}</h3>
                <dl className="space-y-1.5">
                  {group.keys.map((k) => (
                    <div key={k.keys} className="flex items-baseline justify-between gap-3 text-sm">
                      <dt className="text-[var(--fg-muted)]">{k.what}</dt>
                      <dd>
                        <kbd className="rounded border border-[var(--border-strong)] bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-[var(--fg)]">
                          {k.keys}
                        </kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
