import type { BACKGROUND_PATTERNS } from '@/lib/events/schema';
import { isHex, rgba } from '@/lib/events/theme/color';

/**
 * CSS/SVG background patterns (the 'pattern' engine). Pure functions of
 * validated hex colours and bounded numbers: no text from a person ever
 * reaches the CSS. Cheap on phones (no canvas, no WebGL); animation, where a
 * pattern has any, is a CSS transform the motion master can scale and the
 * Pause control can stop.
 */

export type PatternKind = (typeof BACKGROUND_PATTERNS)[number];

export interface PatternStyle {
  backgroundImage: string;
  backgroundSize?: string;
  backgroundPosition?: string;
}

const svgUrl = (svg: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27').replace(/"/g, '%22')}")`;

const hex = (value: string | undefined, fallback: string) =>
  value && isHex(value) ? value : fallback;

/** Deterministic pseudo-random (mulberry32) so a pattern renders the same on server and client. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Concentric organic contour lines for the 'topo' pattern (one 600px tile). */
function topoSvg(color: string, opacity: number): string {
  const rand = seeded(7);
  const paths: string[] = [];
  const centers = [
    [140, 160],
    [470, 420],
    [520, 90],
    [90, 520],
  ] as const;
  for (const [cx, cy] of centers) {
    const phase = rand() * Math.PI * 2;
    const rings = 5 + Math.floor(rand() * 4);
    for (let r = 1; r <= rings; r += 1) {
      const base = 18 * r + rand() * 6;
      const pts: string[] = [];
      for (let i = 0; i <= 64; i += 1) {
        const th = (i / 64) * Math.PI * 2;
        const k = 1 + 0.18 * Math.sin(3 * th + phase + r * 0.3) + 0.08 * Math.sin(5 * th - phase);
        const x = cx + Math.cos(th) * base * k;
        const y = cy + Math.sin(th) * base * k * 0.82;
        pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      paths.push(`<path d="${pts.join('')}Z"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.2">${paths.join('')}</g></svg>`;
}

/**
 * The CSS for a pattern. `fg` draws the lines/dots, `opacity` is their
 * strength (0–1), `size` the tile in px.
 */
export function patternStyle(
  kind: PatternKind,
  fgColor: string,
  opacity: number,
  size: number,
): PatternStyle {
  const fg = hex(fgColor, '#000000');
  const o = Math.min(1, Math.max(0.02, opacity));
  const s = Math.round(Math.min(200, Math.max(4, size)));
  const line = rgba(fg, o);
  switch (kind) {
    case 'dots':
      return {
        backgroundImage: `radial-gradient(${line} 1.4px, transparent 1.6px)`,
        backgroundSize: `${s}px ${s}px`,
      };
    case 'grid':
      return {
        backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
        backgroundSize: `${s}px ${s}px`,
      };
    case 'blueprint': {
      const major = rgba(fg, Math.min(1, o * 1.8));
      return {
        backgroundImage: [
          `linear-gradient(${major} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${major} 1px, transparent 1px)`,
          `linear-gradient(${line} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${line} 1px, transparent 1px)`,
        ].join(', '),
        backgroundSize: `${s * 5}px ${s * 5}px, ${s * 5}px ${s * 5}px, ${s}px ${s}px, ${s}px ${s}px`,
        backgroundPosition: '-1px -1px',
      };
    }
    case 'cross': {
      const h = s / 2;
      const arm = Math.max(3, s / 6);
      return {
        backgroundImage: svgUrl(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><path d="M${h - arm} ${h}H${h + arm}M${h} ${h - arm}V${h + arm}" stroke="${fg}" stroke-opacity="${o}" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        ),
        backgroundSize: `${s}px ${s}px`,
      };
    }
    case 'zigzag': {
      const h = s / 2;
      return {
        backgroundImage: svgUrl(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><path d="M0 ${h}L${s / 4} ${h - s / 5}L${h} ${h}L${(3 * s) / 4} ${h - s / 5}L${s} ${h}" fill="none" stroke="${fg}" stroke-opacity="${o}" stroke-width="2" stroke-linejoin="round"/></svg>`,
        ),
        backgroundSize: `${s}px ${s}px`,
      };
    }
    case 'wave': {
      const h = s / 2;
      return {
        backgroundImage: svgUrl(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${s * 2}" height="${s}"><path d="M0 ${h}C${s / 2} ${h - s / 3} ${s / 2} ${h + s / 3} ${s} ${h}S${(3 * s) / 2} ${h - s / 3} ${s * 2} ${h}" fill="none" stroke="${fg}" stroke-opacity="${o}" stroke-width="1.5"/></svg>`,
        ),
        backgroundSize: `${s * 2}px ${s}px`,
      };
    }
    case 'topo':
      return {
        backgroundImage: svgUrl(topoSvg(fg, Math.min(1, o * 1.4))),
        backgroundSize: `${Math.max(300, s * 4)}px ${Math.max(300, s * 4)}px`,
      };
    case 'sunburst':
      return {
        backgroundImage: `repeating-conic-gradient(from 0deg at 50% 50%, ${line} 0deg 3deg, transparent 3deg 12deg)`,
        backgroundSize: '100% 100%',
      };
    case 'synth_grid':
      // Drawn by the dedicated perspective element (event.css .ev-synth).
      return {
        backgroundImage: `linear-gradient(${line} 2px, transparent 2px), linear-gradient(90deg, ${line} 2px, transparent 2px)`,
        backgroundSize: `${s}px ${s}px`,
      };
  }
}
