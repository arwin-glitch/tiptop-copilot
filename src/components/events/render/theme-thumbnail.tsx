import type { CSSProperties } from 'react';
import type { ThemePreset } from '@/lib/events/contracts';
import { fontStack } from '@/lib/events/fonts';
import type { EventTheme } from '@/lib/events/schema';
import { primaryPalette, engineColors } from '@/lib/events/theme/tokens';
import { backgroundTone, posterGradient } from '@/components/events/effects/background-layer';
import { patternStyle } from '@/components/events/effects/patterns';
import './event-fonts.css';
import './theme-thumbnail.css';

/**
 * A static, script-free preview of a theme for galleries (the new-event
 * dialog, the library card's swatch, Studio's theme picker): the theme's
 * background poster, its display font, accent and highlight. Cheap enough to
 * render 33 at once; the live animated preview is the full-page
 * /e/theme_preview/<id> route or EventPage itself.
 */
export function ThemeThumbnail({
  theme,
  title,
  subtitle,
  className,
}: {
  theme: Omit<EventTheme, 'rev' | 'keyRevs'>;
  title: string;
  subtitle?: string;
  className?: string;
}) {
  const base = primaryPalette(theme as EventTheme);
  const tone = backgroundTone(theme as EventTheme, base);
  // Text follows the background the way the page's hero does.
  const p = tone === 'dark' ? theme.paletteDark : tone === 'light' ? theme.palette : base;
  const bg = theme.background;
  const colors = engineColors(theme as EventTheme, base);
  let backgroundImage: string | undefined;
  let backgroundSize: string | undefined;
  if (
    ['mesh', 'grain', 'dither', 'waves', 'smoke', 'god_rays', 'linear', 'radial', 'conic'].includes(
      bg.engine,
    )
  ) {
    backgroundImage = posterGradient(colors);
  } else if (bg.engine === 'pattern' && bg.pattern) {
    const ps = patternStyle(bg.pattern, colors[1] ?? p.text, 0.25, 14);
    backgroundImage = ps.backgroundImage;
    backgroundSize = ps.backgroundSize;
  } else if (bg.engine === 'particles') {
    backgroundImage = `radial-gradient(circle at 20% 30%, ${colors[0] ?? '#fff'} 0 1px, transparent 1.5px), radial-gradient(circle at 70% 60%, ${colors[1] ?? colors[0] ?? '#fff'} 0 1px, transparent 1.5px)`;
    backgroundSize = '23px 19px, 31px 27px';
  }
  const dark = tone === 'dark' || (tone === null && theme.mode === 'dark');
  const heroGround = bg.engine === 'pattern' ? colors[0] : undefined;
  const style = {
    '--tt-bg': heroGround ?? p.bg,
    '--tt-text': p.text,
    '--tt-accent': p.accent,
    '--tt-accent-fg': p.accentFg,
    '--tt-highlight': p.highlight,
    '--tt-display': fontStack(theme.typography.display),
    '--tt-body': fontStack(theme.typography.body),
    '--tt-weight': String(theme.typography.displayWeight),
    '--tt-case': theme.typography.displayCase === 'upper' ? 'uppercase' : 'none',
    '--tt-radius': `${Math.min(theme.shape.radius, 14)}px`,
  } as CSSProperties;
  return (
    <div
      className={`ev-theme-thumb ${className ?? ''}`}
      data-dark={dark ? 'true' : undefined}
      style={style}
    >
      <div
        className="ev-theme-thumb__bg"
        aria-hidden="true"
        style={{ backgroundImage, backgroundSize, opacity: 0.35 + 0.65 * bg.intensity }}
      />
      <div className="ev-theme-thumb__body">
        <span className="ev-theme-thumb__rule" aria-hidden="true" />
        <span className="ev-theme-thumb__title">{title}</span>
        {subtitle ? <span className="ev-theme-thumb__sub">{subtitle}</span> : null}
        <span className="ev-theme-thumb__btn" aria-hidden="true">
          RSVP
        </span>
      </div>
    </div>
  );
}

/** A preset's thumbnail, titled with its name. */
export function PresetThumbnail({
  preset,
  className,
}: {
  preset: ThemePreset;
  className?: string;
}) {
  return <ThemeThumbnail theme={preset.theme} title={preset.name} className={className} />;
}
