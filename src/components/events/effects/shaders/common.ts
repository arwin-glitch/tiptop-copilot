import type { CSSProperties } from 'react';

/**
 * Our engine interface over Paper's shaders (pinned 0.0.81, a 0.0.x API:
 * only the files in this folder import the package). Each engine is its own
 * module, loaded by the shader island only when a page's theme uses it, so
 * a page downloads one shader, not all of them.
 */

export type ShaderEngine = 'mesh' | 'grain' | 'dither' | 'waves' | 'smoke' | 'god_rays';

export interface ShaderProps {
  colors: string[];
  options: Record<string, unknown>;
  /** Final animation speed (0 renders one still frame and stops). */
  speed: number;
  /** Zoom of the pattern (theme background.scale). */
  scale: number;
  /** DPR cap as a pixel budget for the canvas. */
  maxPixelCount: number;
}

export function sizing({ scale, maxPixelCount }: ShaderProps) {
  return {
    style: { position: 'absolute', inset: 0 } as CSSProperties,
    minPixelRatio: 1,
    maxPixelCount,
    fit: 'cover' as const,
    scale,
  };
}

/** The first colour is the back colour; the rest are the shapes'. */
export function split(colors: string[]): { back: string; rest: string[] } {
  const back = colors[0] ?? '#000000';
  return { back, rest: colors.length > 1 ? colors.slice(1) : [back] };
}
