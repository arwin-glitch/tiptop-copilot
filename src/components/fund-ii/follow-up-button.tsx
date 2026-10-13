'use client';

import * as React from 'react';
import { Check, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Composer, type ComposeDraft } from '@/components/inbox/composer';

/**
 * "Follow up" on a DocSend reader: opens the compose window with a short note
 * in Nick's voice. Sending needs the opt-in grant; without it the window
 * offers Copy for Gmail instead.
 */
export function FollowUpButton({
  draft,
  canSend,
  who,
}: {
  draft: ComposeDraft;
  canSend: boolean;
  who: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Reply aria-hidden />
        Follow up<span className="sr-only"> with {who}</span>
      </Button>
      {sent ? (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ok)]">
          <Check className="size-3" aria-hidden /> Sent just now
        </span>
      ) : null}
      {open ? (
        <Composer
          title={`Follow up with ${who}`}
          initial={draft}
          canSend={canSend}
          onClose={() => setOpen(false)}
          onSent={() => setSent(true)}
        />
      ) : null}
    </>
  );
}
