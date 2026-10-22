import { z } from 'zod';
import {
  allowedHref,
  entityId,
  mediaRef,
  plainText,
  richText,
  type BlockType,
} from '@/lib/events/schema';

/**
 * Per-block props schemas (D-075, WS2). Strict: an unknown key is an error.
 * Every field is optional, because a new section starts empty (an empty
 * headline falls back to the event title, an empty photo slot shows "Add
 * photo" in Studio and nothing on the live page — never lorem ipsum).
 *
 * Text is plain (React renders it as text) or rich (the campaign grammar,
 * rendered by lib/events/richtext.ts into React nodes). Links pass
 * isAllowedHref. Media is an event_media id. Nothing holds HTML or CSS.
 */

const href = z.union([z.literal(''), allowedHref]);
const media = mediaRef.nullable();
const bool = z.boolean();
const bounded = (min: number, max: number) => z.number().finite().min(min).max(max);

export const HERO_FRAMES = [
  'none',
  'rounded',
  'arch',
  'circle',
  'polaroid',
  'ticket',
  'stamp',
] as const;
export const TEXT_POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
export type TextPosition = (typeof TEXT_POSITIONS)[number];

export const heroProps = z
  .strictObject({
    eyebrow: plainText(80),
    headline: plainText(160),
    subheadline: plainText(400),
    media,
    frame: z.enum(HERO_FRAMES),
    textPosition: z.enum(TEXT_POSITIONS),
    scrim: bounded(0, 0.8),
    showDate: bool,
    showVenue: bool,
    showLogo: bool,
    ctaLabel: plainText(40),
    ctaTarget: z.enum(['rsvp', 'link', 'none']),
    ctaHref: href,
  })
  .partial();

const detailItem = z.strictObject({ label: plainText(40), value: plainText(120) });

export const detailsProps = z
  .strictObject({
    heading: plainText(120),
    showDate: bool,
    showTime: bool,
    showVenue: bool,
    showTimezone: bool,
    showAccess: bool,
    items: z.array(detailItem).max(6),
  })
  .partial();

export const rsvpProps = z
  .strictObject({
    heading: plainText(120),
    body: richText.max(2000),
    cta: plainText(40),
    going: plainText(40),
    maybe: plainText(40),
    notGoing: plainText(40),
    note: plainText(200),
  })
  .partial();

export const agendaItem = z
  .strictObject({
    time: plainText(24),
    endTime: plainText(24),
    title: plainText(140),
    description: plainText(600),
    speaker: plainText(120),
    /** Ties the item to a session: it follows that session's visibility. */
    sessionId: entityId.nullable(),
    /** two_column: which column (a = left/afternoon, b = right/evening). */
    column: z.enum(['a', 'b']),
    /** day_tabs: the tab label. */
    day: plainText(40),
    /** bento: track label (colour comes from the theme). */
    track: plainText(40),
    /** scorecard: hole number. */
    hole: z.number().int().min(1).max(36).nullable(),
  })
  .partial();
export type AgendaItem = z.infer<typeof agendaItem>;

export const agendaProps = z
  .strictObject({
    heading: plainText(120),
    intro: plainText(1000),
    columnA: plainText(40),
    columnB: plainText(40),
    items: z.array(agendaItem).max(60),
  })
  .partial();

export const textProps = z
  .strictObject({
    eyebrow: plainText(80),
    heading: plainText(160),
    body: richText,
  })
  .partial();

export const person = z
  .strictObject({
    name: plainText(80),
    title: plainText(80),
    company: plainText(80),
    photo: media,
    href,
    bio: plainText(400),
    /** The Copilot record this card was picked from (Network/CRM/portfolio). */
    recordId: entityId.nullable(),
    /** leaderboard: a score or stat ("−3", "Seed"). */
    stat: plainText(24),
  })
  .partial();
export type Person = z.infer<typeof person>;

export const hostsProps = z
  .strictObject({
    heading: plainText(120),
    intro: plainText(600),
    people: z.array(person).max(48),
  })
  .partial();

