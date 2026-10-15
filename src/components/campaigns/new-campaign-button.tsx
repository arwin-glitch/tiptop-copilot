'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/** Start a draft and open it. A draft sends nothing. */
export function NewCampaignButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const start = async () => {
    setBusy(true);
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = (await res.json().catch(() => null)) as {
      id?: string;
      error?: { message?: string };
    } | null;
    if (res.ok && json?.id) {
      router.push(`/fund-ii/campaigns/${json.id}`);
      return;
    }
    setBusy(false);
    toast.error(json?.error?.message ?? 'Could not start a campaign. Try again.');
  };
  return (
    <Button variant="primary" size={size} onClick={start} loading={busy}>
      {busy ? null : <Plus aria-hidden="true" />}
      New campaign
    </Button>
  );
}
