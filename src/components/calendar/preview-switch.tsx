'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/form';
import { savePrefs } from './calendar-api';

/** A phone-sized screen: the new views open on Day there, like Google Calendar's app. */
export const PHONE_QUERY = '(max-width: 639px)';

/**
 * The switch between the day list (the default) and the new Day, Week and
 * Month views, remembered per person. On the day list it opens the new views
 * on the same day (on a phone, `phoneHref`: Day view); on the new views it
 * goes back to the day list.
 */
export function PreviewSwitch({
  on,
  openHref,
  phoneHref,
}: {
  on: boolean;
  openHref: string;
  phoneHref?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();

  const flip = async (next: boolean) => {
    setBusy(true);
    const saved = await savePrefs({ preview: next });
    if (!saved.ok) toast.error('That choice could not be remembered, but here it is.');
    const open = phoneHref && window.matchMedia(PHONE_QUERY).matches ? phoneHref : openHref;
    // Without a saved choice the address carries it, so the page still switches.
    router.push(next ? open : saved.ok ? '/calendar' : '/calendar?view=list');
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-2">
      <Switch
        id={id}
        checked={on}
        disabled={busy}
        onCheckedChange={(checked) => void flip(checked)}
        aria-describedby={`${id}-hint`}
      />
      <label htmlFor={id} className="text-sm font-medium whitespace-nowrap">
        New calendar (preview)
      </label>
      <span id={`${id}-hint`} className="sr-only">
        {on
          ? 'On: day, week and month views. Turn off to go back to the day list.'
          : 'Off: the day list. Turn on for day, week and month views.'}
      </span>
    </div>
  );
}
