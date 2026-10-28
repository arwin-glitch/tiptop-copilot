import { z } from 'zod';
import { isAllowedHref } from '@/lib/campaigns/template';

/**
 * The event page document (EventDoc): what an event page IS, stored as jsonb
 * in `events.draft_doc` (what Studio edits) and `events.published_doc` (what
 * guests see, a snapshot taken on Publish).
 *
 * Pure and isomorphic: the server validates every op and every publish with
 * it, Studio validates locally with the same schema, and the guest renderer
 * reads its types. Nothing here touches the database or the network.
 *
 * Security rules this schema enforces, because outsiders (edit links) write
 * into this document and it renders on the same origin as Kraken:
 *   - strict objects everywhere: an unknown key is an error, never ignored;
 *   - colours are exact 6-digit hex, fonts and effects come from enums,
 *     numbers are bounded;
 *   - media is referenced by `event_media` id, never by URL;
 *   - links must pass isAllowedHref (http, https, mailto);
 *   - there is no field that holds HTML, CSS or script. Rich text is the
 *     campaign template grammar plus `##`/`###` headings, rendered to React
 *     nodes (lib/events/richtext.ts), never to an HTML string.
 *
 * Section `props` are per-block and validated by the block registry
 * (lib/events/blocks, WS2) through the `validateProps` hook of parseEventDoc.
 * Here they are bounded JSON with two generic guards (link-ish keys must be
 * allowed hrefs, mediaId-ish keys must be ids), so a document is safe to
 * store even before the registry knows a block.
 *
 * Versioning: `schemaVersion` is 1. A stored document from an older version
 * is upgraded on read by `migrateEventDoc` (the chain is empty today).
 */

export const EVENT_DOC_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------ primitives */

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Lowercase canonical uuid shape (any version), as Postgres prints it. */
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A key inside props, keyRevs or effect options. */
export const PROP_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
/** A fractional-index position key (lib/events/fractional.ts): base62. */
export const POSITION_RE = /^[0-9A-Za-z]{1,64}$/;
/** A guest tag as hosts type it ("LP", "Co-investor", "VIP"). */
export const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{0,39}$/u;

export const hexColor = z.string().regex(HEX_COLOR_RE, 'Colours are 6-digit hex, like #2B6D56.');
export const entityId = z.string().regex(ID_RE, 'Expected an id.');
export const mediaId = entityId;
export const positionKey = z.string().regex(POSITION_RE, 'Expected a position key.');
export const guestTag = z.string().regex(TAG_RE, 'Tags are letters, numbers and spaces.');
export const rev = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Merge bookkeeping: key → draft_version of its last change ('props.headline', 'palette'). */
export const keyRevs = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}(\.[a-zA-Z][a-zA-Z0-9_]{0,39})?$/),
  rev,
);

/** A link a guest can click: http(s) or mailto, never javascript:, data: or a merge field. */
export const allowedHref = z
  .string()
  .max(2000)
  .refine((href) => isAllowedHref(href), 'Links must start with https://, http:// or mailto:.');

/** Plain text a guest reads. React renders it as text; length is the only rule. */
export const plainText = (max: number) => z.string().max(max);

/**
 * Rich text: the campaign grammar (**bold**, *italic*, [link](https://…),
 * lists, merge fields) plus `## ` and `### ` headings. Stored as source text;
 * rendered by lib/events/richtext.ts into React nodes.
 */
export const richText = z.string().max(20_000);

const bounded = (min: number, max: number) => z.number().finite().min(min).max(max);

/** A focal point inside an image, 0..1 on each axis. */
export const focalPoint = z.strictObject({ x: bounded(0, 1), y: bounded(0, 1) });

/** An image or video placed somewhere on the page, by event_media id. */
export const mediaRef = z.strictObject({
  mediaId,
  focal: focalPoint.optional(),
});
export type MediaRef = z.infer<typeof mediaRef>;

/* -------------------------------------------------------------- JSON props */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const JSON_MAX_DEPTH = 6;
const JSON_MAX_STRING = 20_000;
const JSON_MAX_ARRAY = 200;
const JSON_MAX_KEYS = 80;

