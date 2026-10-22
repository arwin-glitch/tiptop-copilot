import type { BlockDefinition, FieldDescriptor } from '@/lib/events/contracts';
import { BLOCK_VARIANTS, type BlockType, type SectionProps } from '@/lib/events/schema';
import {
  EMBED_PROVIDERS,
  HERO_FRAMES,
  INFO_ICONS,
  MATERIAL_KINDS,
  MEDIA_ASPECTS,
  SPONSOR_TIERS,
  TEXT_POSITIONS,
} from './props';

/**
 * Block definitions for Studio (D-075, WS2): label, description, defaults,
 * inspector fields and the one-line summary the outline and the publish diff
 * show. WS3 generates the inspector from `fields`; `inline` fields are
 * edited on the canvas (plain text only); `ownerOnly` fields are locked for
 * outside editors.
 */

const opts = (values: readonly string[], label: (v: string) => string = humanize) =>
  values.map((value) => ({ value, label: label(value) }));

function humanize(value: string): string {
  const words = value.replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const t = (
  key: string,
  label: string,
  max: number,
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
  key,
  label,
  kind: 'text',
  max,
  ...extra,
});
const rich = (key: string, label: string, max: number, help?: string): FieldDescriptor => ({
  key,
  label,
  kind: 'richtext',
  max,
  help: help ?? 'Bold, italic, links, lists, ## headings and {{first_name|friend}} work here.',
});
const toggle = (key: string, label: string, help?: string): FieldDescriptor => ({
  key,
  label,
  kind: 'toggle',
  ...(help ? { help } : {}),
});
const media = (key: string, label: string, help?: string): FieldDescriptor => ({
  key,
  label,
  kind: 'media',
  ...(help ? { help } : {}),
});
const link = (
  key: string,
  label: string,
  extra: Partial<FieldDescriptor> = {},
): FieldDescriptor => ({
  key,
  label,
  kind: 'link',
  help: 'https://…, http://… or mailto:…',
  ...extra,
});
const select = (key: string, label: string, values: readonly string[]): FieldDescriptor => ({
  key,
  label,
  kind: 'select',
  options: opts(values),
});

function count(props: SectionProps, key: string): number {
  const v = props[key];
  return Array.isArray(v) ? v.length : 0;
}

