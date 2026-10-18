'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';

/** Delete a draft campaign (a campaign that started keeps its report). */
export function DeleteDraftButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={async () => {
          const yes = await confirm({
            title: 'Delete this draft?',
            description: 'Its recipients and attachments go too.',
            confirmLabel: 'Delete draft',
            tone: 'danger',
          });
          if (!yes) return;
          setBusy(true);
          const res = await fetch(`/api/campaigns/${campaignId}`, { method: 'DELETE' });
          if (res.ok) {
            router.push('/fund-ii?tab=campaigns');
            return;
          }
          setBusy(false);
          const json = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(json?.error?.message ?? 'Could not delete it. Try again.');
        }}
      >
        {busy ? null : <Trash2 aria-hidden="true" />}
        Delete draft
      </Button>
      {confirmDialog}
    </>
  );
}