function depthOf(value: unknown, depth = 0): number {
  if (depth > JSON_MAX_DEPTH + 1) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value)) max = Math.max(max, depthOf(item, depth + 1));
    return max;
  }
  return depth;
}

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(JSON_MAX_STRING),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(JSON_MAX_ARRAY),
    z
      .record(z.string().regex(PROP_KEY_RE), jsonValue)
      .refine((o) => Object.keys(o).length <= JSON_MAX_KEYS, 'Too many keys.'),
  ]),
);

const LINK_KEY_RE = /(href|url|link)$/i;
const MEDIA_KEY_RE = /mediaId$/;

/** Generic guards that hold for every block's props, known to the registry or not. */
function genericPropIssues(value: unknown, path: string[] = []): string[] {
  const issues: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => issues.push(...genericPropIssues(item, [...path, String(i)])));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const at = [...path, key];
      if (
        LINK_KEY_RE.test(key) &&
        typeof item === 'string' &&
        item !== '' &&
        !isAllowedHref(item)
      ) {
        issues.push(`${at.join('.')}: links must start with https://, http:// or mailto:.`);
      }
      if (
        MEDIA_KEY_RE.test(key) &&
        item !== null &&
        !(typeof item === 'string' && ID_RE.test(item))
      ) {
        issues.push(`${at.join('.')}: media is referenced by id.`);
      }
      issues.push(...genericPropIssues(item, at));
    }
  }
  return issues;
}

export const sectionProps = z
  .record(z.string().regex(PROP_KEY_RE), jsonValue)
  .superRefine((props, ctx) => {
    if (Object.keys(props).length > JSON_MAX_KEYS) {
      ctx.addIssue({ code: 'custom', message: 'Too many fields in one section.' });
    }
    if (depthOf(props) > JSON_MAX_DEPTH) {
      ctx.addIssue({ code: 'custom', message: 'Section content is nested too deeply.' });
    }
    for (const message of genericPropIssues(props)) ctx.addIssue({ code: 'custom', message });
  });
export type SectionProps = z.infer<typeof sectionProps>;

/* ------------------------------------------------------------------ fonts */

/**
 * The curated, self-hosted font library (about 50 Google families, OFL or
 * Apache). lib/events/fonts.ts (WS2) maps each id to its woff2 files under
 * public/event-fonts and its TTF under assets/og-fonts. Adding a family:
 * add the id here AND its files there in the same change.
 */
export const FONT_IDS = [
  'anton',
  'archivo',
  'audiowide',
  'bagel-fat-one',
  'big-shoulders-display',
  'bodoni-moda',
  'bricolage-grotesque',
  'caveat',
  'cormorant-garamond',
  'dm-sans',
  'dm-serif-display',
  'eb-garamond',
  'figtree',
  'fraunces',
  'fredoka',
  'geist',
  'geist-mono',
  'gloock',
  'hanken-grotesk',
  'ibm-plex-mono',
  'ibm-plex-sans-condensed',
  'instrument-sans',
  'instrument-serif',
  'inter',
  'inter-tight',
  'italiana',
  'jetbrains-mono',
  'josefin-sans',
  'jost',
  'karla',
  'libre-caslon-display',
  'libre-franklin',
  'manrope',
  'monoton',
  'mulish',
  'outfit',
  'pinyon-script',
  'playfair-display',
  'plus-jakarta-sans',
  'poiret-one',
  'roboto-flex',
  'rye',
  'shrikhand',
  'silkscreen',
  'space-grotesk',
  'space-mono',
  'syne',
  'tilt-neon',
  'unbounded',
  'vt323',
  'work-sans',
  'young-serif',
  'zilla-slab',
] as const;
export type FontId = (typeof FONT_IDS)[number];
export const fontId = z.enum(FONT_IDS);

/* ------------------------------------------------------------------ theme */

/** The nine palette tokens. Every text/background pair is AA-checked in Studio. */
export const palette = z.strictObject({
  bg: hexColor,
  surface: hexColor,
  surfaceAlt: hexColor,
  text: hexColor,
  muted: hexColor,
  accent: hexColor,
  accentFg: hexColor,
  border: hexColor,
  highlight: hexColor,
});
export type Palette = z.infer<typeof palette>;
export const PALETTE_TOKENS = Object.keys(palette.shape) as (keyof Palette)[];