export const SPONSOR_TIERS = ['presenting', 'gold', 'partner', 'community'] as const;

export const sponsor = z
  .strictObject({
    name: plainText(80),
    logo: media,
    href,
    tier: z.enum(SPONSOR_TIERS),
    hole: z.number().int().min(1).max(36).nullable(),
    note: plainText(80),
  })
  .partial();
export type Sponsor = z.infer<typeof sponsor>;

export const sponsorsProps = z
  .strictObject({
    heading: plainText(120),
    intro: plainText(600),
    items: z.array(sponsor).max(60),
  })
  .partial();

export const venueProps = z
  .strictObject({
    heading: plainText(120),
    notes: richText.max(2000),
    parking: plainText(400),
    arrival: plainText(400),
    photo: media,
    showMap: bool,
    showDirections: bool,
  })
  .partial();

export const countdownProps = z
  .strictObject({
    heading: plainText(120),
    /** 'event', or a session id to count to that session. */
    target: z.union([z.literal('event'), entityId]),
    liveLabel: plainText(80),
    endedLabel: plainText(80),
  })
  .partial();

const faqItem = z.strictObject({ q: plainText(200), a: richText.max(2000) }).partial();
export const faqProps = z
  .strictObject({ heading: plainText(120), items: z.array(faqItem).max(40) })
  .partial();

const galleryImage = z.strictObject({ media, caption: plainText(200) }).partial();
export const galleryProps = z
  .strictObject({ heading: plainText(120), images: z.array(galleryImage).max(60) })
  .partial();

export const MEDIA_ASPECTS = ['auto', '16:9', '4:3', '1:1', '3:4', '21:9'] as const;
export const mediaProps = z
  .strictObject({
    media,
    poster: media,
    caption: plainText(300),
    aspect: z.enum(MEDIA_ASPECTS),
    autoplay: bool,
  })
  .partial();

const stat = z
  .strictObject({
    value: plainText(24),
    label: plainText(80),
    prefix: plainText(8),
    suffix: plainText(8),
  })
  .partial();
export const statsProps = z
  .strictObject({
    heading: plainText(120),
    quote: plainText(600),
    attribution: plainText(80),
    role: plainText(120),
    photo: media,
    stats: z.array(stat).max(8),
    countUp: bool,
  })
  .partial();

export const MATERIAL_KINDS = ['deck', 'doc', 'link', 'video', 'sheet'] as const;
const material = z
  .strictObject({
    title: plainText(140),
    description: plainText(400),
    file: media,
    href,
    kind: z.enum(MATERIAL_KINDS),
  })
  .partial();
export const materialsProps = z
  .strictObject({
    heading: plainText(120),
    intro: plainText(1000),
    items: z.array(material).max(30),
  })
  .partial();

const button = z
  .strictObject({
    label: plainText(40),
    href,
    style: z.enum(['primary', 'secondary', 'ghost']),
  })
  .partial();
export const buttonsProps = z
  .strictObject({ heading: plainText(120), items: z.array(button).max(6) })
  .partial();

export const dividerProps = z.strictObject({ size: z.enum(['s', 'm', 'l']) }).partial();

const footerLink = z.strictObject({ label: plainText(40), href }).partial();
export const footerProps = z
  .strictObject({
    text: plainText(400),
    contactLabel: plainText(40),
    /** "Contact the host": a mailto: or https link. */
    contactHref: href,
    links: z.array(footerLink).max(8),
    /** The tiny "Made with TipTop" mark (off by default). */
    showMadeWith: bool,
  })
  .partial();

export const EMBED_PROVIDERS = ['youtube', 'vimeo', 'loom', 'spotify', 'google_maps'] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** Per-provider id shapes: the page builds the iframe URL itself from the id. */
export const EMBED_ID_RE: Record<EmbedProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{6,12}$/,
  loom: /^[a-f0-9]{32}$/,
  spotify: /^(playlist|album|track|episode|show)\/[A-Za-z0-9]{22}$/,
  google_maps: /^[\p{L}\p{N} ,.'#&-]{2,120}$/u,
};

