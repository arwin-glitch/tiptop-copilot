import type {
  EventPublicFacts,
  EventRsvpContext,
  EventSessionPublic,
  MediaMap,
  ResolvedMedia,
  StarterDoc,
  ThemePreset,
} from '@/lib/events/contracts';
import { PUBLIC_VIEWER } from '@/lib/events/contracts';
import { newEventDoc, type SectionTemplate } from '@/lib/events/doc';
import type { EventDoc, EventTheme, Palette } from '@/lib/events/schema';
import { getStarter } from '@/lib/events/starters';
import { getThemePreset, presetVariants } from '@/lib/events/themes';
import { mix } from '@/lib/events/theme/color';
import { primaryPalette } from '@/lib/events/theme/tokens';

/**
 * Preview pages for a theme preset (D-075, WS2): a starter's sections in the
 * preset's preferred layouts, with fictional facts and abstract SVG artwork
 * standing in for photos. Used by the theme gallery's full-page preview,
 * Studio's "Preview this theme", and the renderer's e2e and screenshot runs.
 * Nothing here is real data, and nothing reaches storage.
 */

const NS = '00000000-0000-4000-8000-0000ee00';
const pid = (n: number) => `${NS}${n.toString(16).padStart(4, '0')}`;

export const PREVIEW_MEDIA_IDS = {
  cover: pid(0x100),
  venue: pid(0x101),
  people: [pid(0x110), pid(0x111), pid(0x112), pid(0x113), pid(0x114), pid(0x115)],
  gallery: [pid(0x120), pid(0x121), pid(0x122), pid(0x123), pid(0x124), pid(0x125)],
} as const;

const PREVIEW_STARTER: Record<string, string> = {
  'tiptop-signature': 'agm-day-evening',
  'annual-letter': 'agm-day-evening',
  'boardroom-noir': 'agm-day-evening',
  'envelope-wax-seal': 'dinner-salon',
  'champagne-deco': 'holiday-party',
  'supper-club': 'dinner-salon',
  'monochrome-gallery': 'agm-day-evening',
  'cinematic-cover': 'holiday-party',
  'quantum-mesh': 'demo-day',
  'aurora-glow': 'demo-day',
  starfield: 'demo-day',
  'pixel-terminal': 'demo-day',
  'boarding-pass': 'agm-day-evening',
  'bento-summit': 'demo-day',
  blueprint: 'demo-day',
  'fairway-heritage': 'founder-golf',
  'pitch-putt-clubhouse': 'founder-golf',
  'hill-country-golden-hour': 'holiday-party',
  'botanical-garden-party': 'holiday-party',
  'winter-lodge': 'holiday-party',
  'neon-nightlife': 'holiday-party',
  'confetti-pop': 'holiday-party',
  'kinetic-poster': 'demo-day',
  'dither-editorial': 'demo-day',
  'liquid-glass': 'demo-day',
  'ferrofluid-chrome': 'demo-day',
  'riso-zine': 'holiday-party',
  'glyph-primitives': 'demo-day',
  coastal: 'holiday-party',
  'retro-synthwave': 'holiday-party',
  'memphis-playground': 'holiday-party',
  'polaroid-scrapbook': 'holiday-party',
  'holographic-foil': 'agm-day-evening',
};

/** The starter that shows a preset best. */
export function starterForPreset(preset: ThemePreset): string {
  return (
    PREVIEW_STARTER[preset.id] ??
    (preset.vibes.includes('golf') ? 'founder-golf' : 'agm-day-evening')
  );
}

const svgData = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

