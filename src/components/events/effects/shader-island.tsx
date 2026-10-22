'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { DPR_CAP } from '@/lib/events/theme/motion';
import {
  claimWebGLSlot,
  motionAllowedNow,
  useInView,
  useLiveMotionScale,
  webglAvailable,
  type IslandMotion,
} from './motion-runtime';
import type { ShaderEngine, ShaderProps } from './shaders/common';

/** One module per engine: a page downloads only the shader its theme uses. */
const ENGINES: Record<ShaderEngine, () => Promise<{ default: ComponentType<ShaderProps> }>> = {
  mesh: () => import('./shaders/mesh'),
  grain: () => import('./shaders/grain'),
  dither: () => import('./shaders/dither'),
  waves: () => import('./shaders/waves'),
  smoke: () => import('./shaders/smoke'),
  god_rays: () => import('./shaders/god-rays'),
};

/**
 * The WebGL background island. Rules (D-075 phone budget):
 *   - ONE WebGL canvas per page: the island takes the page's single slot or
 *     renders nothing (the server-rendered poster underneath stays);
 *   - loads Paper only when the hero is near the viewport;
 *   - DPR capped at 1.5 (a pixel budget of width × height × 1.5²);
 *   - pauses offscreen and while the tab is hidden (Paper's own observer),
 *     and renders one still frame for reduced motion, Pause or master Off;
 *   - no WebGL (old phones, context refused): the poster is the page.
 */
export function ShaderIsland({
  engine,
  colors,
  options,
  speed,
  scale,
  motion,
}: {
  engine: ShaderEngine;
  colors: string[];
  options: Record<string, unknown>;
  speed: number;
  scale: number;
  motion: IslandMotion;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const inView = useInView(hostRef, '200px');
  const live = useLiveMotionScale(motion);
  const [View, setView] = useState<ComponentType<ShaderProps> | null>(null);
  const [seen, setSeen] = useState(false);
  const [pixels, setPixels] = useState(0);
  const [ready, setReady] = useState(false);

  // Latch the first time the hero comes near: the canvas then stays (a WebGL
  // context is expensive to recreate; Paper pauses it offscreen itself).
  if (inView && !seen) setSeen(true);

  // Reduced motion, Pause and master Off keep the server's poster frame and
  // never download the engine; it loads the first time motion actually runs
  // (checked against the browser itself, not the hydration snapshot).
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (go || !seen || !motionAllowedNow(motion)) return;
    const frame = window.requestAnimationFrame(() => setGo(true));
    return () => window.cancelAnimationFrame(frame);
  }, [go, seen, motion, live]);

  // Take the page's one WebGL slot and load the engine.
  useEffect(() => {
    if (!go || !webglAvailable()) return;
    const release = claimWebGLSlot();
    if (!release) return;
    let cancelled = false;
    void ENGINES[engine]().then((mod) => {
      if (!cancelled) setView(() => mod.default);
    });
    return () => {
      cancelled = true;
      release();
      setView(null);
    };
  }, [go, engine]);

  // The DPR cap as a pixel budget, kept in step with the host's size.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setPixels(Math.max(1, Math.round(rect.width * rect.height * DPR_CAP * DPR_CAP)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!View) return;
    const id = window.setTimeout(() => setReady(true), 60);
    return () => {
      window.clearTimeout(id);
      setReady(false);
    };
  }, [View]);

  return (
    <div
      ref={hostRef}
      className="ev-shader"
      data-ready={ready ? 'true' : undefined}
      aria-hidden="true"
    >
      {View && pixels > 0 ? (
        <View
          colors={colors}
          options={options}
          speed={live > 0 ? Math.max(0.02, speed * live) : 0}
          scale={scale}
          maxPixelCount={pixels}
        />
      ) : null}
    </div>
  );
}
