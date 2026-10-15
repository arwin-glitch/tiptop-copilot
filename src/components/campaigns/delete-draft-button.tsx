'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** Delete a draft campaign (a campaign that started keeps its report). */
export function DeleteDraftButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        if (!window.confirm('Delete this draft? Its recipients and attachments go too.')) return;
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
  );
}
