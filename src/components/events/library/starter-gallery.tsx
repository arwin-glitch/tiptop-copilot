'use client';

import * as React from 'react';
import { NewEventDialog } from '@/components/events/new-event-dialog';
import type { StarterCard, ThemeCard } from '@/components/events/library/gallery-data';

/**
 * The library with no events yet: the starters themselves, each one tap from
 * a new draft (the dialog opens on the theme step with that starter picked).
 */
export function StarterGallery({
  starters,
  themes,
  timeZone,
}: {
  starters: StarterCard[];
  themes: ThemeCard[];
  timeZone: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [starterId, setStarterId] = React.useState<string | null>(null);
  return (
    <section
      aria-labelledby="starter-gallery-heading"
      data-tour="events-library"
      className="rounded-[var(--radius-panel)] border border-dashed border-[var(--border-strong)] p-4 sm:p-6"
    >
      <h2 id="starter-gallery-heading" className="font-serif text-xl font-semibold">
        No events yet. Start from a starter
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--fg-muted)]">
        Each starter is a ready set of sections. Pick one, choose a theme, name it: it stays a
        private draft until you publish it.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {starters.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => {
                setStarterId(s.id);
                setOpen(true);
              }}
              className="h-full w-full rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
            >
              <span className="block font-serif text-base font-semibold">{s.name}</span>
              <span className="mt-1 block text-sm text-[var(--fg-muted)]">{s.description}</span>
              <span className="mt-2 block text-xs text-[var(--fg-subtle)]">
                {s.sections.join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NewEventDialog
        starters={starters}
        themes={themes}
        timeZone={timeZone}
        open={open}
        onOpenChange={setOpen}
        initialStarterId={starterId}
        showTrigger={false}
      />
    </section>
  );
}
