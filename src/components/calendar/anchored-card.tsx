'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/util/cn';

/**
 * A card that opens next to what it is about, as Google Calendar's event
 * card and quick editor do: beside the event (or the slot just dragged), on
 * whichever side has room, never a centred dialog over the calendar. On a
 * phone it is a sheet from the bottom of the screen instead.
 *
 * Radix places it and handles focus. It closes on Esc or a press outside it;
 * focus moving into a question asked on top of it (Send / Don't send) keeps
 * it open, so the answer lands back on it.
 */

type Side = 'right' | 'left' | 'bottom' | 'top';

/** The side with room for a card this wide: right, then left, then below or above. */
function pickSide(rect: DOMRect, width: number): Side {
  const room = width + 24;
  if (window.innerWidth - rect.right >= room) return 'right';
  if (rect.left >= room) return 'left';
  return window.innerHeight - rect.bottom >= rect.top ? 'bottom' : 'top';
}

export function AnchoredCard({
  open,
  getAnchor,
  phone,
  label,
  width = 416,
  onClose,
  className,
  children,
  ...data
}: {
  open: boolean;
  /** What the card is next to, read whenever it is placed (it may re-render). */
  getAnchor: () => HTMLElement | null;
  phone: boolean;
  /** The card's accessible name (the event's title, "New event"). */
  label: string;
  /** Its width on a computer, in px. */
  width?: number;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const anchorRef = React.useRef(getAnchor);
  // Before the side is picked (below) and before Radix places the card.
  React.useLayoutEffect(() => {
    anchorRef.current = getAnchor;
  });
  const lastRect = React.useRef<DOMRect | null>(null);
  const virtualRef = React.useMemo(
    () => ({
      current: {
        getBoundingClientRect(): DOMRect {
          const el = anchorRef.current();
          if (el?.isConnected) lastRect.current = el.getBoundingClientRect();
          return (
            lastRect.current ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 3, 0, 0)
          );
        },
        // Lets Radix follow the anchor when its list scrolls.
        get contextElement() {
          const el = anchorRef.current();
          return el?.isConnected ? el : undefined;
        },
      },
    }),
    [],
  );
  const [side, setSide] = React.useState<Side>('right');
  React.useLayoutEffect(() => {
    if (!open || phone) return;
    setSide(pickSide(virtualRef.current.getBoundingClientRect(), width));
  }, [open, phone, width, virtualRef]);

  if (phone) {
    return (
      <DialogPrimitive.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-x-0 top-[var(--titlebar-h)] bottom-0 z-[var(--z-overlay)] bg-[var(--scrim)]" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            data-sheet=""
            {...data}
            className={cn(
              'shadow-overlay fixed inset-x-0 bottom-0 z-[var(--z-overlay)] flex max-h-[88dvh] flex-col rounded-t-[var(--radius-panel)] border-t border-[var(--border-strong)] bg-[var(--bg-overlay)] pb-[env(safe-area-inset-bottom)]',
              className,
            )}
          >
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            <span
              aria-hidden
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--border-strong)]"
            />
            <div className="scrollbar-thin overflow-y-auto">{children}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <PopoverPrimitive.Anchor virtualRef={virtualRef} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={side === 'right' || side === 'left' ? 'start' : 'center'}
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          {...data}
          onFocusOutside={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            // Back to the event it opened from, when it is still there.
            e.preventDefault();
            const el = anchorRef.current();
            if (el?.isConnected && el.tabIndex >= 0) el.focus({ preventScroll: true });
          }}
          style={{ width: `min(${width}px, calc(100vw - 1.5rem))` }}
          className={cn(
            'shadow-overlay z-[var(--z-overlay)] max-h-[min(80dvh,var(--radix-popover-content-available-height))] scrollbar-thin overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-overlay)]',
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