function str(props: SectionProps, key: string): string {
  const v = props[key];
  return typeof v === 'string' ? v.trim() : '';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function withHeading(label: string, props: SectionProps, rest?: string): string {
  const heading = str(props, 'heading');
  const head = heading ? `${label}: ${heading}` : label;
  return rest ? `${head} – ${rest}` : head;
}

const def = (d: Omit<BlockDefinition, 'variants'> & { type: BlockType }): BlockDefinition => ({
  ...d,
  variants: BLOCK_VARIANTS[d.type],
});

export const BLOCK_DEFINITIONS: Record<BlockType, BlockDefinition> = {
  hero: def({
    type: 'hero',
    label: 'Cover',
    description: 'The first thing guests see: title, date, a photo or video, and the main button.',
    defaults: () => ({
      variant: 'centered',
      props: {
        eyebrow: '',
        headline: '',
        subheadline: '',
        showDate: true,
        showVenue: true,
        ctaLabel: 'RSVP',
        ctaTarget: 'rsvp',
      },
    }),
    fields: [
      t('eyebrow', 'Small line above the title', 80, { inline: true }),
      t('headline', 'Title', 160, {
        inline: true,
        help: 'Empty uses the event name. {{first_name|friend}} personalises it on invite links.',
      }),
      t('subheadline', 'Subtitle', 400, { inline: true }),
      media('media', 'Cover photo or video', 'Used by the split, full-bleed and framed layouts.'),
      select('frame', 'Photo frame', HERO_FRAMES),
      select('textPosition', 'Text position', TEXT_POSITIONS),
      { key: 'scrim', label: 'Darken the photo behind text', kind: 'number', help: '0 to 0.8' },
      toggle('showDate', 'Show the date'),
      toggle('showVenue', 'Show the venue'),
      toggle('showLogo', 'Show the host logo'),
      t('ctaLabel', 'Button label', 40, { inline: true }),
      select('ctaTarget', 'Button goes to', ['rsvp', 'link', 'none']),
      link('ctaHref', 'Button link'),
    ],
    summary: (p) => `Cover${str(p, 'headline') ? `: ${str(p, 'headline')}` : ''}`,
  }),
  details: def({
    type: 'details',
    label: 'Key details',
    description: 'Date, time, venue and anything else guests need at a glance.',
    defaults: () => ({
      variant: 'chips',
      props: { showDate: true, showTime: true, showVenue: true, showTimezone: true, items: [] },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      toggle('showDate', 'Date'),
      toggle('showTime', 'Time'),
      toggle('showVenue', 'Venue'),
      toggle('showTimezone', 'Show "your time" when the guest is elsewhere'),
      toggle('showAccess', 'Show who can come (By invitation, Approval…)'),
      {
        key: 'items',
        label: 'More details',
        kind: 'list',
        maxItems: 6,
        itemFields: [t('label', 'Label', 40), t('value', 'Value', 120)],
        help: 'Dress code, parking, what to bring…',
      },
    ],
    summary: (p) =>
      withHeading(
        'Key details',
        p,
        count(p, 'items') ? plural(count(p, 'items'), 'extra') : undefined,
      ),
  }),
  rsvp: def({
    type: 'rsvp',
    label: 'RSVP',
    description:
      'The registration card. Sessions, questions and plus-ones come from the Registration tab.',
    defaults: () => ({
      variant: 'inline',
      props: {
        heading: 'Will you join us?',
        body: '',
        cta: 'RSVP',
        going: 'Going',
        maybe: 'Maybe',
        notGoing: "Can't go",
      },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      rich('body', 'Note above the form', 2000),
      t('cta', 'Button label', 40, { inline: true }),
      t('going', '"Going" label', 40),
      t('maybe', '"Maybe" label', 40),
      t('notGoing', '"Can\'t go" label', 40),
      t('note', 'Small print under the form', 200),
    ],
    summary: (p) => withHeading('RSVP', p),
  }),
  agenda: def({
    type: 'agenda',
    label: 'Agenda',
    description: 'The run of show. Items can follow a session, so they show only to its guests.',
    defaults: () => ({
      variant: 'timeline',
      props: { heading: 'Agenda', intro: '', columnA: 'Afternoon', columnB: 'Evening', items: [] },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      t('intro', 'Intro', 1000),
      t('columnA', 'Left column title (two columns)', 40),
      t('columnB', 'Right column title (two columns)', 40),
      {
        key: 'items',
        label: 'Items',
        kind: 'list',
        maxItems: 60,
        itemFields: [
          t('time', 'Time', 24),
          t('endTime', 'Ends', 24),
          t('title', 'Title', 140),
          t('description', 'Description', 600),
          t('speaker', 'Speaker', 120),
          {
            key: 'sessionId',
            label: 'Session',
            kind: 'select',
            help: 'Follows that session: only its guests see this item.',
          },
          select('column', 'Column (two columns)', ['a', 'b']),
          t('day', 'Day tab', 40),
          t('track', 'Track (bento)', 40),
          { key: 'hole', label: 'Hole (scorecard)', kind: 'number' },
        ],
      },
    ],
    summary: (p) => withHeading('Agenda', p, plural(count(p, 'items'), 'item')),
  }),
  text: def({
    type: 'text',
    label: 'Text',
    description: 'A letter, a welcome or any story, with headings, lists and links.',
    defaults: () => ({ variant: 'single', props: { eyebrow: '', heading: '', body: '' } }),
    fields: [
      t('eyebrow', 'Small line above', 80, { inline: true }),
      t('heading', 'Heading', 160, { inline: true }),
      rich('body', 'Text', 20000),
    ],
    summary: (p) => withHeading('Text', p),
  }),
  hosts: def({
    type: 'hosts',
    label: 'Hosts & speakers',
    description: 'People from Network or CRM records, or typed in.',
    defaults: () => ({ variant: 'grid', props: { heading: 'Hosts', intro: '', people: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      t('intro', 'Intro', 600),
      {
        key: 'people',
        label: 'People',
        kind: 'list',
        maxItems: 48,
        itemFields: [
          { key: 'recordId', label: 'Pick from Copilot', kind: 'person' },
          t('name', 'Name', 80),
          t('title', 'Title', 80),
          t('company', 'Company', 80),
          media('photo', 'Photo'),
          link('href', 'Link'),
          t('bio', 'Short bio', 400),
          t('stat', 'Score or stat (leaderboard)', 24),
        ],
      },
    ],
    summary: (p) => withHeading('Hosts', p, plural(count(p, 'people'), 'person', 'people')),
  }),
  sponsors: def({
    type: 'sponsors',
    label: 'Sponsors & co-hosts',
    description: 'Tiered logo wall, a marquee, a co-host lockup or hole sponsors.',
    defaults: () => ({
      variant: 'tiers',
      props: { heading: 'With thanks to', intro: '', items: [] },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      t('intro', 'Intro', 600),
      {
        key: 'items',
        label: 'Sponsors',
        kind: 'list',
        maxItems: 60,
        itemFields: [
          t('name', 'Name', 80),
          media('logo', 'Logo'),
          link('href', 'Link'),
          select('tier', 'Tier', SPONSOR_TIERS),
          { key: 'hole', label: 'Hole (golf)', kind: 'number' },
          t('note', 'Note', 80),
        ],
      },
    ],
    summary: (p) => withHeading('Sponsors', p, plural(count(p, 'items'), 'logo')),
  }),
  venue: def({
    type: 'venue',
    label: 'Venue & map',
    description:
      'The location card with directions. The address follows the reveal rule in Registration.',
    defaults: () => ({
      variant: 'card',
      props: { heading: 'Getting there', notes: '', showDirections: true, showMap: false },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      rich('notes', 'Notes', 2000),
      t('parking', 'Parking', 400),
      t('arrival', 'On arrival', 400),
      media('photo', 'Photo of the venue'),
      toggle('showDirections', 'Google and Apple Maps directions'),
      toggle('showMap', 'Map (loads only when the guest taps it)'),
    ],
    summary: (p) => withHeading('Venue', p),
  }),
  countdown: def({
    type: 'countdown',
    label: 'Countdown',
    description:
      'Counts down in the venue time zone, then says "Happening now" and "Thanks for coming".',
    defaults: () => ({
      variant: 'minimal',
      props: {
        heading: '',
        target: 'event',
        liveLabel: 'Happening now',
        endedLabel: 'Thanks for coming',
      },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      { key: 'target', label: 'Counts to', kind: 'select', help: 'The event, or one session.' },
      t('liveLabel', 'While it is on', 80),
      t('endedLabel', 'After it ends', 80),
    ],
    summary: (p) => withHeading('Countdown', p),
  }),
  faq: def({
    type: 'faq',
    label: 'FAQ',
    description: 'Questions and answers that open on tap.',
    defaults: () => ({ variant: 'accordion', props: { heading: 'Questions', items: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      {
        key: 'items',
        label: 'Questions',
        kind: 'list',
        maxItems: 40,
        itemFields: [t('q', 'Question', 200), rich('a', 'Answer', 2000)],
      },
    ],
    summary: (p) => withHeading('FAQ', p, plural(count(p, 'items'), 'question')),
  }),
  gallery: def({
    type: 'gallery',
    label: 'Gallery',
    description: 'Photos as a grid, a carousel, masonry or scattered polaroids.',
    defaults: () => ({ variant: 'grid', props: { heading: '', images: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      {
        key: 'images',
        label: 'Photos',
        kind: 'list',
        maxItems: 60,
        itemFields: [media('media', 'Photo'), t('caption', 'Caption', 200)],
      },
    ],
    summary: (p) => withHeading('Gallery', p, plural(count(p, 'images'), 'photo')),
  }),
  media: def({
    type: 'media',
    label: 'Photo or video',
    description: 'One large photo or a muted video loop (with a poster).',
    defaults: () => ({ variant: 'image', props: { media: null, caption: '', aspect: 'auto' } }),
    fields: [
      media('media', 'Photo or video'),
      media('poster', 'Video poster', 'Shown before the video plays and in Low Power Mode.'),
      t('caption', 'Caption', 300, { inline: true }),
      select('aspect', 'Shape', MEDIA_ASPECTS),
      toggle('autoplay', 'Play the video on its own (muted)'),
    ],
    summary: (p) => `Media${str(p, 'caption') ? `: ${str(p, 'caption')}` : ''}`,
  }),
  stats: def({
    type: 'stats',
    label: 'Quote & stats',
    description: 'A pull quote, or a row of numbers that count up.',
    defaults: () => ({ variant: 'stats', props: { heading: '', stats: [], countUp: true } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      t('quote', 'Quote', 600, { inline: true }),
      t('attribution', 'Who said it', 80),
      t('role', 'Their role', 120),
      media('photo', 'Their photo'),
      {
        key: 'stats',
        label: 'Numbers',
        kind: 'list',
        maxItems: 8,
        itemFields: [
          t('prefix', 'Before', 8),
          t('value', 'Number', 24),
          t('suffix', 'After', 8),
          t('label', 'Label', 80),
        ],
      },
      toggle('countUp', 'Count up when they come into view'),
    ],
    summary: (p) =>
      str(p, 'quote')
        ? `Quote: ${str(p, 'quote').slice(0, 40)}`
        : withHeading('Stats', p, plural(count(p, 'stats'), 'number')),
  }),
  materials: def({
    type: 'materials',
    label: 'Materials',
    description:
      'Pre-reads, decks and links for qualifying guests. Set who sees it in the section visibility.',
    defaults: () => ({ variant: 'list', props: { heading: 'Materials', intro: '', items: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      t('intro', 'Intro', 1000),
      {
        key: 'items',
        label: 'Files and links',
        kind: 'list',
        maxItems: 30,
        ownerOnly: true,
        help: 'Files are served as short-lived private links, only to guests who qualify.',
        itemFields: [
          t('title', 'Title', 140),
          t('description', 'Description', 400),
          media('file', 'File'),
          link('href', 'Or a link (DocSend, Drive…)'),
          select('kind', 'Kind', MATERIAL_KINDS),
        ],
      },
    ],
    summary: (p) => withHeading('Materials', p, plural(count(p, 'items'), 'item')),
  }),
  buttons: def({
    type: 'buttons',
    label: 'Buttons',
    description: 'A row of up to six buttons.',
    defaults: () => ({ variant: 'row', props: { heading: '', items: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      {
        key: 'items',
        label: 'Buttons',
        kind: 'list',
        maxItems: 6,
        itemFields: [
          t('label', 'Label', 40),
          link('href', 'Link'),
          select('style', 'Style', ['primary', 'secondary', 'ghost']),
        ],
      },
    ],
    summary: (p) => `Buttons – ${plural(count(p, 'items'), 'button')}`,
  }),
  divider: def({
    type: 'divider',
    label: 'Divider',
    description: 'A rule, an ornament or a breathing space between sections.',
    defaults: () => ({ variant: 'line', props: { size: 'm' } }),
    fields: [select('size', 'Size', ['s', 'm', 'l'])],
    summary: () => 'Divider',
  }),
  footer: def({
    type: 'footer',
    label: 'Footer',
    description: 'A closing line, links and an optional "Contact the host".',
    defaults: () => ({
      variant: 'simple',
      props: {
        text: '',
        contactLabel: 'Contact the host',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
    }),
    fields: [
      t('text', 'Closing line', 400, { inline: true }),
      t('contactLabel', 'Contact label', 40),
      link('contactHref', 'Contact link', { help: 'mailto:you@example.com or a web address.' }),
      {
        key: 'links',
        label: 'Links',
        kind: 'list',
        maxItems: 8,
        itemFields: [t('label', 'Label', 40), link('href', 'Link')],
      },
      toggle('showMadeWith', 'Show a small "Made with TipTop" mark'),
    ],
    summary: () => 'Footer',
  }),
  embed: def({
    type: 'embed',
    label: 'Embed',
    description: 'A YouTube, Vimeo, Loom, Spotify or Google Maps embed that loads on tap.',
    defaults: () => ({ variant: 'inline', props: { provider: 'youtube', embedId: '', title: '' } }),
    fields: [
      select('provider', 'From', EMBED_PROVIDERS),
      t('embedId', 'Video, playlist or place', 120, {
        help: 'Paste the link; Studio keeps only its id.',
      }),
      t('title', 'Title', 120),
      t('caption', 'Caption', 200),
    ],
    summary: (p) => `Embed${str(p, 'title') ? `: ${str(p, 'title')}` : ''}`,
  }),
  guest_wall: def({
    type: 'guest_wall',
    label: 'Guest wall',
    description:
      'Who is going, as the Registration tab allows (hidden for invite-only by default).',
    defaults: () => ({ variant: 'avatars', props: { heading: "Who's going", note: '' } }),
    fields: [t('heading', 'Heading', 120, { inline: true }), t('note', 'Note', 200)],
    summary: (p) => withHeading('Guest wall', p),
  }),
  join_remote: def({
    type: 'join_remote',
    label: 'Join remotely',
    description: 'A video-call link for remote guests (set visibility to the Remote tag).',
    defaults: () => ({
      variant: 'card',
      props: { heading: 'Joining remotely', body: '', label: 'Join the call' },
    }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      rich('body', 'Note', 2000),
      t('label', 'Button label', 40),
      link('href', 'Call link', { ownerOnly: true }),
      link('replayHref', 'Replay link (after the event)', { ownerOnly: true }),
    ],
    summary: (p) => withHeading('Join remotely', p),
  }),
  info_cards: def({
    type: 'info_cards',
    label: 'Info cards',
    description: 'Dress code, travel, hotels: small cards with an icon.',
    defaults: () => ({ variant: 'dress_code', props: { heading: '', items: [] } }),
    fields: [
      t('heading', 'Heading', 120, { inline: true }),
      {
        key: 'items',
        label: 'Cards',
        kind: 'list',
        maxItems: 8,
        itemFields: [
          t('title', 'Title', 80),
          rich('body', 'Text', 800),
          select('icon', 'Icon', INFO_ICONS),
        ],
      },
    ],
    summary: (p) => withHeading('Info', p, plural(count(p, 'items'), 'card')),
  }),
};

/** Props keys outside editors may never set (capabilities.ts editOwnerOnlyProps). */
export const OWNER_ONLY_PROPS: Partial<Record<BlockType, readonly string[]>> = {
  materials: ['items'],
  join_remote: ['href', 'replayHref'],
};
