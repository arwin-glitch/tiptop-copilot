import type { MotionPreview } from '@/lib/events/contracts';
import type { EventTheme, MotionMaster } from '@/lib/events/schema';

/**
 * The motion master (D-075): one Off / Subtle / Lively / Party control that
 * scales every effect, entrance and parallax on the page.
 *
 * Three inputs decide what a viewer gets, strictest wins:
 *   1. the theme's master (Off disables everything);
 *   2. the viewer: prefers-reduced-motion (CSS media query + matchMedia in
 *      the islands) and the visible Pause control (remembered per visitor);
 *   3. Studio's preview switch (full / reduced / off), which may force FULL
 *      so a host with reduced motion on can still see what guests see.
 *
 * Accessibility caps that hold whatever the master says: entrances are
 * capped near 600 ms, nothing flashes more than 3 times a second, and no
 * content waits for an animation to finish.
 */

/**
 * The master's multipliers (schema.ts MOTION_SCALE; a unit test holds the two
 * together). Kept here as a plain constant so client islands never pull the
 * zod schema into the guest page's JavaScript.
 */
const SCALE: Record<MotionMaster, number> = { off: 0, subtle: 0.4, lively: 0.75, party: 1 };

/** Where the page renders motion: 'full' (scaled by the master), 'reduced' (static frames), 'off'. */
export type MotionLevel = 'full' | 'reduced' | 'off';

/** The longest an entrance may take, in ms, at any master. */
export const ENTRANCE_CAP_MS = 600;
/** Flashes per second never exceed this (neon flicker, sparkle). */
export const MAX_FLASHES_PER_SECOND = 3;
/** Canvas and WebGL never render above this device pixel ratio. */
export const DPR_CAP = 1.5;
/** One WebGL canvas per page, ever. */
export const MAX_WEBGL_CANVASES = 1;

/** The master's multiplier: off 0, subtle 0.4, lively 0.75, party 1. */
export function motionScale(master: MotionMaster): number {
  return SCALE[master];
}

/**
 * The level the server renders. `preview` is Studio's switch (absent on the
 * live page, which leaves reduced-motion to the browser).
 */
export function motionLevel(theme: EventTheme, preview?: MotionPreview): MotionLevel {
  if (theme.motion.master === 'off' || preview === 'off') return 'off';
  if (preview === 'reduced') return 'reduced';
  return 'full';
}

/** Studio's Full preview overrides the OS reduced-motion setting (attribute data-motion-force). */
export function forcesFullMotion(preview?: MotionPreview): boolean {
  return preview === 'full';
}

/** Entrance duration for a master, capped. */
export function entranceMs(master: MotionMaster, speed = 1): number {
  const s = motionScale(master);
  if (s === 0) return 0;
  return Math.min(ENTRANCE_CAP_MS, Math.round((380 + 220 * s) / Math.max(0.5, speed)));
}

/** Whether a theme has looping motion (the Pause control is then required, WCAG 2.2.2). */
export function hasLoopingMotion(theme: EventTheme): boolean {
  if (theme.motion.master === 'off') return false;
  const animatedEngines = new Set([
    'conic',
    'mesh',
    'grain',
    'dither',
    'smoke',
    'god_rays',
    'particles',
    'video',
  ]);
  if (animatedEngines.has(theme.background.engine) && theme.background.speed > 0) return true;
  if (theme.background.engine === 'pattern' && theme.background.options.animate === true)
    return true;
  if (theme.background.engine === 'image' && theme.background.image?.kenBurns) return true;
  if (theme.overlay.kind !== 'none' && theme.overlay.mode === 'ambient') return true;
  if (theme.finish.grain > 0.15) return true;
  if (['weight_breathe', 'neon', 'foil_sweep'].includes(theme.motion.headlineEffect)) return true;
  return false;
}

/** The scale a client engine should run at right now. */
export function liveScale(input: {
  master: MotionMaster;
  level: MotionLevel;
  reducedMotion: boolean;
  paused: boolean;
  forced: boolean;
}): number {
  if (input.level !== 'full' || input.paused) return 0;
  if (input.reducedMotion && !input.forced) return 0;
  return motionScale(input.master);
}
