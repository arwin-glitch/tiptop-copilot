'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/util/cn';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        '-mx-1 flex scrollbar-thin gap-1 overflow-x-auto border-b border-[var(--border)] px-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-[var(--fg-muted)] transition-colors duration-[var(--motion-fast)]',
        'hover:text-[var(--fg)]',
        'data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--fg)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  // A short fade on arrival, so switching tabs reads as a change rather than a
  // flicker. The reduced-motion block in globals.css collapses it to nothing.
  return (
    <TabsPrimitive.Content
      className={cn('animate-fade-in pt-4 outline-none', className)}
      {...props}
    />
  );
}
