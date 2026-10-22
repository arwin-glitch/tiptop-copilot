import {
  META_KEYS,
  THEME_KEYS,
  orderedSections,
  type BlockType,
  type EventDoc,
  type EventSection,
  type MetaKey,
  type ThemeKey,
} from './schema';

/**
 * Section-level differences between two page documents (D-075): the Publish
 * dialog ("Hero – headline, background · Agenda – 2 items"), each version's
 * line in the History drawer, and the activity rows a restore writes. Pure
 * and isomorphic; merge bookkeeping (rev, keyRevs) never counts as a change.
 */

export type SectionChangeKind = 'added' | 'removed' | 'changed' | 'moved';

export interface SectionChange {
  sectionId: string;
  type: BlockType;
  /** The section's own name, else empty (callers fall back to the block label). */
  name: string;
  change: SectionChangeKind;
  /** Section keys that differ: 'props.headline', 'style', 'position'… ([] for added/removed). */
  keys: string[];
}

export interface DocDiff {
  sections: SectionChange[];
  theme: ThemeKey[];
  meta: MetaKey[];
  /** Nothing guests would see changed. */
  empty: boolean;
}

/** Structural equality for JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (ao[k] === undefined && bo[k] === undefined) continue;
    if (!jsonEqual(ao[k], bo[k])) return false;
  }
  return true;
}

const SECTION_FIELDS = ['type', 'variant', 'name', 'style', 'motion', 'visibility'] as const;

/** The keys (as keyRevs names them) that differ between two states of one section. */
export function sectionKeysChanged(before: EventSection, after: EventSection): string[] {
  const keys: string[] = [];
  for (const f of SECTION_FIELDS) {
    if (!jsonEqual(before[f], after[f])) keys.push(f);
  }
  const props = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
  for (const p of props) {
    if (!jsonEqual(before.props[p], after.props[p])) keys.push(`props.${p}`);
  }
  if (before.position !== after.position) keys.push('position');
  return keys;
}

export function themeKeysChanged(before: EventDoc['theme'], after: EventDoc['theme']): ThemeKey[] {
  return THEME_KEYS.filter((k) => !jsonEqual(before[k], after[k]));
}

export function metaKeysChanged(before: EventDoc['meta'], after: EventDoc['meta']): MetaKey[] {
  return META_KEYS.filter((k) => !jsonEqual(before[k], after[k]));
}

/**
 * What changed from `before` to `after`, in `after`'s order (removed
 * sections last). `before` null: everything is new.
 */
export function diffDocs(before: EventDoc | null, after: EventDoc): DocDiff {
  const sections: SectionChange[] = [];
  const old = new Map((before?.sections ?? []).map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const s of orderedSections(after.sections)) {
    seen.add(s.id);
    const prev = old.get(s.id);
    if (!prev) {
      sections.push({ sectionId: s.id, type: s.type, name: s.name, change: 'added', keys: [] });
      continue;
    }
    const keys = sectionKeysChanged(prev, s);
    if (!keys.length) continue;
    const onlyMoved = keys.length === 1 && keys[0] === 'position';
    sections.push({
      sectionId: s.id,
      type: s.type,
      name: s.name,
      change: onlyMoved ? 'moved' : 'changed',
      keys,
    });
  }
  for (const s of orderedSections(before?.sections ?? [])) {
    if (seen.has(s.id)) continue;
    sections.push({ sectionId: s.id, type: s.type, name: s.name, change: 'removed', keys: [] });
  }
  const theme = before ? themeKeysChanged(before.theme, after.theme) : [];
  const meta = before ? metaKeysChanged(before.meta, after.meta) : [];
  return { sections, theme, meta, empty: !sections.length && !theme.length && !meta.length };
}

/** Every key of a section, as keyRevs names them. */
function allKeysOf(section: EventSection): string[] {
  return [
    'variant',
    'name',
    'style',
    'motion',
    'visibility',
    'position',
    ...Object.keys(section.props).map((k) => `props.${k}`),
  ];
}

/**
 * `target`'s content laid over `current`'s revision bookkeeping, as one new
 * draft_version `nv` (restoring a version). Keys that differ get rev `nv`;
 * unchanged keys keep their current revs, so revs never go backwards: a
 * collaborator's pending edit to a key the restore changed conflicts (as it
 * should), one to an untouched key still merges, and sync picks up exactly
 * the sections the restore changed.
 */