export const embedProps = z
  .strictObject({
    provider: z.enum(EMBED_PROVIDERS),
    embedId: z.string().max(120),
    title: plainText(120),
    caption: plainText(200),
  })
  .partial()
  .superRefine((p, ctx) => {
    if (p.provider && p.embedId && !EMBED_ID_RE[p.provider].test(p.embedId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['embedId'],
        message: `That is not a ${p.provider.replace('_', ' ')} id.`,
      });
    }
  });

export const guestWallProps = z
  .strictObject({ heading: plainText(120), note: plainText(200) })
  .partial();

export const joinRemoteProps = z
  .strictObject({
    heading: plainText(120),
    body: richText.max(2000),
    label: plainText(40),
    href,
    replayHref: href,
  })
  .partial();

export const INFO_ICONS = [
  'shirt',
  'plane',
  'car',
  'hotel',
  'sun',
  'info',
  'gift',
  'utensils',
] as const;
const infoCard = z
  .strictObject({ title: plainText(80), body: richText.max(800), icon: z.enum(INFO_ICONS) })
  .partial();
export const infoCardsProps = z
  .strictObject({ heading: plainText(120), items: z.array(infoCard).max(8) })
  .partial();

export const BLOCK_PROPS: Record<BlockType, z.ZodType> = {
  hero: heroProps,
  details: detailsProps,
  rsvp: rsvpProps,
  agenda: agendaProps,
  text: textProps,
  hosts: hostsProps,
  sponsors: sponsorsProps,
  venue: venueProps,
  countdown: countdownProps,
  faq: faqProps,
  gallery: galleryProps,
  media: mediaProps,
  stats: statsProps,
  materials: materialsProps,
  buttons: buttonsProps,
  divider: dividerProps,
  footer: footerProps,
  embed: embedProps,
  guest_wall: guestWallProps,
  join_remote: joinRemoteProps,
  info_cards: infoCardsProps,
};

export type HeroProps = z.infer<typeof heroProps>;
export type DetailsProps = z.infer<typeof detailsProps>;
export type RsvpProps = z.infer<typeof rsvpProps>;
export type AgendaProps = z.infer<typeof agendaProps>;
export type TextProps = z.infer<typeof textProps>;
export type HostsProps = z.infer<typeof hostsProps>;
export type SponsorsProps = z.infer<typeof sponsorsProps>;
export type VenueProps = z.infer<typeof venueProps>;
export type CountdownProps = z.infer<typeof countdownProps>;
export type FaqProps = z.infer<typeof faqProps>;
export type GalleryProps = z.infer<typeof galleryProps>;
export type MediaProps = z.infer<typeof mediaProps>;
export type StatsProps = z.infer<typeof statsProps>;
export type MaterialsProps = z.infer<typeof materialsProps>;
export type ButtonsProps = z.infer<typeof buttonsProps>;
export type DividerProps = z.infer<typeof dividerProps>;
export type FooterProps = z.infer<typeof footerProps>;
export type EmbedProps = z.infer<typeof embedProps>;
export type GuestWallProps = z.infer<typeof guestWallProps>;
export type JoinRemoteProps = z.infer<typeof joinRemoteProps>;
export type InfoCardsProps = z.infer<typeof infoCardsProps>;

/** Props for a block type, parsed leniently for RENDERING: invalid fields are dropped, never thrown. */
export function readProps<T>(schema: z.ZodType<T>, props: unknown): T {
  const parsed = schema.safeParse(props);
  if (parsed.success) return parsed.data;
  // A stored doc was validated on write; this path only covers drift (an
  // older doc, a hand-edited fixture). Keep what parses, key by key.
  const out: Record<string, unknown> = {};
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      const one = schema.safeParse({ [key]: value });
      if (one.success) Object.assign(out, one.data as Record<string, unknown>);
    }
  }
  return out as T;
}