export const gradient = z.strictObject({
  stops: z.array(hexColor).min(2).max(6),
  angle: bounded(0, 360),
});

export const typography = z.strictObject({
  display: fontId,
  body: fontId,
  mono: fontId,
  /** Type scale ratio between steps. */
  scale: bounded(1.125, 1.5),
  displayWeight: z.number().int().min(100).max(900),
  displayCase: z.enum(['none', 'title', 'upper', 'lower']),
  /** Letter spacing of display text, in em. */
  tracking: bounded(-0.1, 0.3),
  lineHeight: bounded(1, 2),
  /** Body text size in px. 16 is the floor (accessibility). */
  bodySize: bounded(16, 22),
  tabularNums: z.boolean(),
});

export const shape = z.strictObject({
  radius: z.number().int().min(0).max(32),
  alternateCorners: z.boolean(),
  buttonShape: z.enum(['pill', 'rounded', 'square', 'ticket', 'stamp']),
  buttonFill: z.enum(['solid', 'outline', 'glass', 'gradient', 'shimmer', 'rainbow']),
  buttonHover: z.enum(['none', 'lift', 'glow', 'magnetic']),
});

export const CONTENT_WIDTHS = ['640', '880', '1200', 'full'] as const;
export const DIVIDER_STYLES = ['none', 'hairline', 'ornament', 'wave', 'deco'] as const;

export const layout = z.strictObject({
  width: z.enum(CONTENT_WIDTHS),
  density: z.enum(['compact', 'comfortable', 'airy']),
  align: z.enum(['left', 'center']),
  divider: z.enum(DIVIDER_STYLES),
  /** Colour of hairline rules. */
  rule: z.enum(['gold', 'ink', 'accent']),
});

/**
 * Extra knobs for an effect engine, validated per engine by WS2's effect
 * registry through the `validateTheme` hook. Bounded primitives only.
 */
