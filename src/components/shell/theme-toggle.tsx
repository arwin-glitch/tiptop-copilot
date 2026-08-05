'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/util/cn';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'tiptop-theme';

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * localStorage is the source of truth for the theme, so it is read through
 * `useSyncExternalStore` rather than copied into state by an effect. The
 * server snapshot is `system`, which matches what the pre-paint bootstrap
 * script in `layout.tsx` assumes when no preference is stored.
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changing the preference should move this control too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function serverTheme(): Theme {
  return 'system';
}

/**
 * Display preference only. It lives in localStorage because losing it is
 * harmless and it must be readable before first paint — no application state
 * is stored client-side.
 */
export function ThemeToggle() {
  const theme = React.useSyncExternalStore(subscribe, readTheme, serverTheme);

  const apply = React.useCallback((next: Theme) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = next === 'dark' || (next === 'system' && prefersDark);
    document.documentElement.classList.toggle('dark', dark);
    try {
      if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked storage API costs the preference, not the theme change.
    }
    emit();
  }, []);

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex rounded-md border border-[var(--border)] p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => apply(value)}
          className={cn(
            'rounded p-1.5 transition-colors',
            theme === value
              ? 'bg-[var(--bg-hover)] text-[var(--fg)]'
              : 'text-[var(--fg-subtle)] hover:text-[var(--fg)]',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
