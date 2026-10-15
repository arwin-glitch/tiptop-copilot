'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setCrmListDestinationAction } from '@/app/actions/crm';
import {
  CRM_DESTINATION_INFO,
  CRM_DESTINATIONS,
  type CrmDestination,
} from '@/lib/crm/destinations';
import { cn } from '@/lib/util/cn';

/**
 * Where one Affinity list's rows go: "(auto)", what its name says, or a
 * destination picked by hand. A native select like the status control, so it
 * is keyboard- and screen-reader-correct and the platform picker on a phone.
 * On a change the page refreshes and the list moves to its new group.
 */
export function DestinationSelect({
  listId,
  listName,
  chosen,
  auto,
  className,
}: {
  listId: string;
  listName: string;
  /** The destination picked by hand, or null when the list is on automatic. */
  chosen: CrmDestination | null;
  /** What the rules say, shown on the "Automatic" option. */
  auto: CrmDestination;
  className?: string;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState<string>(chosen ?? '');
  const [saving, startSaving] = React.useTransition();

  const change = (next: string) => {
    const before = value;
    setValue(next);
    startSaving(async () => {
      const result = await setCrmListDestinationAction(listId, next || null).catch(() => null);
      const moved = result?.ok ? result.data?.destination : undefined;
      if (!moved) {
        setValue(before);
        toast.error(result?.error?.message ?? `${listName} could not be moved: no connection.`, {
          description: result?.error?.stillUsable,
        });
        return;
      }
      const info = CRM_DESTINATION_INFO[moved.destination];
      toast.success(
        info.key === 'archive'
          ? `${listName} is kept here for reference only.`
          : `${listName} now feeds ${info.page}: ${info.label}.`,
      );
      React.startTransition(() => router.refresh());
    });
  };

  return (
    <select
      aria-label={`Where ${listName} goes`}
      value={value}
      disabled={saving}
      onChange={(e) => change(e.target.value)}
      className={cn(
        'h-8 max-w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-raised)] pr-6 pl-2 text-xs text-[var(--fg)] hover:border-[var(--border-strong)] disabled:cursor-wait disabled:opacity-60',
        className,
      )}
    >
      <option value="">{CRM_DESTINATION_INFO[auto].label} (auto)</option>
      {CRM_DESTINATIONS.map((d) => (
        <option key={d} value={d}>
          {CRM_DESTINATION_INFO[d].label}
        </option>
      ))}
    </select>
  );
}