export const effectOptions = z
  .record(
    z.string().regex(PROP_KEY_RE),
    z.union([
      z.number().finite().min(-10_000).max(10_000),
      z.boolean(),
      z
        .string()
        .max(64)
        .regex(/^[\w .,:#%-]*$/, 'Plain values only.'),
      z.array(hexColor).max(8),
    ]),
  )
  .refine((o) => Object.keys(o).length <= 24, 'Too many options.');

export const BACKGROUND_ENGINES = [
  'solid',
  'linear',
  'radial',
  'conic',
  'mesh',
  'grain',
  'dither',
  'waves',
  'smoke',
  'god_rays',
  'particles',
  'pattern',
  'image',
  'video',
] as const;
export type BackgroundEngine = (typeof BACKGROUND_ENGINES)[number];

export const BACKGROUND_PATTERNS = [
  'dots',
  'grid',
  'cross',
  'zigzag',
  'wave',
  'topo',
  'blueprint',
  'sunburst',
  'synth_grid',
] as const;
export const PARTICLE_KINDS = ['stars', 'snow', 'fireflies', 'dust', 'bubbles'] as const;
export const IMAGE_FILTERS = [
  'none',
  'duotone',
  'grayscale',
  'halftone',
  'dither',
  'water',
] as const;

export const background = z.strictObject({
  engine: z.enum(BACKGROUND_ENGINES),
  /** 2–6 colours for gradient/mesh/particle engines; palette tokens when empty. */
  colors: z.array(hexColor).max(6),
  intensity: bounded(0, 1),
  speed: bounded(0, 2),
  scale: bounded(0.25, 4),
  cursorReactive: z.boolean(),
  /** Behind the hero only, or the whole page. */
  scope: z.enum(['hero', 'page']),
  pattern: z.enum(BACKGROUND_PATTERNS).optional(),
  particles: z.enum(PARTICLE_KINDS).optional(),
  image: z
    .strictObject({
      media: mediaRef,
      /** 0–0.8 darkening scrim. Studio adds one automatically under text. */
      scrim: bounded(0, 0.8),
      blur: bounded(0, 40),
      kenBurns: z.boolean(),
      parallax: z.boolean(),
      filter: z.enum(IMAGE_FILTERS),
    })
    .optional(),
  /** A loop. A poster is required (Low Power Mode, reduced motion, LCP). */
  video: z.strictObject({ media: mediaRef, poster: mediaRef }).optional(),
  options: effectOptions,
});

export const OVERLAY_KINDS = [
  'none',
  'confetti',
  'gold_dust',
  'petals',
  'leaves',
  'snow',
  'fireflies',
  'bubbles',
  'golf_balls',
  'shooting_stars',
  'smoke',
  'sunbeams',
  'custom',
] as const;

export const overlay = z.strictObject({
  kind: z.enum(OVERLAY_KINDS),
  density: bounded(0, 1),
  speed: bounded(0, 2),
  colors: z.array(hexColor).max(6),
  area: z.enum(['hero', 'page']),
  /** Ambient drift, or a single burst on load. */
  mode: z.enum(['ambient', 'burst']),
  /** The uploaded emoji/logo/sticker, for kind 'custom'. */
  custom: mediaRef.optional(),
  options: effectOptions,
});

export const finish = z.strictObject({
  grain: bounded(0, 1),
  paper: bounded(0, 1),
  halftone: bounded(0, 1),
  scanlines: bounded(0, 1),
  vignette: bounded(0, 1),
  foil: z.boolean(),
  emboss: z.boolean(),
});

export const INTRO_KINDS = [
  'none',
  'fade',
  'envelope',
  'curtain',
  // v1 nice
  'wax_seal',
  'ticket',
  'fog',
  'countdown',
  'flip',
] as const;
export const ENVELOPE_LINERS = [
  'none',
  'stripes',
  'dots',
  'damask',
  'deco',
  'botanical',
  'solid',
] as const;

export const intro = z.strictObject({
  kind: z.enum(INTRO_KINDS),
  envelope: z
    .strictObject({
      color: hexColor,
      liner: z.enum(ENVELOPE_LINERS),
      linerColor: hexColor,
      /** The stamp: usually the host logo. */
      stamp: mediaRef.optional(),
      postmark: plainText(40),
      sealColor: hexColor,
      /** "Dear {{first_name|friend}}," — merge fields resolve per viewer. */
      greeting: plainText(80),
    })
    .optional(),
  /** Show once per visitor (a cookie-free sessionStorage flag), with Skip. */
  oncePerVisitor: z.boolean(),
});

export const HEADLINE_EFFECTS = [
  'none',
  'blur_in',
  'letter_reveal',
  'word_reveal',
  'foil_sweep',
  'gradient_fill',
  'outline',
  'scramble',
  'typewriter',
  'weight_breathe',
  'split_flap',
  'neon',
] as const;
export const ENTRANCES = ['none', 'fade_up', 'slide', 'blur', 'mask', 'scale_in'] as const;
export const RSVP_MOMENTS = [
  'none',
  'confetti',
  'gold_dust',
  'ball_to_cup',
  'wax_stamp',
  // v1 nice
  'ticket_tear',
  'warp',
  'petals',
  'glow_bloom',
] as const;
export const CURSORS = ['default', 'spotlight', 'trail', 'emoji'] as const;
export const COUNTDOWN_STYLES = [
  'split_flap',
  'digital',
  'ring',
  'minimal',
  'constellation',
] as const;
export const MOTION_MASTERS = ['off', 'subtle', 'lively', 'party'] as const;
export type MotionMaster = (typeof MOTION_MASTERS)[number];
/** The motion master as a multiplier on every animation. */
export const MOTION_SCALE: Record<MotionMaster, number> = {
  off: 0,
  subtle: 0.4,
  lively: 0.75,
  party: 1,
};

export const motion = z.strictObject({
  master: z.enum(MOTION_MASTERS),
  headlineEffect: z.enum(HEADLINE_EFFECTS),
  headlineSpeed: bounded(0.5, 2),
  entrance: z.enum(ENTRANCES),
  staggerMs: z.number().int().min(0).max(300),
  parallax: bounded(0, 1),
  scrollZoomHero: z.boolean(),
  stickyHeadings: z.boolean(),
  rsvpMoment: z.enum(RSVP_MOMENTS),
  cursor: z.enum(CURSORS),
  countdownStyle: z.enum(COUNTDOWN_STYLES),
  pausePosition: z.enum(['bottom-left', 'bottom-right']),
});

export const peoplePhotos = z.strictObject({
  treatment: z.enum(['none', 'grayscale', 'duotone', 'dither', 'halftone']),
  mask: z.enum(['none', 'circle', 'arch', 'squircle', 'rounded']),
});

/**
 * Brand kit and locks. Owner-only as a whole: an outside editor can never
 * change a lock (capabilities.ts), and a locked part of the theme is
 * read-only for them.
 */
export const brand = z.strictObject({
  kitId: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]*$/)
    .nullable(),
  logo: mediaRef.nullable(),
  logoDark: mediaRef.nullable(),
  /** Co-host lockup: "TipTop × Partner × Partner". */
  lockup: z.array(z.strictObject({ name: plainText(60), logo: mediaRef.nullable() })).max(4),
  locks: z.strictObject({
    logo: z.boolean(),
    palette: z.boolean(),
    fonts: z.boolean(),
    intro: z.boolean(),
  }),
});

