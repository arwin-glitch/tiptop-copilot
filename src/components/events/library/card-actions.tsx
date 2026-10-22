'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'sonner';
import { Archive, Copy, CopyPlus, EyeOff, Link2, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { eventsApi } from '@/components/events/events-client';
import type { EventStatus } from '@/lib/types/domain';

const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--bg-hover)]';

/** Copy the public link: copilot.tiptop.vc/e/<slug>. */
export function CopyLinkButton({
  slug,
  live,
  size = 'sm',
  variant = 'ghost',
  label = 'Copy link',
}: {
  slug: string;
  /** Whether the page is published; a draft's link opens nothing yet. */
  live: boolean;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
  label?: string;
}) {
  const copy = async () => {
    const url = `${window.location.origin}/e/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(live ? 'Link copied.' : 'Link copied. It opens once the page is published.');
    } catch {
      toast.error(`Could not copy. The link is ${url}`);
    }
  };
  return (
    <Button type="button" size={size} variant={variant} onClick={copy}>
      <Link2 aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * A card's quick actions: duplicate, and the ⋯ menu with duplicate as next
 * year, save as template, unpublish, archive and delete draft. Each goes
 * through the events API (WS1's routes); anything destructive asks first.
 */
export function EventCardActions({
  eventId,
  title,
  status,
  isTemplate,
}: {
  eventId: string;
  title: string;
  status: EventStatus;
  isTemplate: boolean;
}) {
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = React.useState(false);

  const run = async (
    work: () => ReturnType<typeof eventsApi.unpublish>,
    done: string,
    open?: (data: Record<string, unknown>) => string | null,
  ) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(done);
    const next = open?.(result.data as Record<string, unknown>);
    if (next) router.push(next);
    else router.refresh();
  };

  const duplicate = (shiftDays: number, asTemplate = false) =>
    run(
      () => eventsApi.duplicate(eventId, { shiftDays, ...(asTemplate ? { asTemplate } : {}) }),
      asTemplate
        ? 'Saved as a template.'
        : shiftDays
          ? 'Duplicated as next year’s draft, dates moved a year on.'
          : 'Duplicated as a new draft.',
      (data) => (typeof data.id === 'string' ? `/events/${encodeURIComponent(data.id)}` : null),
    );

  const unpublish = async () => {
    if (
      !(await confirm({
        title: `Unpublish ${title}?`,
        description:
          'The public link stops working until you publish again. Every guest and answer is kept.',
        confirmLabel: 'Unpublish',
        tone: 'danger',
      }))
    )
      return;
    await run(() => eventsApi.unpublish(eventId), 'Unpublished. The link is off; guests are kept.');
  };

  const archive = async () => {
    if (
      !(await confirm({
        title: `Archive ${title}?`,
        description: 'It moves to Past. Guests, messages and the page are kept.',
        confirmLabel: 'Archive',
      }))
    )
      return;
    await run(() => eventsApi.archive(eventId), 'Archived.');
  };

  const removeDraft = async () => {
    if (
      !(await confirm({
        title: `Delete the draft ${title}?`,
        description: 'The draft and its page are deleted for good. This cannot be undone.',
        confirmLabel: 'Delete draft',
        tone: 'danger',
      }))
    )
      return;
    await run(() => eventsApi.remove(eventId), 'Draft deleted.');
  };

  return (
    <>
      <Button type="button" size="sm" variant="ghost" loading={busy} onClick={() => duplicate(0)}>
        {busy ? null : <Copy aria-hidden="true" />}
        Duplicate
      </Button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button type="button" size="sm" variant="ghost" aria-label={`More for ${title}`}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="shadow-overlay z-[var(--z-overlay)] w-60 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
          >
            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void duplicate(364)}>
              <CopyPlus className="size-4" aria-hidden="true" />
              Duplicate as next year
            </DropdownMenu.Item>
            {!isTemplate ? (
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void duplicate(0, true)}>
                <Copy className="size-4" aria-hidden="true" />
                Save as template
              </DropdownMenu.Item>
            ) : null}
            {status === 'published' ? (
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void unpublish()}>
                <EyeOff className="size-4" aria-hidden="true" />
                Unpublish
              </DropdownMenu.Item>
            ) : null}
            {status !== 'draft' && status !== 'archived' ? (
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void archive()}>
                <Archive className="size-4" aria-hidden="true" />
                Archive
              </DropdownMenu.Item>
            ) : null}
            {status === 'draft' ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                <DropdownMenu.Item
                  className={`${MENU_ITEM} text-[var(--danger)]`}
                  onSelect={() => void removeDraft()}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete draft
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {confirmDialog}
    </>
  );
}
