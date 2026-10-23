import * as React from 'react';
import {
  HELP_PAGES,
  pinNumber,
  type HelpPage,
  type HelpSection,
  type SketchBlock,
} from '@/lib/help/registry';
import { navTourId } from '@/lib/help/tour-ids';
import { cn } from '@/lib/util/cn';

/**
 * A page's mini-preview on the help card: a rough sketch of where the main
 * things sit, drawn in the theme's own tokens (so it follows light and dark),
 * with gold numbered pins matching the steps of the page's tour. Not a
 * screenshot: it never goes stale when a page's data changes, and it shows
 * only what is worth finding.
 *
 * Decorative to assistive technology: the card lists the same steps as text.
 */

const TONE: Record<SketchBlock['tone'], string> = {
  // The forest-green page-header band, in both themes, with its gold edge.
  band: 'dark bg-[var(--bg-band)] border-b border-[var(--gold-rule)]',
  title: 'rounded-full bg-[var(--fg-muted)] opacity-80',
  action: 'rounded-[3px] bg-[var(--primary)]',
  card: 'rounded-[4px] border border-[var(--border)] bg-[var(--bg-raised)] shadow-raised',
  line: 'rounded-full bg-[var(--fg-subtle)] opacity-35',
  chip: 'rounded-full border border-[var(--accent)] bg-[var(--accent-soft)]',
  tabs: 'border-b border-[var(--border-strong)] bg-[linear-gradient(90deg,var(--accent)_0_30%,transparent_30%)] bg-[length:100%_2px] bg-bottom bg-no-repeat',
  check: 'rounded-[2px] border border-[var(--border-control)] bg-[var(--bg-raised)]',
  gold: 'rounded-full bg-[var(--gold)] opacity-60',
  pane: 'rounded-[4px] border border-dashed border-[var(--border-strong)]',
};

/** The navigation's pages, top to bottom, for the little rail. */
const RAIL = HELP_PAGES.filter((p) => p.href !== null);

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

export function SketchPin({
  n,
  className,
  style,
}: {
  n: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cn(
        'tabular z-10 flex size-4 items-center justify-center rounded-full bg-[var(--gold)] text-[9px] leading-none font-bold text-[var(--bg)] ring-2 ring-[var(--bg-raised)]',
        className,
      )}
    >
      {n}
    </span>
  );
}

export function PageSketch({ page, className }: { page: HelpPage; className?: string }) {
  const navPin = page.href ? pinNumber(page, navTourId(page.href)) : 0;
  // A tab with its own tour lights the menu entry of the page it sits on.
  const lit = (page as Partial<HelpSection>).parent ?? page.id;
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative aspect-[16/9] w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]',
        className,
      )}
    >
      {/* The navigation rail, emerald in both themes like the real one, with
          this page's entry lit. */}
      <div className="dark absolute inset-y-0 left-0 flex w-[15%] flex-col gap-[2.4%] border-r border-[var(--gold-rule)] bg-[var(--bg-sidebar)] px-[2.5%] py-[5%]">
        <span className="mb-[8%] h-[4%] w-3/4 shrink-0 rounded-full bg-[var(--brand-mark)]" />
        {RAIL.map((p) => {
          const current = p.id === lit;
          return (
            <span
              key={p.id}
              className={cn(
                'relative h-[3%] shrink-0 rounded-full',
                current ? 'bg-[var(--accent)]' : 'bg-[var(--fg-subtle)] opacity-40',
              )}
            >
              {current && navPin ? (
                <SketchPin
                  n={navPin}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                />
              ) : null}
            </span>
          );
        })}
      </div>

      <div className="absolute inset-y-0 right-0 left-[15%]">
        {page.sketch.map((block, i) => (
          <span
            key={i}
            className={cn(
              'absolute',
              TONE[block.tone],
              // A title or button drawn on the band takes the band's colours.
              block.y < 3 && block.tone !== 'band' && 'dark',
            )}
            style={{
              left: pct(block.x, 24),
              top: pct(block.y, 16),
              width: pct(block.w, 24),
              height: pct(block.h, 16),
            }}
          />
        ))}
        {/* Pins after every block, as siblings: inside a faded block they
            would fade with it, and a later block would paint over them. */}
        {page.sketch.map((block, i) => {
          const n = block.pin ? pinNumber(page, block.pin) : 0;
          return n ? (
            <SketchPin
              key={`pin-${i}`}
              n={n}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: pct(block.x, 24), top: pct(block.y, 16) }}
            />
          ) : null;
        })}
      </div>
    </div>
  );
}