export const themeSchema = z.strictObject({
  /** The preset this theme started from (lib/events/themes, WS2). */
  presetId: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  mode: z.enum(['light', 'dark', 'auto']),
  palette,
  /** The dark palette, tuned separately (used for mode dark, or auto at night). */
  paletteDark: palette,
  gradient: gradient.nullable(),
  typography,
  shape,
  layout,
  background,
  overlay,
  finish,
  intro,
  motion,
  peoplePhotos,
  brand,
  rev,
  keyRevs,
});
export type EventTheme = z.infer<typeof themeSchema>;

/** Theme keys an op may set (everything but the merge bookkeeping). */
export const THEME_KEYS = [
  'presetId',
  'mode',
  'palette',
  'paletteDark',
  'gradient',
  'typography',
  'shape',
  'layout',
  'background',
  'overlay',
  'finish',
  'intro',
  'motion',
  'peoplePhotos',
  'brand',
] as const satisfies readonly Exclude<keyof EventTheme, 'rev' | 'keyRevs'>[];
export type ThemeKey = (typeof THEME_KEYS)[number];

/** The schema for one theme key's value, for validating a theme.update op. */
export function themeKeySchema(key: ThemeKey): z.ZodType {
  return themeSchema.shape[key];
}

/* ---------------------------------------------------------------- sections */

/**
 * Every block type, with its layout variants. The block registry (WS2)
 * implements each: props schema, field descriptors, defaults, render. A type
 * or variant is added here and in the registry in the same change.
 */
