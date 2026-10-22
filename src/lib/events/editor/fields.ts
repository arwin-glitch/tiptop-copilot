import type { BlockDefinition, BlockRegistry, FieldDescriptor } from '@/lib/events/contracts';
import type { BlockType, EventSection, JsonValue, SectionProps } from '@/lib/events/schema';

/**
 * The inspector's Content form comes from the block registry's field
 * descriptors (WS2). Until a block has descriptors, Studio falls back to a
 * short list per common block and to fields inferred from the props a
 * section already holds, so every section stays editable. Pure.
 */

const text = (key: string, label: string, inline = false, max = 200): FieldDescriptor => ({
  key,
  label,
  kind: 'text',
  inline,
  max,
});
const rich = (key: string, label: string): FieldDescriptor => ({
  key,
  label,
  kind: 'richtext',
  max: 20_000,
});

/** Used only while the registry has no descriptors for a block. */
const FALLBACK_FIELDS: Partial<Record<BlockType, FieldDescriptor[]>> = {
  hero: [
    text('headline', 'Headline', true, 140),
    text('subheadline', 'Subheadline', true, 280),
    { key: 'mediaId', label: 'Cover photo or video', kind: 'media' },
  ],
  text: [text('heading', 'Heading', true), rich('body', 'Text')],
  agenda: [
    text('heading', 'Heading', true),
    {
      key: 'items',
      label: 'Agenda items',
      kind: 'list',
      maxItems: 40,
      itemFields: [text('time', 'Time', false, 40), text('title', 'What happens', false, 200)],
    },
  ],
  faq: [
    text('heading', 'Heading', true),
    {
      key: 'items',
      label: 'Questions',
      kind: 'list',
      maxItems: 40,
      itemFields: [text('q', 'Question', false, 200), rich('a', 'Answer')],
    },
  ],
  hosts: [
    text('heading', 'Heading', true),
    {
      key: 'people',
      label: 'People',
      kind: 'list',
      maxItems: 40,
      itemFields: [
        text('name', 'Name', false, 120),
        text('title', 'Title', false, 120),
        text('company', 'Company', false, 120),
        { key: 'mediaId', label: 'Photo', kind: 'media' },
      ],
    },
  ],
  sponsors: [
    text('heading', 'Heading', true),
    {
      key: 'logos',
      label: 'Logos',
      kind: 'list',
      maxItems: 60,
      itemFields: [
        text('name', 'Name', false, 120),
        { key: 'mediaId', label: 'Logo', kind: 'media' },
        { key: 'href', label: 'Link', kind: 'link' },
      ],
    },
  ],
  rsvp: [
    text('cta', 'Button label', true, 60),
    text('going', 'Going label', false, 40),
    text('maybe', 'Maybe label', false, 40),
    text('notGoing', "Can't go label", false, 40),
  ],
  buttons: [
    {
      key: 'buttons',
      label: 'Buttons',
      kind: 'list',
      maxItems: 6,
      itemFields: [text('label', 'Label', false, 60), { key: 'href', label: 'Link', kind: 'link' }],
    },
  ],
  stats: [text('quote', 'Quote', true, 400), text('attribution', 'Attribution', false, 120)],
  media: [
    { key: 'mediaId', label: 'Photo or video', kind: 'media' },
    text('caption', 'Caption', true, 200),
  ],
  gallery: [
    text('heading', 'Heading', true),
    {
      key: 'images',
      label: 'Photos',
      kind: 'list',
      maxItems: 60,
      itemFields: [{ key: 'mediaId', label: 'Photo', kind: 'media' }, text('caption', 'Caption')],
    },
  ],
  materials: [
    text('heading', 'Heading', true),
    {
      key: 'files',
      label: 'Files and links',
      kind: 'list',
      maxItems: 30,
      itemFields: [
        text('title', 'Title', false, 120),
        { key: 'href', label: 'Link', kind: 'link' },
        { key: 'mediaId', label: 'File', kind: 'media' },
      ],
    },
  ],
  venue: [text('heading', 'Heading', true), rich('notes', 'Notes')],
  countdown: [text('heading', 'Heading', true)],
  details: [text('dressCode', 'Dress code', false, 120)],
  footer: [text('note', 'Footer note', true, 200)],
};

