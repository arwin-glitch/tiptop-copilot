import type { CSSProperties } from 'react';
import type { EventTheme, Palette } from '@/lib/events/schema';
import { isHex, mix } from '@/lib/events/theme/color';
import { luminance } from '@/lib/events/theme/contrast';
import { boolOption, numOption } from '@/lib/events/theme/effects';
import { engineColors } from '@/lib/events/theme/tokens';
import type { RenderContext } from '@/components/events/render/context';
import { EvImage, EvVideo } from '@/components/events/render/media';
import type { IslandMotion } from './motion-runtime';
import { ParticlesIsland } from './particles-island';
import { patternStyle } from './patterns';
import { ShaderIsland } from './shader-island';

/**
 * The background engine (theme.background), server-rendered.
 *
 * Every engine renders a static CSS layer first: the real look for CSS
 * engines (gradients, conic, patterns), and a POSTER for the WebGL and canvas
 * engines (layered radial gradients in the same colours). Animated engines
 * then mount a lazy client island on top that fades in when ready. So the
 * first paint, the OG capture, no-JS, no-WebGL and reduced motion all show a
 * finished design, and nothing waits on JavaScript.
 */

const SHADER_ENGINES = new Set(['mesh', 'grain', 'dither', 'waves', 'smoke', 'god_rays']);

const POSTER_POSITIONS = ['18% 22%', '82% 18%', '72% 82%', '22% 78%', '50% 45%', '92% 60%'];

/** A CSS stand-in for a mesh/grain/smoke shader: soft radial pools of each colour. */
export function posterGradient(colors: readonly string[]): string {
  const valid = colors.filter((c) => isHex(c));
  const base = valid[0] ?? '#000000';
  const pools = valid
    .slice(1)
    .map(
      (c, i) =>
        `radial-gradient(ellipse at ${POSTER_POSITIONS[i % POSTER_POSITIONS.length]}, ${c} 0%, transparent 58%)`,
    );
  return [
    ...pools,
    `linear-gradient(160deg, ${base}, ${mix(base, valid.at(-1) ?? base, 0.35)})`,
  ].join(', ');
}

/** Whether text over this background needs the dark palette, the light one, or a veil. */
export function backgroundTone(theme: EventTheme, palette: Palette): 'dark' | 'light' | null {
  const bg = theme.background;
  if (bg.engine === 'image' || bg.engine === 'video') return 'dark';
  if (bg.engine === 'solid') return null;
  const colors = engineColors(theme, palette);
  if (bg.engine === 'pattern') {
    // A hero pattern paints its ground (the first colour); a page pattern sits on the page.
    const ground = colors[0];
    if (bg.scope !== 'hero' || !ground) return null;
    const l = luminance(ground);
    return l < 0.25 ? 'dark' : l > 0.6 ? 'light' : null;
  }
  if (bg.engine === 'particles') {
    // Particle fields sit on their first colour when it is a ground, else on the page.
    const ground = colors[0];
    return ground && luminance(ground) < 0.2 ? 'dark' : null;
  }
  const avg = colors.reduce((sum, c) => sum + luminance(c), 0) / Math.max(1, colors.length);
  return avg < 0.3 ? 'dark' : 'light';
}

function linearCss(theme: EventTheme, colors: string[]): string {
  const angle = theme.gradient ? Math.round(theme.gradient.angle) : 180;
  return `linear-gradient(${angle}deg, ${colors.join(', ')})`;
}

function radialCss(theme: EventTheme, colors: string[]): string {
  const x = Math.round(numOption(theme.background.options, 'x', 0.5) * 100);
  const y = Math.round(numOption(theme.background.options, 'y', 0.35) * 100);
  const stops = colors.map(
    (c, i) => `${c} ${Math.round((i / Math.max(1, colors.length - 1)) * 100)}%`,
  );
  return `radial-gradient(ellipse 120% 90% at ${x}% ${y}%, ${stops.join(', ')})`;
}

