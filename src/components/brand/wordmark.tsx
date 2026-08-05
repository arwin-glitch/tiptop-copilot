import * as React from 'react';

/**
 * Original product mark: two stacked bars whose upper bar is offset to the
 * right — "tip" and "top" — inside a rounded square. Pure geometry, no external
 * asset, no licensed font, and it stays legible at 16px in a browser tab.
 */
export function Mark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="TipTop Copilot"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect x="12" y="8" width="14" height="4.5" rx="2.25" fill="var(--bg-raised, #fff)" />
      <rect x="6" y="19.5" width="14" height="4.5" rx="2.25" fill="var(--bg-raised, #fff)" />
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
      <Mark className="text-[var(--fg)]" size={26} />
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
