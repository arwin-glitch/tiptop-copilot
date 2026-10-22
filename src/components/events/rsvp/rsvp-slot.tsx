'use client';

import type { RsvpSlotProps } from '@/lib/events/contracts';

/**
 * CONTRACT STUB — owned by WS4 (Guests). Replace the body, keep the export:
 * `RsvpSlot` (props: RsvpSlotProps in lib/events/contracts.ts).
 *
 * WS2's RSVP block mounts this. The real one is the registration form
 * (sessions, questions, plus-ones, honeypot + signed render time, the result
 * states and the RSVP moment) posting to `context.endpoint`. In 'studio' and
 * 'og' modes it must render a static, non-interactive mock and make no
 * network call.
 */
export function RsvpSlot({ variant, labels, mode, context }: RsvpSlotProps) {
  const open = Boolean(context?.registration.open) && mode === 'live';
  return (
    <div data-rsvp-slot data-variant={variant}>
      <button type="button" disabled aria-disabled="true">
        {labels.cta || 'RSVP'}
      </button>
      <p>{open ? 'Registration is being set up.' : 'Registration is not open yet.'}</p>
    </div>
  );
}
