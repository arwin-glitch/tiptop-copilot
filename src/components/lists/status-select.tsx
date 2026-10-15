'use client';

import * as React from 'react';
import { cn } from '@/lib/util/cn';

/**
 * The status control on a table row, a board card and the side panel.
 *
 * A native select, as everywhere else in the app: keyboard- and screen-reader-
 * correct for free and the platform picker on a phone. Compact, because on a
 * row it sits among values rather than in a form. A value an import left that
 * is not one of the options is kept as an option, so the control shows what
 * is stored instead of silently displaying something else.
 */
export function StatusSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  /** Accessible name, e.g. "Status for Cobaltline". */
  label: string;
  value: string | null;
  options: readonly string[];
  onChange: (next: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = value ?? '';
  const choices = current && !options.includes(current) ? [current, ...options] : options;
  return (
    <select
      aria-label={label}
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'h-7 max-w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-raised)] pr-6 pl-2 text-xs text-[var(--fg)] hover:border-[var(--border-strong)] disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      <option value="">No status</option>
      {choices.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
