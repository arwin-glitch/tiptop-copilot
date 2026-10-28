import { FONT_IDS, type FontId } from '@/lib/events/schema';

/**
 * The self-hosted font library behind the schema's FONT_IDS (D-075).
 *
 * Files live in public/event-fonts/<id>/ (WOFF2 for guests, Latin subset,
 * variable where the family has a weight axis) and assets/og-fonts/ (static
 * WOFF for the share card, which Satori needs). scripts/events/fetch-fonts.mjs
 * fetches both; tests/unit/events-fonts.test.ts holds this table, the files
 * and the @font-face rules in event-fonts.css to each other.
 *
 * Every family is OFL-1.1 or Apache-2.0; each folder carries its LICENSE.
 * The CSS family name is `ev-<id>` so nothing collides with Kraken's fonts.
 */

export type FontCategory = 'serif' | 'sans' | 'mono' | 'display' | 'script';

export interface FontFile {
  /** Path under /event-fonts. */
  file: string;
  /** A CSS font-weight value: '400', or a range '100 900' for variable files. */
  weight: string;
  style: 'normal' | 'italic';
}

export interface FontFamily {
  id: FontId;
  /** Display name for Studio's picker. */
  name: string;
  category: FontCategory;
  /** Generic fallbacks after the family. */
  fallback: string;
  /** Has a weight axis (weight-breathe, any display weight). */
  variable: boolean;
  files: FontFile[];
  /** Static weights in assets/og-fonts/<id>-<w>.woff. */
  og: number[];
}

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SCRIPT = "'Snell Roundhand', 'Apple Chancery', cursive";

const FALLBACK: Record<FontCategory, string> = {
  serif: SERIF,
  sans: SANS,
  mono: MONO,
  display: SANS,
  script: SCRIPT,
};

type Spec = [
  name: string,
  category: FontCategory,
  /** Variable axis stem ('wght' / 'full'), or null for static cuts. */
  axis: string | null,
  /** Static web weights (axis null), or ignored. */
  weights: number[],
  /** Italic: true for the variable italic file, or static italic weights. */
  italic: boolean | number[],
  og: number[],
];

const SPECS: Record<FontId, Spec> = {
  anton: ['Anton', 'display', null, [400], false, [400]],
  archivo: ['Archivo', 'sans', 'wght', [], false, [400, 700]],
  audiowide: ['Audiowide', 'display', null, [400], false, [400]],
  'bagel-fat-one': ['Bagel Fat One', 'display', null, [400], false, [400]],
  'big-shoulders-display': ['Big Shoulders Display', 'display', 'wght', [], false, [400, 700]],
  'bodoni-moda': ['Bodoni Moda', 'serif', 'wght', [], true, [400, 700]],
  'bricolage-grotesque': ['Bricolage Grotesque', 'sans', 'wght', [], false, [400, 700]],
  caveat: ['Caveat', 'script', 'wght', [], false, [400, 700]],
  'cormorant-garamond': ['Cormorant Garamond', 'serif', 'wght', [], true, [400, 600]],
  'dm-sans': ['DM Sans', 'sans', 'wght', [], false, [400, 700]],
  'dm-serif-display': ['DM Serif Display', 'serif', null, [400], [400], [400]],
  'eb-garamond': ['EB Garamond', 'serif', 'wght', [], true, [400, 600]],
  figtree: ['Figtree', 'sans', 'wght', [], false, [400, 700]],
  fraunces: ['Fraunces', 'serif', 'wght', [], true, [400, 700]],
  fredoka: ['Fredoka', 'display', 'wght', [], false, [400, 600]],
  geist: ['Geist', 'sans', 'wght', [], false, [400, 600]],
  'geist-mono': ['Geist Mono', 'mono', 'wght', [], false, [400, 600]],
  gloock: ['Gloock', 'serif', null, [400], false, [400]],
  'hanken-grotesk': ['Hanken Grotesk', 'sans', 'wght', [], false, [400, 700]],
  'ibm-plex-mono': ['IBM Plex Mono', 'mono', null, [400, 600], false, [400, 600]],
  'ibm-plex-sans-condensed': [
    'IBM Plex Sans Condensed',
    'sans',
    null,
    [400, 600, 700],
    false,
    [400, 600],
  ],
  'instrument-sans': ['Instrument Sans', 'sans', 'wght', [], false, [400, 600]],
  'instrument-serif': ['Instrument Serif', 'serif', null, [400], [400], [400]],
  inter: ['Inter', 'sans', 'wght', [], true, [400, 600]],
  'inter-tight': ['Inter Tight', 'sans', 'wght', [], false, [400, 700]],
  italiana: ['Italiana', 'display', null, [400], false, [400]],
  'jetbrains-mono': ['JetBrains Mono', 'mono', 'wght', [], false, [400, 700]],
  'josefin-sans': ['Josefin Sans', 'sans', 'wght', [], false, [400, 600]],
  jost: ['Jost', 'sans', 'wght', [], false, [400, 600]],
  karla: ['Karla', 'sans', 'wght', [], false, [400, 700]],
  'libre-caslon-display': ['Libre Caslon Display', 'serif', null, [400], false, [400]],
  'libre-franklin': ['Libre Franklin', 'sans', 'wght', [], false, [400, 700]],
  manrope: ['Manrope', 'sans', 'wght', [], false, [400, 700]],
  monoton: ['Monoton', 'display', null, [400], false, [400]],
  mulish: ['Mulish', 'sans', 'wght', [], false, [400, 700]],
  outfit: ['Outfit', 'sans', 'wght', [], false, [400, 600]],
  'pinyon-script': ['Pinyon Script', 'script', null, [400], false, [400]],
  'playfair-display': ['Playfair Display', 'serif', 'wght', [], true, [400, 700]],
  'plus-jakarta-sans': ['Plus Jakarta Sans', 'sans', 'wght', [], false, [400, 700]],
  'poiret-one': ['Poiret One', 'display', null, [400], false, [400]],
  'roboto-flex': ['Roboto Flex', 'sans', 'wght', [], false, [400]],
  rye: ['Rye', 'display', null, [400], false, [400]],
  shrikhand: ['Shrikhand', 'display', null, [400], false, [400]],
  silkscreen: ['Silkscreen', 'display', null, [400, 700], false, [400]],
  'space-grotesk': ['Space Grotesk', 'sans', 'wght', [], false, [400, 700]],
  'space-mono': ['Space Mono', 'mono', null, [400, 700], false, [400, 700]],
  syne: ['Syne', 'sans', 'wght', [], false, [400, 700]],
  'tilt-neon': ['Tilt Neon', 'display', 'full', [], false, [400]],
  unbounded: ['Unbounded', 'display', 'wght', [], false, [400, 700]],
  vt323: ['VT323', 'mono', null, [400], false, [400]],
  'work-sans': ['Work Sans', 'sans', 'wght', [], false, [400, 600]],
  'young-serif': ['Young Serif', 'serif', null, [400], false, [400]],
  'zilla-slab': ['Zilla Slab', 'serif', null, [400, 600, 700], false, [400, 700]],
};

