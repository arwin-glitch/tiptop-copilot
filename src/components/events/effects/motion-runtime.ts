'use client';

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import type { MotionMaster } from '@/lib/events/schema';
import {
  DPR_CAP,
  liveScale,
  MAX_WEBGL_CANVASES,
  type MotionLevel,
} from '@/lib/events/theme/motion';

/**
 * The client half of the motion master, shared by every effect island:
 * the visitor's Pause choice (remembered per visitor), prefers-reduced-motion,
 * the one-WebGL-canvas slot, the DPR cap, and an in-view hook so engines stop
 * when they scroll away or the tab is hidden.
 */

export const PAUSE_STORAGE_KEY = 'tiptop-event-motion-paused';
const PAUSE_EVENT = 'tiptop-event:motion-paused';

/* ---------------------------------------------------------------- paused */

let pausedCache: boolean | null = null;

function readPaused(): boolean {
  if (pausedCache !== null) return pausedCache;
  try {
    pausedCache = window.localStorage.getItem(PAUSE_STORAGE_KEY) === '1';
  } catch {
    pausedCache = false;
  }
  return pausedCache;
}

export function setMotionPaused(paused: boolean): void {
  pausedCache = paused;
  try {
    // A display preference only (WCAG 2.2.2 pause, remembered per visitor);
    // nothing authoritative or personal is stored.
    window.localStorage.setItem(PAUSE_STORAGE_KEY, paused ? '1' : '0');
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  window.dispatchEvent(new Event(PAUSE_EVENT));
}

function subscribePaused(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === PAUSE_STORAGE_KEY) {
      pausedCache = null;
      callback();
    }
  };
  window.addEventListener(PAUSE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PAUSE_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}

export function useMotionPaused(): boolean {
  return useSyncExternalStore(subscribePaused, readPaused, () => false);
}

/* -------------------------------------------------------- reduced motion */

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function readReduced(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_QUERY).matches;
}

function subscribeReduced(callback: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

/** The motion settings an island receives from the server render. */
export interface IslandMotion {
  master: MotionMaster;
  level: MotionLevel;
  /** Studio's Full preview (overrides the OS reduced-motion setting). */
  forced: boolean;
}

/** The scale an engine runs at right now: 0 = render one still frame. */
export function useLiveMotionScale(motion: IslandMotion): number {
  const paused = useMotionPaused();
  const reduced = usePrefersReducedMotion();
  return liveScale({ ...motion, paused, reducedMotion: reduced });
}

/* ------------------------------------------------------------ visibility */

function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/** True while the element is near the viewport (engines pause offscreen). */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  rootMargin = '120px',
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (very old browsers): engines never start; posters stay.
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), {
      rootMargin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/* ----------------------------------------------------------------- WebGL */

let webglHolders = 0;
let webglSupport: boolean | null = null;

/** Whether this browser can give us a WebGL2 context (cached; the probe context is released). */
export function webglAvailable(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    webglSupport = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

/**
 * Take the page's one WebGL slot. Returns a release function, or null when
 * another engine already holds it (that island then shows its poster frame).
 */
export function claimWebGLSlot(): (() => void) | null {
  if (webglHolders >= MAX_WEBGL_CANVASES) return null;
  webglHolders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    webglHolders = Math.max(0, webglHolders - 1);
  };
}

/** devicePixelRatio, capped (phones render at 1.5× at most). */
export function cappedDpr(): number {
  return Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
}