export const BLOCK_VARIANTS = {
  hero: ['centered', 'split', 'full_bleed', 'kinetic', 'framed', 'envelope'],
  details: ['chips', 'card', 'ticket'],
  rsvp: ['inline', 'sheet', 'sticky', 'corner'],
  agenda: ['timeline', 'two_column', 'day_tabs', 'scorecard', 'menu', 'terminal', 'bento'],
  text: ['single', 'two_column', 'drop_cap'],
  hosts: ['grid', 'row', 'leaderboard', 'dithered'],
  sponsors: ['tiers', 'marquee', 'lockup', 'holes'],
  venue: ['card', 'map', 'notes'],
  countdown: ['split_flap', 'digital', 'ring', 'minimal'],
  faq: ['accordion', 'two_column'],
  gallery: ['grid', 'carousel', 'masonry', 'polaroid'],
  media: ['image', 'video'],
  stats: ['quote', 'stats'],
  materials: ['list', 'cards'],
  buttons: ['row', 'stack'],
  divider: ['line', 'ornament', 'space'],
  footer: ['simple', 'columns'],
  // v1 nice
  embed: ['inline'],
  guest_wall: ['avatars', 'list'],
  join_remote: ['card'],
  info_cards: ['dress_code', 'travel'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type BlockType = keyof typeof BLOCK_VARIANTS;
export const BLOCK_TYPES = Object.keys(BLOCK_VARIANTS) as [BlockType, ...BlockType[]];
export const blockType = z.enum(BLOCK_TYPES);
export type BlockVariant<T extends BlockType = BlockType> = (typeof BLOCK_VARIANTS)[T][number];

export const SECTION_BACKGROUNDS = [
  'inherit',
  'surface',
  'alt',
  'accent',
  'dark',
  'light',
  'image',
  'video',
] as const;

export const sectionStyle = z.strictObject({
  background: z.enum(SECTION_BACKGROUNDS),
  backgroundMedia: mediaRef.nullable(),
  padding: z.enum(['none', 's', 'm', 'l', 'xl']),
  align: z.enum(['inherit', 'left', 'center']),
  width: z.enum(['inherit', ...CONTENT_WIDTHS]),
  divider: z.enum(['inherit', ...DIVIDER_STYLES]),
});
export type SectionStyle = z.infer<typeof sectionStyle>;

export const sectionMotion = z.strictObject({
  /** false: follow the page's motion settings; true: use the fields below. */
  override: z.boolean(),
  entrance: z.enum(ENTRANCES),
  staggerMs: z.number().int().min(0).max(300),
  parallax: bounded(0, 1),
  headlineEffect: z.enum(HEADLINE_EFFECTS),
});
export type SectionMotion = z.infer<typeof sectionMotion>;

export const VISIBILITY_MODES = ['everyone', 'registered', 'going', 'tags', 'hidden'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

/**
 * Who sees a section. Enforced on the SERVER by lib/events/visibility.ts
 * (WS4): a section a viewer does not qualify for is removed from the doc
 * before it reaches the renderer, never hidden with CSS.
 */
export const visibility = z.strictObject({
  mode: z.enum(VISIBILITY_MODES),
  /** For mode 'tags': any of these guest tags qualifies. */
  tags: z.array(guestTag).max(20),
});
export type SectionVisibility = z.infer<typeof visibility>;

export const sectionSchema = z
  .strictObject({
    id: entityId,
    type: blockType,
    variant: z.string().max(40),
    /** Fractional-index key: sections render sorted by it (lib/events/fractional.ts). */
    position: positionKey,
    /** The outline's label; the block's own name when empty. */
    name: plainText(60),
    props: sectionProps,
    style: sectionStyle,
    motion: sectionMotion,
    visibility,
    /** draft_version of the last change to this section. */
    rev,
    /** Per-key draft_version of the last change: 'props.headline', 'style', … */
    keyRevs,
  })
  .superRefine((section, ctx) => {
    const variants = BLOCK_VARIANTS[section.type] as readonly string[];
    if (!variants.includes(section.variant)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variant'],
        message: `"${section.variant}" is not a ${section.type} layout.`,
      });
    }
  });
export type EventSection = z.infer<typeof sectionSchema>;

/**
 * Section keys an op may set: these fields, or `props.<key>`. A rich-text
 * prop is one key (two people editing the same paragraph conflict; two
 * editing different fields merge).
 */
export const SECTION_FIELD_KEYS = ['variant', 'name', 'style', 'motion', 'visibility'] as const;
export type SectionFieldKey = (typeof SECTION_FIELD_KEYS)[number];
export const SECTION_KEY_RE =
  /^(variant|name|style|motion|visibility|props\.[a-zA-Z][a-zA-Z0-9_]{0,39})$/;
export type SectionKey = SectionFieldKey | `props.${string}`;

export function isSectionKey(key: string): key is SectionKey {
  return SECTION_KEY_RE.test(key);
}

/** The schema for one section key's value, for validating a section.update op. */
export function sectionKeySchema(key: SectionKey): z.ZodType {
  if (key.startsWith('props.')) return jsonValue;
  return sectionSchema.shape[key as SectionFieldKey];
}

/* -------------------------------------------------------------------- meta */

export const pageMeta = z.strictObject({
  /** Overrides the event title in <title> and the share card. Empty: the title. */
  seoTitle: plainText(70),
  seoDescription: plainText(200),
  ogLayout: z.enum(['cover', 'type', 'ticket']),
  faviconFromLogo: z.boolean(),
  rev,
  keyRevs,
});
export type EventPageMeta = z.infer<typeof pageMeta>;
export const META_KEYS = ['seoTitle', 'seoDescription', 'ogLayout', 'faviconFromLogo'] as const;
export type MetaKey = (typeof META_KEYS)[number];

export function metaKeySchema(key: MetaKey): z.ZodType {
  return pageMeta.shape[key];
}

/* --------------------------------------------------------------------- doc */

export const MAX_SECTIONS = 60;
/** Serialized size cap for a whole document (what Postgres stores). */
export const MAX_DOC_BYTES = 400_000;

export const eventDocSchema = z
  .strictObject({
    schemaVersion: z.literal(EVENT_DOC_SCHEMA_VERSION),
    theme: themeSchema,
    sections: z.array(sectionSchema).max(MAX_SECTIONS),
    meta: pageMeta,
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    const positions = new Set<string>();
    doc.sections.forEach((s, i) => {
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'id'],
          message: 'Duplicate section id.',
        });
      }
      if (positions.has(s.position)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'position'],
          message: 'Two sections share a position.',
        });
      }
      ids.add(s.id);
      positions.add(s.position);
    });
  });