function filesFor(id: FontId, spec: Spec): FontFile[] {
  const [, , axis, weights, italic] = spec;
  if (axis) {
    const range = axis === 'wght' ? '100 900' : '400';
    const out: FontFile[] = [
      { file: `${id}/${id}-${axis}-normal.woff2`, weight: range, style: 'normal' },
    ];
    if (italic === true) {
      out.push({ file: `${id}/${id}-${axis}-italic.woff2`, weight: range, style: 'italic' });
    }
    return out;
  }
  const single = weights.length === 1;
  const out: FontFile[] = weights.map((w) => ({
    file: `${id}/${id}-${w}-normal.woff2`,
    // A one-weight family answers every weight (no faux bold on display faces).
    weight: single ? '100 900' : String(w),
    style: 'normal',
  }));
  if (Array.isArray(italic)) {
    for (const w of italic) {
      out.push({
        file: `${id}/${id}-${w}-italic.woff2`,
        weight: single ? '100 900' : String(w),
        style: 'italic',
      });
    }
  }
  return out;
}

export const FONT_LIBRARY: Readonly<Record<FontId, FontFamily>> = Object.fromEntries(
  FONT_IDS.map((id) => {
    const spec = SPECS[id];
    const [name, category, axis, , , og] = spec;
    return [
      id,
      {
        id,
        name,
        category,
        fallback: FALLBACK[category],
        variable: axis === 'wght',
        files: filesFor(id, spec),
        og,
      } satisfies FontFamily,
    ];
  }),
) as Record<FontId, FontFamily>;

/** The CSS family name the @font-face rules declare. */
export function fontFaceName(id: FontId): string {
  return `ev-${id}`;
}

/** A complete font-family value: the self-hosted face, then generic fallbacks. */
export function fontStack(id: FontId): string {
  const family = FONT_LIBRARY[id];
  return `'${fontFaceName(id)}', ${family?.fallback ?? SANS}`;
}

/** Every @font-face rule, as event-fonts.css holds them (the test compares). */
export function fontFaceCss(): string {
  const rules: string[] = [];
  for (const id of FONT_IDS) {
    for (const f of FONT_LIBRARY[id].files) {
      rules.push(
        `@font-face {\n  font-family: '${fontFaceName(id)}';\n  src: url('/event-fonts/${f.file}') format('woff2');\n  font-weight: ${f.weight};\n  font-style: ${f.style};\n  font-display: swap;\n}`,
      );
    }
  }
  return rules.join('\n');
}

/** Suggested display + body pairings for Studio's typography panel. */
export const FONT_PAIRINGS: readonly {
  display: FontId;
  body: FontId;
  mono: FontId;
  label: string;
}[] = [
  { display: 'cormorant-garamond', body: 'inter', mono: 'ibm-plex-mono', label: 'Editorial serif' },
  { display: 'fraunces', body: 'inter', mono: 'ibm-plex-mono', label: 'Annual letter' },
  {
    display: 'playfair-display',
    body: 'manrope',
    mono: 'jetbrains-mono',
    label: 'Classic contrast',
  },
  { display: 'instrument-serif', body: 'inter', mono: 'geist-mono', label: 'Quiet luxury' },
  { display: 'geist', body: 'geist', mono: 'geist-mono', label: 'Modern product' },
  { display: 'inter-tight', body: 'inter', mono: 'jetbrains-mono', label: 'Swiss' },
  { display: 'syne', body: 'space-grotesk', mono: 'space-mono', label: 'Night futurist' },
  { display: 'bricolage-grotesque', body: 'dm-sans', mono: 'space-mono', label: 'Friendly bold' },
  {
    display: 'libre-caslon-display',
    body: 'libre-franklin',
    mono: 'ibm-plex-mono',
    label: 'Heritage',
  },
  { display: 'poiret-one', body: 'josefin-sans', mono: 'ibm-plex-mono', label: 'Art deco' },
  { display: 'big-shoulders-display', body: 'inter', mono: 'jetbrains-mono', label: 'Poster' },
  { display: 'young-serif', body: 'mulish', mono: 'ibm-plex-mono', label: 'Cozy' },
];
