import * as React from 'react';

/**
 * The TipTop brandmark, taken from the brand pack's vector artwork.
 *
 * The supplied files ship three fixed-colour variants (white, `#2B6D56`,
 * `#241B1B`). All three are the same sixteen paths with one flat fill, so
 * rather than carry three assets this draws the mark once in `currentColor`
 * and lets the theme decide — which also means it inherits the accent in dark
 * mode without a second file to keep in sync.
 *
 * Only the mark is here, not the "TipTop Ventures" wordmark: this product is
 * TipTop Copilot, and the lockup's own wordmark would say otherwise.
 */

/** The artwork's intrinsic proportions — 138.686 × 83.8148. */
const MARK_ASPECT = 138.686 / 83.8148;

export function Mark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={Math.round(size * MARK_ASPECT)}
      height={size}
      viewBox="0 0 138.686 83.8148"
      fill="none"
      className={className}
      role="img"
      aria-label="TipTop Copilot"
    >
      <path
        d="M66.2955 26.3643L42.7802 83.8142L20.8093 83.8148L47.122 19.2074H6.98452L0 0H54.6497L66.2955 26.3643Z"
        fill="currentColor"
      />
      <path
        d="M72.3906 26.3643L95.9059 83.8142L117.877 83.8148L91.564 19.2074H131.702L138.686 0H84.0363L72.3906 26.3643Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({
  className,
  showSubtitle = true,
}: {
  className?: string;
  showSubtitle?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      {/* The brand renders the mark in green on light and reversed on dark;
          --accent carries exactly that pair. */}
      <Mark className="text-[var(--accent)]" size={22} />
      <span className="flex flex-col leading-none">
        <span className="font-serif text-[15px] font-semibold tracking-tight">TipTop Copilot</span>
        {showSubtitle ? (
          <span className="mt-0.5 text-[10px] tracking-[0.14em] text-[var(--fg-subtle)] uppercase">
            Investment cockpit
          </span>
        ) : null}
      </span>
    </span>
  );
}
