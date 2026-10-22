import type { EventPublicFacts } from '@/lib/events/contracts';
import {
  orderedSections,
  type EventDoc,
  type EventSection,
  type Palette,
} from '@/lib/events/schema';
import { checkPalette } from './contrast';

/**
 * The Publish dialog's two halves (owners): the section-level diff since the
 * last publish, with who made each change, and the Ready checklist. Missing
 * alt text blocks publishing; every other check warns and the owner may
 * override. Pure.
 */

export type DiffKind = 'added' | 'removed' | 'changed' | 'moved';

export interface DiffItem {
  /** Section id, or 'theme' / 'meta'. */
  id: string;
  label: string;
  kind: DiffKind;
  /** Readable field names: "headline", "background". */
  fields: string[];
}

/** 'props.headline' → 'headline'; 'style' → 'style'. */
export function fieldName(key: string): string {
  const bare = key.startsWith('props.') ? key.slice(6) : key;
  return bare
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changedFields(before: EventSection, after: EventSection): string[] {
  const fields: string[] = [];
  for (const key of ['variant', 'name', 'style', 'motion', 'visibility'] as const) {
    if (!same(before[key], after[key])) fields.push(key === 'variant' ? 'layout' : key);
  }
  const keys = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
  for (const key of keys)
    if (!same(before.props[key], after.props[key])) fields.push(fieldName(key));
  return fields;
}

const THEME_FIELDS = [
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
] as const;

/**
 * What changed between the published page and the draft, section by
 * section, in page order. `labelOf` names a section ("Hero", "Agenda").
 */
export function publishDiff(
  published: EventDoc | null,
  draft: EventDoc,
  labelOf: (section: EventSection) => string,
): DiffItem[] {
  const items: DiffItem[] = [];
  const before = new Map((published?.sections ?? []).map((s) => [s.id, s]));
  const beforeOrder = orderedSections(published?.sections ?? []).map((s) => s.id);
  const afterOrdered = orderedSections(draft.sections);
  const afterOrder = afterOrdered.map((s) => s.id).filter((id) => before.has(id));
  const keptBefore = beforeOrder.filter((id) => draft.sections.some((s) => s.id === id));

  for (const section of afterOrdered) {
    const old = before.get(section.id);
    if (!old) {
      items.push({ id: section.id, label: labelOf(section), kind: 'added', fields: [] });
      continue;
    }
    const fields = changedFields(old, section);
    if (fields.length) {
      items.push({ id: section.id, label: labelOf(section), kind: 'changed', fields });
    } else if (keptBefore.indexOf(section.id) !== afterOrder.indexOf(section.id)) {
      items.push({ id: section.id, label: labelOf(section), kind: 'moved', fields: [] });
    }
  }
  for (const old of orderedSections(published?.sections ?? [])) {
    if (!draft.sections.some((s) => s.id === old.id)) {
      items.push({ id: old.id, label: labelOf(old), kind: 'removed', fields: [] });
    }
  }
  if (published) {
    const themeFields = THEME_FIELDS.filter((k) => !same(published.theme[k], draft.theme[k])).map(
      fieldName,
    );
    if (themeFields.length)
      items.push({ id: 'theme', label: 'Theme', kind: 'changed', fields: themeFields });
    const metaFields = (['seoTitle', 'seoDescription', 'ogLayout', 'faviconFromLogo'] as const)
      .filter((k) => !same(published.meta[k], draft.meta[k]))
      .map(fieldName);
    if (metaFields.length) {
      items.push({ id: 'meta', label: 'Page settings', kind: 'changed', fields: metaFields });
    }
  }
  return items;
}

/** "Hero – headline, background", "Agenda – added". */
export function diffLine(item: DiffItem): string {
  if (item.kind === 'changed') return `${item.label} – ${item.fields.slice(0, 4).join(', ')}`;
  return `${item.label} – ${item.kind}`;
}

/* -------------------------------------------------------------- checklist */

export interface ChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  /** Blocks publishing (missing alt text); the rest only warn. */
  blocking: boolean;
  detail: string | null;
}