function conicCss(colors: string[]): string {
  return `conic-gradient(from var(--ev-conic-angle, 0deg) at 50% 50%, ${[...colors, colors[0] ?? '#000000'].join(', ')})`;
}

export interface BackgroundLayerProps {
  theme: EventTheme;
  ctx: RenderContext;
  /** Where this layer sits: behind the hero section or behind the whole page. */
  scope: 'hero' | 'page';
  islandMotion: IslandMotion;
}

export function BackgroundLayer({ theme, ctx, scope, islandMotion }: BackgroundLayerProps) {
  const bg = theme.background;
  if (bg.engine === 'solid') return null;
  const palette = theme.mode === 'dark' ? theme.paletteDark : theme.palette;
  const colors = engineColors(theme, palette);
  const intensity = Math.max(0.15, Math.min(1, bg.intensity));
  const animate = ctx.motion === 'full' && ctx.mode !== 'og';
  const veil = numOption(bg.options, 'veil', 0);
  const layerStyle: CSSProperties = { opacity: 0.35 + 0.65 * intensity };
  const speedVar = { '--ev-bg-speed': String(Math.max(0.05, bg.speed)) } as CSSProperties;

  let content: React.ReactNode = null;
  if (bg.engine === 'linear') {
    content = (
      <div
        className="ev-bg__fill"
        style={{ ...layerStyle, backgroundImage: linearCss(theme, colors) }}
      />
    );
  } else if (bg.engine === 'radial') {
    content = (
      <div
        className="ev-bg__fill"
        data-breath={boolOption(bg.options, 'breath') ? 'true' : undefined}
        data-flicker={boolOption(bg.options, 'flicker') ? 'true' : undefined}
        style={{ ...layerStyle, ...speedVar, backgroundImage: radialCss(theme, colors) }}
      />
    );
  } else if (bg.engine === 'conic') {
    content = (
      <div
        className="ev-bg__fill ev-bg__conic"
        data-animate={animate ? 'true' : undefined}
        style={{ ...layerStyle, ...speedVar, backgroundImage: conicCss(colors) }}
      />
    );
  } else if (bg.engine === 'pattern' && bg.pattern) {
    const fg = colors[1] ?? palette.text;
    const ground = colors[0] ?? palette.bg;
    const opacity = numOption(bg.options, 'lineOpacity', 0.12);
    const size = numOption(bg.options, 'size', 24) * bg.scale;
    const animated = animate && boolOption(bg.options, 'animate');
    if (bg.pattern === 'synth_grid') {
      content = (
        <div
          className="ev-synth"
          data-animate={animated ? 'true' : undefined}
          style={
            {
              ...speedVar,
              backgroundColor: ground,
              '--ev-synth-line': fg,
              '--ev-synth-sun-a': colors[2] ?? fg,
              '--ev-synth-sun-b': fg,
            } as CSSProperties
          }
        >
          <div className="ev-synth__sun" />
          <div className="ev-synth__floor">
            <div className="ev-synth__grid" />
          </div>
        </div>
      );
    } else {
      const ps = patternStyle(bg.pattern, fg, opacity, size);
      content = (
        <div
          className="ev-bg__pattern-wrap"
          style={{ backgroundColor: scope === 'hero' ? ground : undefined }}
        >
          {bg.pattern === 'sunburst' ? (
            <div
              className="ev-bg__fill"
              style={{
                backgroundImage: `radial-gradient(circle at 50% 50%, ${mix(ground, colors[2] ?? fg, 0.28)} 0%, ${ground} 62%)`,
              }}
            />
          ) : null}
          <div
            className="ev-bg__pattern"
            data-pattern={bg.pattern}
            data-animate={animated ? 'true' : undefined}
            style={{ ...speedVar, ...ps }}
          />
        </div>
      );
    }
  } else if (bg.engine === 'particles' && bg.particles) {
    // Leading dark colours are the ground the particles fall over (Winter
    // Lodge's pine band); the rest are the particles. With no ground the
    // page's own background shows, tinted by the theme gradient (a nebula).
    const groundCount = Math.min(
      2,
      colors.findIndex((c) => luminance(c) >= 0.12) === -1
        ? 0
        : colors.findIndex((c) => luminance(c) >= 0.12),
    );
    const ground = groundCount > 0 ? colors.slice(0, groundCount) : null;
    const dots = colors.slice(groundCount);
    const nebula = !ground && theme.gradient ? theme.gradient.stops : null;
    content = (
      <>
        {ground ? (
          <div
            className="ev-bg__fill"
            style={{
              backgroundImage: `linear-gradient(180deg, ${ground[0]}, ${ground[1] ?? ground[0]})`,
            }}
          />
        ) : null}
        {nebula ? (
          <div
            className="ev-bg__fill"
            style={{
              opacity: 0.55,
              backgroundImage: nebula
                .map(
                  (c, i) =>
                    `radial-gradient(ellipse 60% 45% at ${POSTER_POSITIONS[i % POSTER_POSITIONS.length]}, ${c}55 0%, transparent 70%)`,
                )
                .join(', '),
            }}
          />
        ) : null}
        {ctx.mode === 'og' ? null : (
          <ParticlesIsland
            kind={bg.particles}
            colors={dots.length ? dots : ['#FFFFFF']}
            density={bg.intensity}
            speed={bg.speed}
            depth={numOption(bg.options, 'depth', 0.5)}
            shootingStars={boolOption(bg.options, 'shootingStars')}
            twinkle={boolOption(bg.options, 'twinkle', true)}
            cursorReactive={bg.cursorReactive}
            overlay={false}
            motion={islandMotion}
          />
        )}
      </>
    );
  } else if (SHADER_ENGINES.has(bg.engine)) {
    content = (
      <>
        <div
          className="ev-bg__fill ev-bg__poster"
          data-engine={bg.engine}
          style={{ ...layerStyle, backgroundImage: posterGradient(colors) }}
        />
        {ctx.mode === 'og' || ctx.motion === 'off' ? null : (
          <div className="ev-bg__fill" style={layerStyle}>
            <ShaderIsland
              engine={bg.engine as 'mesh'}
              colors={colors}
              options={bg.options}
              speed={bg.speed}
              scale={bg.scale}
              motion={islandMotion}
            />
          </div>
        )}
      </>
    );
  } else if (bg.engine === 'image' && bg.image) {
    const img = bg.image;
    content = (
      <>
        <div
          className="ev-bg__media"
          data-ken-burns={img.kenBurns && animate ? 'true' : undefined}
          data-parallax={img.parallax && animate ? 'true' : undefined}
          data-filter={img.filter}
          style={{ filter: img.blur ? `blur(${Math.round(img.blur)}px)` : undefined }}
        >
          <EvImage
            ctx={ctx}
            media={img.media}
            priority={scope === 'hero'}
            decorative
            sizes="100vw"
          />
        </div>
        <div className="ev-bg__scrim" style={{ opacity: Math.max(0.15, img.scrim) }} />
      </>
    );
  } else if (bg.engine === 'video' && bg.video) {
    content = (
      <>
        <div className="ev-bg__media">
          <EvVideo ctx={ctx} media={bg.video.media} poster={bg.video.poster} />
        </div>
        <div className="ev-bg__scrim" style={{ opacity: 0.45 }} />
      </>
    );
  }
  if (!content) return null;
  return (
    <div className={`ev-bg ev-bg--${scope}`} data-engine={bg.engine} aria-hidden="true">
      <div className="ev-bg__inner">
        {content}
        {veil > 0 ? (
          <div className="ev-bg__veil" style={{ opacity: Math.min(0.85, veil) }} />
        ) : null}
      </div>
    </div>
  );
}
