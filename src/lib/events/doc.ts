import { keysBetween } from './fractional';
import {
  BLOCK_VARIANTS,
  EVENT_DOC_SCHEMA_VERSION,
  defaultPageMeta,
  defaultSectionMotion,
  defaultSectionStyle,
  defaultVisibility,
  type BlockType,
  type EventDoc,
  type EventSection,
  type EventTheme,
  type SectionProps,
} from './schema';

/**
 * Building new documents and sections: createEvent (WS1), starters (WS2)
 * and Studio's "Add section" (WS3) all go through these, so a new section
 * always has every field the schema requires. Pure and isomorphic.
 */

/** A section as a starter or the block gallery describes it: no id, position or revs. */
export type SectionTemplate = Omit<EventSection, 'id' | 'position' | 'rev' | 'keyRevs'>;

/** A blank section of a type: the type's first variant, the given props (block defaults come from WS2's registry). */
export function sectionTemplate(
  type: BlockType,
  props: SectionProps = {},
  variant?: string,
): SectionTemplate {
  return {
    type,
    variant: variant ?? BLOCK_VARIANTS[type][0],
    name: '',
    props,
    style: defaultSectionStyle(),
    motion: defaultSectionMotion(),
    visibility: defaultVisibility(),
  };
}

/** Place a template: give it an id and a position; revs start at `rev`. */
export function placeSection(
  template: SectionTemplate,
  id: string,
  position: string,
  rev = 0,
): EventSection {
  return { ...structuredClone(template), id, position, rev, keyRevs: {} };
}

/** A theme preset's tokens as a document theme (merge bookkeeping zeroed). */
export function themeWithRevs(theme: Omit<EventTheme, 'rev' | 'keyRevs'>): EventTheme {
  return { ...structuredClone(theme), rev: 0, keyRevs: {} };
}

/** A whole new document from a theme and section templates, in order. */
export function newEventDoc(
  theme: Omit<EventTheme, 'rev' | 'keyRevs'>,
  templates: readonly SectionTemplate[],
  makeId: () => string,
): EventDoc {
  const positions = templates.length ? keysBetween(null, null, templates.length) : [];
  return {
    schemaVersion: EVENT_DOC_SCHEMA_VERSION,
    theme: themeWithRevs(theme),
    sections: templates.map((t, i) => placeSection(t, makeId(), positions[i]!)),
    meta: defaultPageMeta(),
  };
}
