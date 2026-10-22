import type { CSSProperties, ReactNode } from 'react';
import '@/components/events/rsvp/ev-ui.css';
import { HEX_COLOR_RE, type EventDoc, type Palette } from '@/lib/events/schema';

/**
 * The page wrapper for the event's standalone pages (D-075): the personal
 * ticket, the cancelled page, the check-in landing and the door list. It
 * sets the theme's --ev-* tokens from the published document's palette (or
 * TipTop Signature's fallbacks), light, dark or following the device for
 * "auto". Every value is a validated 6-digit hex, so nothing a page author
 * typed can reach CSS. The event page itself is themed by WS2's EventPage.
 */

const KEYS: [keyof Palette, string][] = [
  ['bg', '--ev-bg'],
  ['surface', '--ev-surface'],
  ['surfaceAlt', '--ev-surface-alt'],
  ['text', '--ev-text'],
  ['muted', '--ev-muted'],
  ['accent', '--ev-accent'],
  ['accentFg', '--ev-accent-fg'],
  ['border', '--ev-border'],
  ['highlight', '--ev-highlight'],
];

function safePalette(p: Partial<Palette> | undefined): [string, string][] {
  if (!p) return [];
  return KEYS.flatMap(([key, prop]) => {
    const value = p[key];
    return typeof value === 'string' && HEX_COLOR_RE.test(value)
      ? [[prop, value] as [string, string]]
      : [];
  });
}

export function themeOf(doc: EventDoc | null): {
  light: [string, string][];
  dark: [string, string][];
  mode: 'light' | 'dark' | 'auto';
  radius: number | null;
} {
  const theme = doc?.theme;
  return {
    light: safePalette(theme?.palette),
    dark: safePalette(theme?.paletteDark),
    mode: theme?.mode ?? 'light',
    radius:
      typeof theme?.shape.radius === 'number'
        ? Math.max(0, Math.min(32, theme.shape.radius))
        : null,
  };
}

export function EventShell({
  doc,
  children,
  label,
}: {
  doc: EventDoc | null;
  children: ReactNode;
  /** The landmark's name for screen readers. */
  label: string;
}) {
  const t = themeOf(doc);
  const base = t.mode === 'dark' ? t.dark : t.light;
  const style: Record<string, string> = Object.fromEntries(base);
  if (t.radius !== null) style['--ev-radius'] = `${t.radius}px`;
  const darkCss =
    t.mode === 'auto' && t.dark.length
      ? `@media (prefers-color-scheme: dark){[data-ev-shell='auto']{${t.dark.map(([k, v]) => `${k}:${v}`).join(';')}}}`
      : null;
  return (
    <main
      id="main"
      data-ev-shell={t.mode === 'auto' ? 'auto' : 'fixed'}
      data-ev-ui
      aria-label={label}
      style={style as CSSProperties}
    >
      {darkCss ? <style>{darkCss}</style> : null}
      <div className="evu-shell-inner">{children}</div>
    </main>
  );
}
