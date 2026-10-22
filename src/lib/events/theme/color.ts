/**
 * Colour math for the event theme engine. Pure and isomorphic: Studio's
 * contrast badges, "Theme from logo", Remix, the renderer and the OG card all
 * use it. Inputs are the schema's exact 6-digit hex; outputs are uppercase
 * 6-digit hex, so a result always passes `hexColor` again.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  l: number;
}

/** OKLCH: perceptual lightness (0–1), chroma (0–~0.37), hue (0–360). */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

export function hexToRgb(hex: string): Rgb {
  const m = HEX_RE.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.round(clamp(n, 0, 255))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function normalizeHex(hex: string): string {
  return rgbToHex(hexToRgb(hex));
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: hue(hh + 1 / 3) * 255, g: hue(hh) * 255, b: hue(hh - 1 / 3) * 255 };
}

export const hexToHsl = (hex: string) => rgbToHsl(hexToRgb(hex));
export const hslToHex = (hsl: Hsl) => rgbToHex(hslToRgb(hsl));

/* ------------------------------------------------------------- OKLCH */

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
};

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function oklchToRgbRaw({ l: L, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const inGamut = ({ r, g, b }: Rgb) =>
  r >= -0.5 && r <= 255.5 && g >= -0.5 && g <= 255.5 && b >= -0.5 && b <= 255.5;

/** OKLCH → sRGB, reducing chroma until the colour fits the gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  let c = color.c;
  for (let i = 0; i < 24; i += 1) {
    const rgb = oklchToRgbRaw({ ...color, c });
    if (inGamut(rgb)) return rgb;
    c *= 0.85;
  }
  return oklchToRgbRaw({ ...color, c: 0 });
}

export const hexToOklch = (hex: string) => rgbToOklch(hexToRgb(hex));
export const oklchToHex = (color: Oklch) => rgbToHex(oklchToRgb(color));

/* ------------------------------------------------------------- mixing */

/** Linear sRGB-space mix: t=0 is `a`, t=1 is `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k,
  });
}

/** Shift perceptual lightness by `delta` (−1..1), keeping hue and chroma. */
export function shiftLightness(hex: string, delta: number): string {
  const c = hexToOklch(hex);
  return oklchToHex({ ...c, l: clamp(c.l + delta, 0, 1) });
}

/** Set perceptual lightness, keeping hue and chroma. */
export function withLightness(hex: string, l: number): string {
  const c = hexToOklch(hex);
  return oklchToHex({ ...c, l: clamp(l, 0, 1) });
}

/** `rgba()` for CSS from a hex and an alpha (0–1). */
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(alpha, 0, 1) * 1000) / 1000})`;
}