const LINK_KEY = /(href|url|link)$/i;
const MEDIA_KEY = /mediaId$/i;
const LONG_KEY = /^(body|text|description|answer|a|bio|notes?|copy|message)$/i;
const INLINE_KEY = /^(headline|heading|title|subheadline|subtitle|cta|label|caption|quote)$/i;

function labelFor(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function inferOne(key: string, value: JsonValue | undefined): FieldDescriptor | null {
  if (MEDIA_KEY.test(key)) return { key, label: labelFor(key.replace(/Id$/, '')), kind: 'media' };
  if (typeof value === 'string' || value === null || value === undefined) {
    if (LINK_KEY.test(key)) return { key, label: labelFor(key), kind: 'link' };
    if (
      LONG_KEY.test(key) ||
      (typeof value === 'string' && (value.length > 120 || value.includes('\n')))
    ) {
      return rich(key, labelFor(key));
    }
    return text(key, labelFor(key), INLINE_KEY.test(key), 400);
  }
  if (typeof value === 'number') return { key, label: labelFor(key), kind: 'number' };
  if (typeof value === 'boolean') return { key, label: labelFor(key), kind: 'toggle' };
  if (Array.isArray(value)) {
    const objects = value.filter(
      (v): v is Record<string, JsonValue> => !!v && typeof v === 'object' && !Array.isArray(v),
    );
    if (!objects.length && value.length) return null;
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
    const itemFields = keys
      .map((k) => inferOne(k, objects.find((o) => k in o)?.[k]))
      .filter((f): f is FieldDescriptor => f !== null && f.kind !== 'list');
    return {
      key,
      label: labelFor(key),
      kind: 'list',
      maxItems: 60,
      itemFields: itemFields.length ? itemFields : [text('title', 'Title')],
    };
  }
  if (typeof value === 'object' && 'mediaId' in value) {
    return { key, label: labelFor(key), kind: 'media' };
  }
  return null;
}

/** Fields inferred from the props a section holds (keys the descriptor list lacks). */
export function inferFields(props: SectionProps, known: readonly string[] = []): FieldDescriptor[] {
  return Object.entries(props)
    .filter(([key]) => !known.includes(key))
    .map(([key, value]) => inferOne(key, value))
    .filter((f): f is FieldDescriptor => f !== null);
}

/** The Content form for one section. */
export function fieldsFor(
  definition: BlockDefinition | undefined,
  section: Pick<EventSection, 'type' | 'props'>,
): { fields: FieldDescriptor[]; fromRegistry: boolean } {
  if (definition && definition.fields.length)
    return { fields: definition.fields, fromRegistry: true };
  const base = FALLBACK_FIELDS[section.type] ?? [];
  return {
    fields: [
      ...base,
      ...inferFields(
        section.props,
        base.map((f) => f.key),
      ),
    ],
    fromRegistry: false,
  };
}

/** The outline's name for a section: its own name, else the block's label. */
export function sectionLabel(
  section: Pick<EventSection, 'name' | 'type'>,
  registry: Pick<BlockRegistry, 'get'>,
): string {
  if (section.name.trim()) return section.name.trim();
  const label = registry.get(section.type)?.label;
  if (label) return label;
  const words = section.type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One line for the outline: the block's own summary, else its label. */
export function sectionSummary(
  section: EventSection,
  registry: Pick<BlockRegistry, 'get'>,
): string {
  try {
    return registry.get(section.type)?.summary(section.props) ?? sectionLabel(section, registry);
  } catch {
    return sectionLabel(section, registry);
  }
}

/** An empty value for a field kind (adding a list item, a new field). */
export function emptyFor(field: FieldDescriptor): JsonValue {
  switch (field.kind) {
    case 'list':
      return [];
    case 'toggle':
      return false;
    case 'number':
      return 0;
    case 'media':
    case 'person':
      return null;
    default:
      return '';
  }
}