export function rebaseOnto(
  current: EventDoc,
  target: EventDoc,
  nv: number,
): { doc: EventDoc; diff: DocDiff } {
  const diff = diffDocs(current, target);
  const now = new Map(current.sections.map((s) => [s.id, s]));
  const sections = target.sections.map((t): EventSection => {
    const cur = now.get(t.id);
    const next: EventSection = { ...structuredClone(t), keyRevs: {}, rev: nv };
    if (!cur || cur.type !== t.type) {
      for (const k of allKeysOf(t)) next.keyRevs[k] = nv;
      return next;
    }
    const changed = sectionKeysChanged(cur, t);
    next.keyRevs = { ...cur.keyRevs };
    for (const k of changed) next.keyRevs[k] = nv;
    next.rev = changed.length ? nv : cur.rev;
    return next;
  });
  const themeChanged = themeKeysChanged(current.theme, target.theme);
  const metaChanged = metaKeysChanged(current.meta, target.meta);
  const theme = {
    ...structuredClone(target.theme),
    rev: themeChanged.length ? nv : current.theme.rev,
    keyRevs: { ...current.theme.keyRevs },
  };
  for (const k of themeChanged) theme.keyRevs[k] = nv;
  const meta = {
    ...structuredClone(target.meta),
    rev: metaChanged.length ? nv : current.meta.rev,
    keyRevs: { ...current.meta.keyRevs },
  };
  for (const k of metaChanged) meta.keyRevs[k] = nv;
  return {
    doc: { schemaVersion: target.schemaVersion, theme, sections, meta },
    diff,
  };
}

/** Labels for describing a diff in words (the block registry supplies them). */
export interface DiffLabels {
  /** "Hero", "Agenda". */
  block: (type: BlockType) => string;
  /** A props key's field label ("Headline"), or null to humanize the key. */
  field?: (type: BlockType, propKey: string) => string | null;
}

const SECTION_KEY_WORDS: Record<string, string> = {
  type: 'block',
  variant: 'layout',
  name: 'name',
  style: 'style',
  motion: 'motion',
  visibility: 'who sees it',
  position: 'moved',
};

const THEME_KEY_WORDS: Record<ThemeKey, string> = {
  presetId: 'preset',
  mode: 'light/dark',
  palette: 'colours',
  paletteDark: 'dark colours',
  gradient: 'gradient',
  typography: 'fonts',
  shape: 'shape and buttons',
  layout: 'layout',
  background: 'background',
  overlay: 'overlay',
  finish: 'finish',
  intro: 'intro',
  motion: 'motion',
  peoplePhotos: 'people photos',
  brand: 'brand',
};

const META_KEY_WORDS: Record<MetaKey, string> = {
  seoTitle: 'SEO title',
  seoDescription: 'SEO description',
  ogLayout: 'share card',
  faviconFromLogo: 'favicon',
};

/** "headlineText" / "cta_label" → "headline text" / "cta label". */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

export interface DiffLine {
  kind: 'section' | 'theme' | 'page';
  /** The section this line is about; null for theme and page lines. */
  sectionId: string | null;
  text: string;
}

/**
 * One plain line per changed thing: "Hero – headline, background",
 * "Agenda – added", "Theme – colours, fonts", "Page – SEO title".
 */
export function describeDiff(diff: DocDiff, labels: DiffLabels): DiffLine[] {
  const lines: DiffLine[] = diff.sections.map((c): DiffLine => {
    const title = c.name.trim() || labels.block(c.type);
    if (c.change !== 'changed') {
      return { kind: 'section', sectionId: c.sectionId, text: `${title} – ${c.change}` };
    }
    const words = c.keys.map((k) => {
      if (k.startsWith('props.')) {
        const prop = k.slice(6);
        return (labels.field?.(c.type, prop) ?? humanizeKey(prop)).toLowerCase();
      }
      return SECTION_KEY_WORDS[k] ?? humanizeKey(k);
    });
    return {
      kind: 'section',
      sectionId: c.sectionId,
      text: `${title} – ${[...new Set(words)].join(', ')}`,
    };
  });
  if (diff.theme.length) {
    lines.push({
      kind: 'theme',
      sectionId: null,
      text: `Theme – ${diff.theme.map((k) => THEME_KEY_WORDS[k]).join(', ')}`,
    });
  }
  if (diff.meta.length) {
    lines.push({
      kind: 'page',
      sectionId: null,
      text: `Page – ${diff.meta.map((k) => META_KEY_WORDS[k]).join(', ')}`,
    });
  }
  return lines;
}
