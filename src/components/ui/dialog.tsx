'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { ignoreTitleBarPointer } from '@/lib/desktop/title-bar';
import { cn } from '@/lib/util/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        // From under the desktop app's top bar (0px high anywhere else): its
        // blur would otherwise draw what is behind the bar into a light line
        // along the bar's lower edge.
        'fixed inset-x-0 top-[var(--titlebar-h)] bottom-0 z-[var(--z-overlay)] bg-[var(--scrim)] backdrop-blur-[2px]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A press on the desktop app's top bar (minimise, the menu, search, moving
 * the window) is not a click outside: the dialog stays open. The bar stays
 * clear of the scrim, so dialogs are centred, and drawers start, below it.
 */
function keepOpenForTitleBar(
  handler: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>['onPointerDownOutside'],
) {
  return (event: Parameters<NonNullable<typeof handler>>[0]) => {
    ignoreTitleBarPointer(event);
    handler?.(event);
  };
}

export function DialogContent({
  className,
  children,
  title,
  description,
  onPointerDownOutside,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        onPointerDownOutside={keepOpenForTitleBar(onPointerDownOutside)}
        className={cn(
          'shadow-overlay fixed top-[calc(50%+var(--titlebar-h)/2)] left-1/2 z-[var(--z-overlay)] flex max-h-[calc(90dvh-var(--titlebar-h))] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--bg-overlay)]',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <DialogPrimitive.Title className="font-serif text-lg leading-tight font-semibold">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-[var(--fg-muted)]">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="rounded-md p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-5 flex flex-wrap items-center justify-end gap-2', className)}
      {...props}
    />
  );
}

/**
 * Right-hand drawer used for the source/evidence panel. Full-width on small
 * screens so citations stay readable on a phone.
 */
export function Drawer({
  className,
  children,
  title,
  description,
  onPointerDownOutside,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        onPointerDownOutside={keepOpenForTitleBar(onPointerDownOutside)}
        className={cn(
          'shadow-overlay fixed top-[var(--titlebar-h)] right-0 bottom-0 z-[var(--z-overlay)] flex w-full max-w-xl flex-col border-l border-[var(--border-strong)] bg-[var(--bg-overlay)]',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="font-serif text-lg leading-tight font-semibold">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-[var(--fg-muted)]">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="rounded-md p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