function coverArt(p: Palette, seed: number): string {
  const a = p.accent;
  const b = p.highlight;
  const c = mix(p.text, p.bg, 0.15);
  const d = mix(p.bg, p.accent, 0.25);
  const x = 30 + ((seed * 37) % 40);
  return svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100" viewBox="0 0 1600 1100"><defs><radialGradient id="g1" cx="${x}%" cy="30%" r="70%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${b}" stop-opacity="0"/></radialGradient><radialGradient id="g2" cx="80%" cy="85%" r="60%"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${d}"/></linearGradient></defs><rect width="1600" height="1100" fill="url(#bg)"/><rect width="1600" height="1100" fill="url(#g2)" opacity="0.85"/><rect width="1600" height="1100" fill="url(#g1)" opacity="0.7"/><g fill="none" stroke="${mix(b, '#ffffff', 0.4)}" stroke-opacity="0.35"><path d="M0 820 Q 400 700 800 800 T 1600 760"/><path d="M0 880 Q 420 760 800 860 T 1600 820"/><path d="M0 940 Q 440 820 800 920 T 1600 880"/></g><circle cx="${300 + seed * 90}" cy="380" r="160" fill="${mix(b, '#ffffff', 0.25)}" opacity="0.35"/></svg>`,
  );
}

function personArt(p: Palette, i: number): string {
  const tones = [
    p.accent,
    p.highlight,
    mix(p.accent, p.text, 0.4),
    mix(p.highlight, p.bg, 0.3),
    mix(p.accent, p.bg, 0.4),
    p.muted,
  ];
  const bg = tones[i % tones.length] ?? p.accent;
  const skin =
    ['#E8C4A8', '#C99772', '#8D5A3C', '#F1D3BD', '#B07B57', '#6E4630'][i % 6] ?? '#C99772';
  const shirt = mix(p.text, bg, 0.25);
  return svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(bg, '#ffffff', 0.25)}"/><stop offset="1" stop-color="${bg}"/></linearGradient></defs><rect width="600" height="600" fill="url(#b)"/><ellipse cx="300" cy="600" rx="230" ry="190" fill="${shirt}"/><rect x="262" y="330" width="76" height="90" rx="30" fill="${skin}"/><ellipse cx="300" cy="250" rx="98" ry="112" fill="${skin}"/><path d="M200 240 Q 210 128 300 126 Q 392 128 400 236 Q 360 176 300 182 Q 240 176 200 240 Z" fill="${mix(p.text, '#000000', 0.3)}"/></svg>`,
  );
}

function svgMedia(id: string, src: string, w: number, h: number, alt: string): ResolvedMedia {
  return {
    id,
    kind: 'image',
    width: w,
    height: h,
    alt,
    decorative: false,
    thumbhash: null,
    colors: [],
    variants: [],
    src,
    posterUrl: null,
    fileName: null,
    gated: false,
    status: 'ready',
  };
}

/** Abstract stand-ins for photos, tinted with the preset's palette. */
export function previewMedia(theme: EventTheme): MediaMap {
  const p = primaryPalette(theme);
  const map: MediaMap = {};
  map[PREVIEW_MEDIA_IDS.cover] = svgMedia(
    PREVIEW_MEDIA_IDS.cover,
    coverArt(p, 1),
    1600,
    1100,
    'An evening at the venue',
  );
  map[PREVIEW_MEDIA_IDS.venue] = svgMedia(
    PREVIEW_MEDIA_IDS.venue,
    coverArt(p, 3),
    1600,
    1100,
    'The venue',
  );
  PREVIEW_MEDIA_IDS.people.forEach((id, i) => {
    map[id] = svgMedia(id, personArt(p, i), 600, 600, 'Portrait');
  });
  PREVIEW_MEDIA_IDS.gallery.forEach((id, i) => {
    map[id] = svgMedia(id, coverArt(p, i + 2), 1600, 1100, 'Last year');
  });
  return map;
}

function withSampleMedia(template: SectionTemplate): SectionTemplate {
  const props = { ...template.props } as Record<string, unknown>;
  if (template.type === 'hero' && ['split', 'full_bleed', 'framed'].includes(template.variant)) {
    props.media = { mediaId: PREVIEW_MEDIA_IDS.cover };
  }
  if (template.type === 'hosts' && Array.isArray(props.people)) {
    props.people = (props.people as Record<string, unknown>[]).map((person, i) => ({
      ...person,
      photo: { mediaId: PREVIEW_MEDIA_IDS.people[i % PREVIEW_MEDIA_IDS.people.length] as string },
    }));
  }
  if (template.type === 'gallery') {
    props.images = PREVIEW_MEDIA_IDS.gallery
      .slice(0, 5)
      .map((id) => ({ media: { mediaId: id }, caption: '' }));
  }
  if (template.type === 'venue') props.photo = { mediaId: PREVIEW_MEDIA_IDS.venue };
  return { ...template, props: props as SectionTemplate['props'] };
}

