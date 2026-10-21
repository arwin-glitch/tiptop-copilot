'use client';

import * as React from 'react';
import { Check, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/inbox/composer';
import type { IntroDraft } from '@/lib/intros/intro-draft';

/**
 * "Write the intro" on an owed intro: opens the compose window on a fresh
 * thread in the intro format, addressed only to the people whose email is on
 * file. Nothing sends until someone taps Send; without the sending grant the
 * window offers Copy for Gmail instead.
 */
export function WriteIntroButton({
  draft,
  canSend,
  who,
}: {
  draft: IntroDraft;
  canSend: boolean;
  /** "Harbor Labs → Northwind Capital", for the button's accessible name. */
  who: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <PenLine aria-hidden />
        Write the intro<span className="sr-only"> for {who}</span>
      </Button>
      {sent ? (
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ok)]">
          <Check className="size-3" aria-hidden /> Sent just now
        </span>
      ) : null}
      {open ? (
        <Composer
          title="Write the intro"
          initial={{ ...draft, links: true }}
          canSend={canSend}
          onClose={() => setOpen(false)}
          onSent={() => setSent(true)}
        />
      ) : null}
    </>
  );
}
