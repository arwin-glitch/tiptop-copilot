import * as React from 'react';
import { cn } from '@/lib/util/cn';

/**
 * Gold line art: long leaf-blade curves that meet in points, like gold leaf set
 * into green stone. Purely decorative.
 *
 * Each line is drawn twice, a wider deep-gold stroke under a thin bright one,
 * so it reads as leaf with an edge rather than a flat yellow scratch. Still
 * cheap: one inline SVG of plain cubic paths, no filters, no raster texture,
 * no animation, and strokes stay the same width at any size
 * (`non-scaling-stroke`).
 *
 * Strength is set per zone, not per page. The layer runs at
 * `--ornament-opacity` where no text sits, and a per-variant mask in
 * globals.css (`.filigree-*`) scales it down by `--ornament-quiet` wherever a
 * line can cross text, which keeps `--fg-subtle` and `--label-gold` above
 * 4.5:1 there. It is hidden from assistive technology, ignores the pointer and
 * sits behind its parent's content (z-index -10: the parent either creates a
 * stacking context, e.g. with `isolate`, or, like the page header, leaves it
 * in the page's, behind everything in flow). Its own wrapper clips it, so the
 * parent never needs
 * `overflow-hidden` and focus rings are never cut off.
 */

/**
 * Traced in a 730 × 415 field. Each variant shows a different window of it.
 */
const PATHS = [
  'M73 0C80 60 82 110 60 160S20 230 0 252',
  'M80 92C105 140 160 190 190 245S200 330 220 415',
  'M135 178C110 210 95 260 90 310S95 380 100 415',
  'M183 0C185 30 188 60 192 92',
  'M100 125C110 85 140 40 182 8',
  'M285 0C260 30 200 55 170 100S143 165 145 188',
  'M283 0C268 80 268 160 285 240S300 350 262 415',
  'M272 160C230 195 200 235 192 270S130 360 98 415',
  'M145 345C155 370 165 390 170 415',
  'M425 150C390 200 340 260 310 312S268 370 258 415',
  'M313 312C330 345 345 380 352 415',
  'M376 0C390 80 430 150 455 200S488 300 484 415',
  'M465 225C460 160 470 100 515 0',
  'M518 0C525 80 570 160 592 225S602 330 600 415',
  'M485 320C500 280 530 235 572 185',
  'M600 280C610 220 640 160 672 105',
  'M650 0C658 50 675 100 685 150S700 230 697 268',
  'M697 268C710 258 720 250 730 240',
  'M697 268C670 285 640 320 628 360S615 400 612 415',
  'M28 218C40 260 75 300 85 340S95 400 98 415',
];

type Variant = 'sidebar' | 'login' | 'header' | 'band';

const VARIANTS: Record<
  Variant,
  { viewBox: string; preserveAspectRatio: string; wrapper: string; width: number }
> = {
  // The right-hand blades, stretched to the rail's height: tall leaves suit a
  // tall panel, and the stroke stays a hairline however far it stretches.
  sidebar: {
    viewBox: '430 0 300 415',
    preserveAspectRatio: 'none',
    wrapper: 'filigree-sidebar inset-0',
    width: 1.25,
  },
  login: {
    viewBox: '0 0 730 415',
    preserveAspectRatio: 'xMidYMid slice',
    wrapper: 'filigree-login inset-0',
    width: 1.5,
  },
  // Across the page-header band. The insets match PageShell's padding
  // (px-4 / sm:px-6, py-6) and the band's lower edge (-bottom-5), so the art
  // reaches the shell's edges and never past them: nothing here can cause a
  // sideways scroll.
  header: {
    viewBox: '0 0 730 415',
    preserveAspectRatio: 'xMidYMin slice',
    wrapper: 'filigree-header -inset-x-4 -top-6 -bottom-5 sm:-inset-x-6',
    width: 1.25,
  },
  // The sign-in band: the whole field, sliced to the band's width.
  band: {
    viewBox: '0 0 730 415',
    preserveAspectRatio: 'xMidYMax slice',
    wrapper: 'filigree-band inset-0',
    width: 1.5,
  },
};

export function GoldFiligree({ variant, className }: { variant: Variant; className?: string }) {
  const v = VARIANTS[variant];
  return (
    <span
      aria-hidden="true"
      className={cn('pointer-events-none absolute -z-10 overflow-hidden', v.wrapper, className)}
    >
      <svg
        focusable="false"
        viewBox={v.viewBox}
        preserveAspectRatio={v.preserveAspectRatio}
        fill="none"
        strokeLinecap="round"
        className="block h-full w-full opacity-[var(--ornament-opacity)]"
      >
        {/* The edge of the leaf, then its lit face. */}
        <g stroke="var(--ornament-deep)" strokeWidth={v.width + 1.25}>
          {PATHS.map((d) => (
            <path key={d} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
        <g stroke="var(--ornament-bright)" strokeWidth={v.width * 0.6}>
          {PATHS.map((d) => (
            <path key={d} d={d} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      </svg>
    </span>
  );
}