/** What Studio knows about one media item (from the media library). */
export interface StudioMediaItem {
  id: string;
  kind: 'image' | 'video' | 'logo' | 'file';
  status: 'uploaded' | 'ready' | 'failed';
  alt: string | null;
  decorative: boolean;
  name: string | null;
  colors: string[];
  previewUrl: string | null;
}

/** Every media id a document references (hero, backgrounds, galleries, logos…). */
export function mediaIdsInDoc(doc: EventDoc): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    } else if (typeof value === 'string' && /mediaId$/.test(key)) ids.add(value);
  };
  walk(doc);
  return [...ids];
}

/** Blocks whose content comes from the host's words (not from settings). */
const CONTENT_BLOCKS = new Set([
  'text',
  'faq',
  'gallery',
  'hosts',
  'sponsors',
  'materials',
  'buttons',
  'stats',
  'media',
  'embed',
  'info_cards',
]);

function emptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0 || value.every(emptyValue);
  if (typeof value === 'object') return Object.values(value as object).every(emptyValue);
  return false;
}

export function isEmptySection(section: EventSection): boolean {
  if (!CONTENT_BLOCKS.has(section.type)) return false;
  return Object.values(section.props).every(emptyValue);
}

export function readyChecklist(input: {
  doc: EventDoc;
  facts: EventPublicFacts;
  media: readonly StudioMediaItem[];
  labelOf: (section: EventSection) => string;
}): ChecklistItem[] {
  const { doc, facts } = input;
  const venue = facts.venue;
  const hasPlace = Boolean(
    venue && (venue.name || venue.address || venue.onlineUrl || venue.kind === 'online'),
  );
  const missingAlt = mediaIdsInDoc(doc)
    .map((id) => input.media.find((m) => m.id === id))
    .filter(
      (m): m is StudioMediaItem =>
        !!m && (m.kind === 'image' || m.kind === 'logo') && !m.decorative && !m.alt?.trim(),
    );
  const palettes: { name: string; palette: Palette }[] = [
    { name: 'light', palette: doc.theme.palette },
  ];
  if (doc.theme.mode !== 'light') palettes.push({ name: 'dark', palette: doc.theme.paletteDark });
  const failing = palettes.flatMap(({ name, palette }) =>
    checkPalette(palette)
      .filter((p) => p.ratio < 4.5)
      .map((p) => `${p.label} (${name}, ${p.ratio.toFixed(1)}:1)`),
  );
  const empty = doc.sections.filter(isEmptySection);
  const hasRsvp = doc.sections.some((s) => s.type === 'rsvp' && s.visibility.mode !== 'hidden');
  return [
    {
      id: 'basics',
      label: 'Title, date, and a venue or online link',
      ok: Boolean(facts.title && facts.startsAt && hasPlace),
      blocking: false,
      detail: !facts.startsAt
        ? 'Add a date in Settings.'
        : !hasPlace
          ? 'Add a venue or an online link in Settings.'
          : null,
    },
    {
      id: 'rsvp',
      label: 'An RSVP section while registration is on',
      ok: !facts.registrationOpen || hasRsvp,
      blocking: false,
      detail:
        facts.registrationOpen && !hasRsvp ? 'Add an RSVP section so guests can reply.' : null,
    },
    {
      id: 'alt',
      label: 'Alt text on every image that is not decorative',
      ok: missingAlt.length === 0,
      blocking: true,
      detail: missingAlt.length
        ? `${missingAlt.length} image${missingAlt.length === 1 ? '' : 's'} need alt text (Media tab).`
        : null,
    },
    {
      id: 'contrast',
      label: 'AA contrast on every text and background pair',
      ok: failing.length === 0,
      blocking: false,
      detail: failing.length ? failing.slice(0, 3).join('; ') : null,
    },
    {
      id: 'empty',
      label: 'No empty sections',
      ok: empty.length === 0,
      blocking: false,
      detail: empty.length ? empty.map(input.labelOf).slice(0, 4).join(', ') : null,
    },
    {
      id: 'slug',
      label: 'The page link is set',
      ok: Boolean(facts.slug),
      blocking: false,
      detail: facts.slug ? facts.path : null,
    },
    {
      id: 'og',
      label: 'Share card renders',
      ok: true,
      blocking: false,
      detail: 'Rendered from the theme when you publish.',
    },
  ];
}
