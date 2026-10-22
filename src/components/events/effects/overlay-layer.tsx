import type { CSSProperties } from 'react';
import type { EventTheme } from '@/lib/events/schema';
import { isHex } from '@/lib/events/theme/color';
import { boolOption, numOption } from '@/lib/events/theme/effects';
import type { RenderContext } from '@/components/events/render/context';
import { resolveMediaRef } from '@/components/events/render/media';
import type { IslandMotion } from './motion-runtime';
import type { ParticleKind } from './particle-engine';
import { ParticlesIsland } from './particles-island';

/**
 * The overlay effect layer (separate from the background, Partiful's Theme +
 * Effect split): confetti, gold dust, petals, leaves, snow, fireflies,
 * bubbles, golf balls, shooting stars, a custom emoji/logo rain (canvas), or
 * smoke wisps and sunbeams (pure CSS). Pointer-transparent; hidden for
 * reduced motion, Pause and master Off; never in the OG card.
 */

const CANVAS_KINDS: Partial<Record<EventTheme['overlay']['kind'], ParticleKind>> = {
  confetti: 'confetti',
  gold_dust: 'gold_dust',
  petals: 'petals',
  leaves: 'leaves',
  snow: 'snow',
  fireflies: 'fireflies',
  bubbles: 'bubbles',
  golf_balls: 'golf_balls',
  shooting_stars: 'shooting_stars',
  custom: 'custom',
};

export function OverlayLayer({
  theme,
  ctx,
  area,
  islandMotion,
}: {
  theme: EventTheme;
  ctx: RenderContext;
  area: 'hero' | 'page';
  islandMotion: IslandMotion;
}) {
  const ov = theme.overlay;
  if (ov.kind === 'none' || ov.area !== area) return null;
  if (ctx.mode === 'og' || ctx.motion !== 'full') return null;
  const colors = ov.colors.filter((c) => isHex(c));
  const style = {
    '--ev-ov-speed': String(Math.max(0.1, ov.speed)),
    '--ev-ov-color': colors[0] ?? '#FFFFFF',
  } as CSSProperties;

  if (ov.kind === 'smoke' || ov.kind === 'sunbeams') {
    const count = Math.max(2, Math.round(2 + ov.density * 4));
    return (
      <div
        className={`ev-overlay ev-overlay--${area}`}
        data-overlay={ov.kind}
        style={style}
        aria-hidden="true"
      >
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className="ev-overlay__wisp"
            style={{ '--i': String(i) } as CSSProperties}
          />
        ))}
      </div>
    );
  }
  const kind = CANVAS_KINDS[ov.kind];
  if (!kind) return null;
  const sprite = ov.kind === 'custom' ? resolveMediaRef(ctx, ov.custom ?? null) : null;
  if (ov.kind === 'custom' && !sprite?.src) return null;
  return (
    <div className={`ev-overlay ev-overlay--${area}`} data-overlay={ov.kind} aria-hidden="true">
      <ParticlesIsland
        kind={kind}
        colors={colors.length ? colors : ['#FFFFFF']}
        density={ov.density}
        speed={ov.speed}
        burst={ov.mode === 'burst'}
        spriteUrl={sprite?.src ?? null}
        sizeScale={numOption(ov.options, 'sizeScale', 1)}
        twinkle={boolOption(ov.options, 'glow', true)}
        overlay
        motion={islandMotion}
      />
    </div>
  );
}
