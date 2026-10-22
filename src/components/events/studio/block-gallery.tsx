'use client';

import * as React from 'react';
import { blockRegistry } from '@/lib/events/blocks';
import type { BlockDefinition } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';
import { BLOCK_VARIANTS, type BlockType } from '@/lib/events/schema';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';
import { useStudio } from './studio-context';

/** Blocks that are "v1 nice": offered once the registry describes them. */
const LATER_BLOCKS: readonly BlockType[] = ['embed', 'guest_wall', 'join_remote', 'info_cards'];

function variantName(variant: string): string {
  const words = variant.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "+ Add section": every block with its layout variants. A new section
 * takes the block's defaults (WS2's registry): empty media slots show "Add
 * photo", never placeholder text. It lands after the section it was opened
 * from, or at the top.
 */
export function BlockGallery() {
  const studio = useStudio();
  const open = studio.galleryAfter !== undefined;
  const [query, setQuery] = React.useState('');
  const blocks = blockRegistry
    .list()
    .filter((b) => !LATER_BLOCKS.includes(b.type) || b.fields.length > 0)
    .filter((b) =>
      query.trim()
        ? `${b.label} ${b.description} ${b.type}`.toLowerCase().includes(query.trim().toLowerCase())
        : true,
    );
  const afterLabel = (() => {
    const id = studio.galleryAfter;
    if (!id) return 'at the top';
    const section = studio.doc.sections.find((s) => s.id === id);
    return section ? `after ${studio.labelOf(section)}` : 'at the end';
  })();

  function add(block: BlockDefinition, variant?: string) {
    const defaults = block.defaults();
    const template = sectionTemplate(
      block.type,
      structuredClone(defaults.props),
      variant ?? defaults.variant,
    );
    const id = studio.insertSection(template, studio.galleryAfter ?? null);
    studio.closeGallery();
    setQuery('');
    if (id) studio.select(id);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          studio.closeGallery();
          setQuery('');
        }
      }}
    >
      {open ? (
        <DialogContent
          title="Add a section"
          description={`Pick a block and a layout. It goes ${afterLabel}.`}
          className="max-w-2xl"
        >
          <label className="sr-only" htmlFor="block-search">
            Search blocks
          </label>
          <Input
            id="block-search"
            placeholder="Search blocks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul aria-label="Blocks" className="mt-3 grid gap-2 sm:grid-cols-2">
            {blocks.map((block) => (
              <li
                key={block.type}
                className="rounded-[var(--radius-card)] border border-[var(--border)] p-3"
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => add(block)}
                  aria-label={`Add ${block.label}`}
                >
                  <span className="block text-sm font-semibold">{block.label}</span>
                  {block.description ? (
                    <span className="mt-0.5 block text-xs text-[var(--fg-muted)]">
                      {block.description}
                    </span>
                  ) : null}
                </button>
                {(BLOCK_VARIANTS[block.type] as readonly string[]).length > 1 ? (
                  <div className="mt-2 flex flex-wrap gap-1" aria-label={`${block.label} layouts`}>
                    {(block.variants as readonly string[]).map((variant) => (
                      <button
                        key={variant}
                        type="button"
                        className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
                        onClick={() => add(block, variant)}
                        aria-label={`Add ${block.label}, ${variantName(variant)} layout`}
                      >
                        {variantName(variant)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
