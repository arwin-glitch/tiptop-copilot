import type { EventMedia, EventRecord, EventSession } from '@/lib/types/domain';
import { EVENT_SLUG_RE, RESERVED_EVENT_SLUGS } from './contracts';
import type { BlockType, EventDoc } from './schema';
import { themeContrastProblems } from './theme/check';

/**
 * The "Ready to publish" checklist (D-075). Pure and isomorphic: the Publish
 * dialog and the Overview tab show it, and publishEvent enforces the one
 * BLOCKING item (alt text on every content image). Every other item warns,
 * and the owner can publish anyway.
 */

export type ChecklistId =
  | 'title'
  | 'date'
  | 'venue'
  | 'rsvp'
  | 'alt_text'
  | 'contrast'
  | 'empty_sections'
  | 'media'
  | 'slug'
  | 'og';

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  ok: boolean;
  /** Blocking items stop Publish; the rest warn. */
  blocking: boolean;
  /** What is wrong, in plain words, when not ok. */
  detail: string | null;
}

/** Where a media id sits in the doc: decorative places need no alt text. */
export interface MediaUse {
  mediaId: string;
  /** Background images and section backdrops are decorative by nature. */
  decorative: boolean;
}

const MEDIA_KEY_RE = /mediaId$/;

/**
 * Every media id in a document with the place it is used. Theme backgrounds
 * and section `style.backgroundMedia` are decorative; anything in section
 * props, and the brand logos, is content and needs alt text.
 */
export function mediaUses(doc: EventDoc): MediaUse[] {
  const uses: MediaUse[] = [];
  const walk = (value: unknown, decorative: boolean, key = ''): void => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, decorative));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, decorative, k);
      }
    } else if (typeof value === 'string' && MEDIA_KEY_RE.test(key)) {
      uses.push({ mediaId: value, decorative });
    }
  };
  const { brand, ...restOfTheme } = doc.theme;
  walk(restOfTheme, true);
  walk(brand, false);
  for (const s of doc.sections) {
    walk(s.style, true);
    walk(s.props, false);
  }
  return uses;
}

/* -------------------------------------------------------------- contrast */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio of two #RRGGBB colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Contrast problems for the publish checklist: the renderer's own check for
 * the whole theme (lib/events/theme/check.ts), so the checklist can never
 * pass a pair the page draws below AA.
 */
export function contrastProblems(theme: EventDoc['theme']): string[] {
  return themeContrastProblems(theme);
}

/* ------------------------------------------------------------ the list */

/**
 * Blocks whose whole point is their own content: empty props means an empty
 * section. Not the hero (an empty headline shows the event title) and not the
 * blocks that read settings (details, venue, RSVP, countdown, footer).
 */
const CONTENT_BLOCKS = new Set<BlockType>([
  'text',
  'agenda',
  'hosts',
  'sponsors',
  'faq',
  'gallery',
  'media',
  'stats',
  'materials',
  'buttons',
]);

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return false;
}

export interface ChecklistInput {
  event: Pick<
    EventRecord,
    'title' | 'slug' | 'starts_at' | 'venue' | 'registration' | 'access' | 'is_template'
  >;
  sessions: Pick<EventSession, 'starts_at'>[];
  doc: EventDoc;
  /** The event's media rows (any the doc references; others are ignored). */
  media: Pick<EventMedia, 'id' | 'kind' | 'status' | 'alt' | 'decorative'>[];
  /** Whether the share card rendered (null: not tried). */
  ogRendered: boolean | null;
  /** Section label for messages ("Hero"). */
  blockLabel: (type: BlockType) => string;
}

export function readyChecklist(input: ChecklistInput): ChecklistItem[] {
  const { event, doc } = input;
  const items: ChecklistItem[] = [];
  const add = (id: ChecklistId, label: string, ok: boolean, detail: string, blocking = false) =>
    items.push({ id, label, ok, blocking, detail: ok ? null : detail });

  add('title', 'Title', event.title.trim().length > 0, 'Give the event a title.');

  const hasDate = Boolean(event.starts_at) || input.sessions.some((s) => Boolean(s.starts_at));
  add('date', 'Date and time', hasDate, 'Set when the event starts.');

  const v = event.venue;
  const placeOk = Boolean(v.name?.trim() || v.address?.trim());
  const onlineOk = Boolean(v.online_url?.trim());
  const venueOk =
    v.kind === 'in_person' ? placeOk : v.kind === 'online' ? onlineOk : placeOk && onlineOk;
  add(
    'venue',
    'Venue or online link',
    venueOk,
    v.kind === 'online'
      ? 'Add the online link.'
      : v.kind === 'hybrid'
        ? 'Add both the venue and the online link.'
        : 'Add the venue name or address.',
  );

  const wantsRsvp = event.registration.open !== false;
  const hasRsvp = doc.sections.some((s) => s.type === 'rsvp');
  add(
    'rsvp',
    'RSVP section',
    !wantsRsvp || hasRsvp,
    'Registration is on, but the page has no RSVP section.',
  );

  const byId = new Map(input.media.map((m) => [m.id, m]));
  const uses = mediaUses(doc);
  const missingAlt = new Set<string>();
  const notReady = new Set<string>();
  for (const use of uses) {
    const m = byId.get(use.mediaId);
    if (!m || m.status !== 'ready') {
      notReady.add(use.mediaId);
      continue;
    }
    if (use.decorative || m.decorative) continue;
    if ((m.kind === 'image' || m.kind === 'logo') && !m.alt?.trim()) missingAlt.add(m.id);
  }
  add(
    'alt_text',
    'Alt text on every image',
    missingAlt.size === 0,
    `${missingAlt.size} image${missingAlt.size === 1 ? ' needs' : 's need'} alt text (or mark ${missingAlt.size === 1 ? 'it' : 'them'} decorative).`,
    true,
  );
  add(
    'media',
    'Media uploaded and processed',
    notReady.size === 0,
    `${notReady.size} image or video slot${notReady.size === 1 ? ' is' : 's are'} missing or still processing.`,
  );

  const contrast = contrastProblems(doc.theme);
  add('contrast', 'Readable colours (AA)', contrast.length === 0, contrast.slice(0, 3).join('; '));

  const empty = doc.sections.filter(
    (s) => CONTENT_BLOCKS.has(s.type) && !hasContent(s.props) && s.visibility.mode !== 'hidden',
  );
  add(
    'empty_sections',
    'No empty sections',
    empty.length === 0,
    `Empty: ${empty
      .slice(0, 4)
      .map((s) => s.name.trim() || input.blockLabel(s.type))
      .join(', ')}.`,
  );

  const slugOk =
    EVENT_SLUG_RE.test(event.slug) &&
    !(RESERVED_EVENT_SLUGS as readonly string[]).includes(event.slug);
  add('slug', 'Link available', slugOk, 'Choose another link in Settings.');

  add(
    'og',
    'Share card renders',
    input.ogRendered !== false,
    'The share card could not be drawn; the page publishes without one.',
  );

  return items;
}

/** Items that stop Publish. */
export function blockingProblems(items: ChecklistItem[]): ChecklistItem[] {
  return items.filter((i) => i.blocking && !i.ok);
}
