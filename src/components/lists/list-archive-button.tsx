'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Archive, ArchiveRestore } from 'lucide-react';
import { setCrmListArchivedAction } from '@/app/actions/crm';
import { Button } from '@/components/ui/button';

/**
 * Archive a list, or restore it. The way back from a list that should not be
 * on the Lists page — imported from the wrong file, or into a new list by
 * mistake — without losing anything: an archived list keeps every row and
 * sits under "Archived lists" until it is restored.
 */
export function ListArchiveButton({
  listId,
  listName,
  archived,
}: {
  listId: string;
  listName: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [saving, startSaving] = React.useTransition();

  const toggle = () =>
    startSaving(async () => {
      const result = await setCrmListArchivedAction(listId, !archived).catch(() => null);
      if (!result?.ok) {
        toast.error(
          result?.error?.message ??
            `${listName} could not be ${archived ? 'restored' : 'archived'}: no connection.`,
          { description: result?.error?.stillUsable },
        );
        return;
      }
      toast.success(
        archived
          ? `Restored ${listName} to Lists.`
          : `Archived ${listName}. It is under “Archived lists” on the Lists page.`,
      );
      React.startTransition(() => router.refresh());
    });

  return (
    <Button variant="secondary" size="sm" loading={saving} onClick={toggle}>
      {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
      {archived ? 'Restore list' : 'Archive list'}
    </Button>
  );
}
