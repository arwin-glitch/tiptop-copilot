'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParticleConfig, ParticleField, ParticleKind } from './particle-engine';
import {
  motionAllowedNow,
  useInView,
  useLiveMotionScale,
  usePageVisible,
  type IslandMotion,
} from './motion-runtime';

/**
 * A canvas-2D particle field (background stars/snow/… or an overlay of
 * confetti/petals/a custom emoji rain). Loads the engine lazily when near
 * the viewport; stops offscreen, on a hidden tab, on Pause and for reduced
 * motion. A background keeps one still frame then; an overlay disappears
 * (overlays are decoration, and reduced motion hides them).
 */
export function ParticlesIsland({
  kind,
  colors,
  density,
  speed,
  depth,
  shootingStars,
  twinkle,
  burst,
  spriteUrl,
  sizeScale,
  cursorReactive,
  overlay,
  motion,
}: {
  kind: ParticleKind;
  colors: string[];
  density: number;
  speed: number;
  depth?: number;
  shootingStars?: boolean;
  twinkle?: boolean;
  burst?: boolean;
  spriteUrl?: string | null;
  sizeScale?: number;
  cursorReactive?: boolean;
  overlay: boolean;
  motion: IslandMotion;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<ParticleField | null>(null);
  const inView = useInView(canvasRef, '100px');
  const visible = usePageVisible();
  const scale = useLiveMotionScale(motion);
  const [loaded, setLoaded] = useState(false);
  const hidden = overlay && scale === 0;

  useEffect(() => {
    if (hidden || motion.level === 'off' || fieldRef.current || !inView) return;
    // An overlay is decoration: under reduced motion or Pause it never loads.
    if (overlay && !motionAllowedNow(motion)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let sprite: HTMLImageElement | null = null;
    if (kind === 'custom' && spriteUrl) {
      sprite = new Image();
      sprite.decoding = 'async';
      sprite.src = spriteUrl;
    }
    void import('./particle-engine').then(({ createParticleField }) => {
      if (cancelled || !canvasRef.current) return;
      const config: ParticleConfig = {
        kind,
        colors,
        density,
        speed,
        scale,
        depth,
        shootingStars,
        twinkle,
        burst,
        sprite,
        sizeScale,
      };
      fieldRef.current = createParticleField(canvasRef.current, config);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // The field is created once; later changes go through setScale/setRunning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, hidden, motion.level]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.setScale(scale);
    field.setRunning(inView && visible && scale > 0);
  }, [loaded, scale, inView, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fieldRef.current?.resize());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!cursorReactive || !loaded) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const onMove = (e: PointerEvent) => {
      fieldRef.current?.setPointer(
        e.clientX / window.innerWidth - 0.5,
        e.clientY / window.innerHeight - 0.5,
      );
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [cursorReactive, loaded]);

  useEffect(() => () => fieldRef.current?.destroy(), []);

  if (hidden) return null;
  return (
    <canvas
      ref={canvasRef}
      className={overlay ? 'ev-particles ev-particles--overlay' : 'ev-particles'}
      aria-hidden="true"
    />
  );
}
