'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { MailPlus } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { campaignHref, eventsApi } from '@/components/events/events-client';

/** The toast after a draft is made: how many it reached, and what was left out. */
export function draftedMessage(data: {
  added: number;
  left: { unsubscribed: number; noEmail: number; invalid: number; overLimit: number };
  notLive: boolean;
}): string {
  const parts = [
    data.added
      ? `Draft ready for ${data.added} ${data.added === 1 ? 'guest' : 'guests'}. Review it, then tap Send.`
      : 'Draft ready, with nobody on it yet: no guest matched. Add people in the review, or pick another group.',
  ];
  const left = data.left.unsubscribed + data.left.noEmail + data.left.invalid + data.left.overLimit;
  if (left) parts.push(`${left} left out (no email, unsubscribed or over the limit).`);
  if (data.notLive) parts.push('The page is not published yet: publish it before you send.');
  return parts.join(' ');
}

/**
 * One tap that drafts an event message (POST /api/events/[id]/campaign) and
 * opens it in the campaign review. Sends nothing: Send is a separate,
 * deliberate tap there.
 */
export function DraftButton({
  eventId,
  body,
  children,
  variant = 'secondary',
  size = 'sm',
  disabled,
}: {
  eventId: string;
  body: Record<string, unknown>;
  children: React.ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const draft = async () => {
    setBusy(true);
    const result = await eventsApi.draftMessage(eventId, body);
    if (!result.ok) {
      setBusy(false);
      toast.error(result.message);
      return;
    }
    toast.success(draftedMessage(result.data), { duration: 8000 });
    router.push(campaignHref(result.data.campaignId));
  };
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      loading={busy}
      disabled={disabled}
      onClick={() => void draft()}
    >
      {busy ? null : <MailPlus aria-hidden="true" />}
      {children}
    </Button>
  );
}
