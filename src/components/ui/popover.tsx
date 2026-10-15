'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/util/cn';

/**
 * A small floating panel anchored to its trigger — a column picker, a filter
 * menu. Radix supplies the focus handling (focus moves in on open and back to
 * the trigger on close, Escape and an outside click dismiss), which is the
 * part a hand-rolled dropdown always gets wrong.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'shadow-overlay z-[var(--z-overlay)] max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-64 scrollbar-thin overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-2',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
