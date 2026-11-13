'use client';

import * as React from 'react';
import { initialOf } from '@/lib/email/inbox-folders';
import { avatarAddress } from '@/lib/email/avatar-source';
import { cn } from '@/lib/util/cn';

/**
 * A sender's round avatar: their photo or company logo when one is found
 * (app/api/avatar), the initial until then and when there is none.
 */
export function SenderAvatar({
  name,
  email,
  className,
}: {
  name: string;
  email: string | null | undefined;
  className?: string;
}) {
  const address = avatarAddress(email);
  const [shown, setShown] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <span
      aria-hidden
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--nav-active)] font-semibold text-[var(--accent)]',
        className,
      )}
    >
      {shown ? null : initialOf(name)}
      {address && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small avatar from Kraken's own route
        <img
          src={`/api/avatar?e=${encodeURIComponent(address)}`}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setShown(true)}
          onError={() => setFailed(true)}
          className={cn(
            'absolute inset-0 size-full bg-white object-cover',
            shown ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </span>
  );
}