export type EventDoc = z.infer<typeof eventDocSchema>;

/* ------------------------------------------------------------------- parse */

/**
 * Per-block props validation, supplied by the block registry (WS2):
 * lib/events/blocks exports one. Returns problems as plain sentences, [] when
 * the props are valid. Unknown props keys must be reported.
 */
export type BlockPropsValidator = (
  type: BlockType,
  variant: string,
  props: SectionProps,
) => string[];

/** Per-engine theme validation (effect options and so on), supplied by WS2. */
export type ThemeValidator = (theme: EventTheme) => string[];

export interface ParseOptions {
  validateProps?: BlockPropsValidator;
  validateTheme?: ThemeValidator;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(doc)'}: ${i.message}`);
}

/**
 * Upgrade a stored document to the current schemaVersion. Each step is a pure
 * function from version n to n+1; the chain is empty while only v1 exists.
 */
export function migrateEventDoc(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const doc = raw as { schemaVersion?: unknown };
  // Future: while (doc.schemaVersion === 1) { doc = v1ToV2(doc) } …
  return doc;
}

/** Validate a whole document: migrate, schema, size, then the registry hooks. */
export function parseEventDoc(raw: unknown, options: ParseOptions = {}): ParseResult<EventDoc> {
  const migrated = migrateEventDoc(raw);
  let size = 0;
  try {
    size = JSON.stringify(migrated)?.length ?? 0;
  } catch {
    return { ok: false, issues: ['(doc): not serializable.'] };
  }
  if (size > MAX_DOC_BYTES) return { ok: false, issues: ['(doc): the page is too large.'] };
  const parsed = eventDocSchema.safeParse(migrated);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues: string[] = [];
  if (options.validateProps) {
    for (const s of parsed.data.sections) {
      for (const message of options.validateProps(s.type, s.variant, s.props)) {
        issues.push(`sections.${s.id}.props: ${message}`);
      }
    }
  }
  if (options.validateTheme) {
    for (const message of options.validateTheme(parsed.data.theme))
      issues.push(`theme: ${message}`);
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** Validate one section (an insert op). */
export function parseSection(raw: unknown, options: ParseOptions = {}): ParseResult<EventSection> {
  const parsed = sectionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues = options.validateProps
    ? options.validateProps(parsed.data.type, parsed.data.variant, parsed.data.props)
    : [];
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** Sections in render order (by fractional position, then id for a stable tie-break). */
export function orderedSections<T extends { position: string; id: string }>(
  sections: readonly T[],
): T[] {
  return [...sections].sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
  );
}

/* --------------------------------------------------------------- defaults */

/** Section defaults that do not depend on the block (WS2 supplies props). */
export function defaultSectionStyle(): SectionStyle {
  return {
    background: 'inherit',
    backgroundMedia: null,
    padding: 'm',
    align: 'inherit',
    width: 'inherit',
    divider: 'inherit',
  };
}

export function defaultSectionMotion(): SectionMotion {
  return {
    override: false,
    entrance: 'fade_up',
    staggerMs: 60,
    parallax: 0,
    headlineEffect: 'none',
  };
}

export function defaultVisibility(): SectionVisibility {
  return { mode: 'everyone', tags: [] };
}

export function defaultPageMeta(): EventPageMeta {
  return {
    seoTitle: '',
    seoDescription: '',
    ogLayout: 'cover',
    faviconFromLogo: true,
    rev: 0,
    keyRevs: {},
  };
}