export interface PreviewOptions {
  starterId?: string;
  mode?: 'light' | 'dark' | 'auto';
  /** Keep the preset's intro (default: removed so the page shows at once). */
  intro?: boolean;
  /** Apply the preset's preferred section layouts (default true). */
  presetLayouts?: boolean;
  now?: Date;
}

export interface PreviewPage {
  doc: EventDoc;
  facts: EventPublicFacts;
  media: MediaMap;
  rsvp: EventRsvpContext;
  starter: StarterDoc;
}

/** A complete, renderable page for a preset (fictional throughout). */
export function previewPage(presetId: string, options: PreviewOptions = {}): PreviewPage {
  const preset = getThemePreset(presetId);
  const starter = getStarter(options.starterId ?? starterForPreset(preset));
  const theme: Omit<EventTheme, 'rev' | 'keyRevs'> = structuredClone(preset.theme);
  if (options.mode) theme.mode = options.mode;
  if (!options.intro) theme.intro = { ...theme.intro, kind: 'none' };
  const variants = options.presetLayouts === false ? {} : presetVariants(preset.id);
  const counts = new Map<string, number>();
  for (const s of starter.sections) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  const templates = starter.sections.map((s) => {
    // A preset's preferred layout applies where the starter has one section of that kind.
    const preferred = counts.get(s.type) === 1 ? variants[s.type] : undefined;
    return withSampleMedia(preferred ? { ...s, variant: preferred } : s);
  });
  let n = 0;
  const doc = newEventDoc(theme, templates, () => pid(0x1000 + n++));

  const now = options.now ?? new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() + 34);
  start.setUTCHours(19, 0, 0, 0);
  const sessions: EventSessionPublic[] = (
    starter.sessions.length
      ? starter.sessions
      : [{ name: 'Main event', offsetMinutes: 0, durationMinutes: 180, capacity: null }]
  ).map((s, i) => ({
    id: pid(0x2000 + i),
    name: s.name,
    description: null,
    startsAt: new Date(start.getTime() + s.offsetMinutes * 60_000).toISOString(),
    endsAt: new Date(
      start.getTime() + (s.offsetMinutes + s.durationMinutes) * 60_000,
    ).toISOString(),
    venue: null,
    remaining: null,
    full: false,
    waitlistOpen: false,
    requiresApproval: starter.access === 'approval',
  }));
  const last = sessions[sessions.length - 1];
  const venue = {
    kind: 'in_person' as const,
    name: 'The Lantern Hall',
    address: '100 Example Avenue, Springfield',
    lat: null,
    lng: null,
    mapsUrl: null,
    onlineUrl: null,
    notes: null,
    revealRule: 'public' as const,
    revealed: true,
  };
  const facts: EventPublicFacts = {
    id: pid(0x3000),
    slug: `${starter.id}-preview`,
    title: starter.id === 'blank' ? 'Your event' : starter.name,
    status: 'published',
    visibility: starter.visibility,
    timeZone: 'America/Chicago',
    startsAt: sessions[0]?.startsAt ?? null,
    endsAt: last?.endsAt ?? null,
    venue,
    sessions,
    access: starter.access,
    registrationOpen: true,
    closesAt: null,
    cancelled: null,
    scheduleVersion: 1,
    publishedVersion: 1,
    ogImageUrl: null,
    path: `/e/${starter.id}-preview`,
  };
  const rsvp: EventRsvpContext = {
    endpoint: null,
    formToken: null,
    registration: {
      access: starter.access,
      open: true,
      closesAt: null,
      showRemaining: false,
      responseSet: {
        maybe: true,
        labels: { going: 'Going', maybe: 'Maybe', not_going: "Can't go" },
      },
      plusOnes: { max: 1, perSession: true, collectEmail: false, askQuestions: true },
      questions: [],
      sessions,
      requestInvite: starter.access === 'invite_only',
      guestWall: 'hidden',
      turnstileSiteKey: null,
    },
    viewer: PUBLIC_VIEWER,
    ticketPath: null,
  };
  return { doc, facts, media: previewMedia(doc.theme), rsvp, starter };
}
