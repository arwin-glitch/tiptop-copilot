import { keyAfter, keyBetween } from '@/lib/events/fractional';
import type {
  DraftOp,
  PageUpdateOp,
  SectionDeleteOp,
  SectionInsertOp,
  SectionMoveOp,
  SectionUpdateOp,
  ThemeUpdateOp,
} from '@/lib/events/ops';
import {
  orderedSections,
  type EventDoc,
  type EventPageMeta,
  type EventSection,
  type EventTheme,
  type JsonValue,
  type MetaKey,
  type SectionKey,
  type ThemeKey,
} from '@/lib/events/schema';
import { placeSection, type SectionTemplate } from '@/lib/events/doc';

/**
 * Studio's edits as draft ops (lib/events/ops.ts). Every change the editor
 * makes goes through one of these builders, so an op always carries the rev
 * the person last saw for its target (`baseRev`) and a fresh opId. Pure and
 * isomorphic; tested in tests/unit/events-diff-ops.test.ts.
 */

/** A uuid for a new section or an opId (crypto.randomUUID where there is one). */
export function newClientId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback: a v4-shaped id from Math.random (tests, very old browsers).
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The value a section holds for one op key ('props.headline', 'style', …). */
export function sectionKeyValue(section: EventSection, key: SectionKey): JsonValue | undefined {
  if (key.startsWith('props.')) return section.props[key.slice(6)];
  return (section as unknown as Record<string, JsonValue>)[key];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The keys that differ between two states of a section, as one update op's
 * `set`/`unset` (props removed in `after` go to unset). Null when nothing changed.
 */
export function diffSection(
  before: EventSection,
  after: EventSection,
): { set: Record<string, JsonValue>; unset: string[] } | null {
  const set: Record<string, JsonValue> = {};
  const unset: string[] = [];
  for (const key of ['variant', 'name', 'style', 'motion', 'visibility'] as const) {
    if (!same(before[key], after[key])) set[key] = after[key] as unknown as JsonValue;
  }
  const propKeys = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
  for (const key of propKeys) {
    if (!(key in after.props)) unset.push(`props.${key}`);
    else if (!same(before.props[key], after.props[key])) set[`props.${key}`] = after.props[key]!;
  }
  return Object.keys(set).length || unset.length ? { set, unset } : null;
}

export function sectionUpdate(
  section: Pick<EventSection, 'id' | 'rev'>,
  set: Record<string, JsonValue>,
  unset: string[] = [],
): SectionUpdateOp {
  return {
    kind: 'section.update',
    opId: newClientId(),
    id: section.id,
    baseRev: section.rev,
    set,
    ...(unset.length ? { unset } : {}),
  };
}

/** One update op from two states of a section, or null when they are the same. */
export function sectionUpdateFromDiff(
  before: EventSection,
  after: EventSection,
): SectionUpdateOp | null {
  const diff = diffSection(before, after);
  if (!diff) return null;
  // An op must set at least one key; a pure removal re-states the name.
  const set = Object.keys(diff.set).length ? diff.set : { name: after.name };
  return sectionUpdate(before, set, diff.unset);
}

export function themeUpdate(
  theme: Pick<EventTheme, 'rev'>,
  set: Partial<Record<ThemeKey, unknown>>,
): ThemeUpdateOp {
  return { kind: 'theme.update', opId: newClientId(), baseRev: theme.rev, set };
}

export function pageUpdate(
  meta: Pick<EventPageMeta, 'rev'>,
  set: Partial<Record<MetaKey, unknown>>,
): PageUpdateOp {
  return { kind: 'page.update', opId: newClientId(), baseRev: meta.rev, set };
}

/** A new section from a template, placed after `afterId` (null: at the top). */
export function sectionInsert(
  doc: EventDoc,
  template: SectionTemplate,
  afterId: string | null,
): SectionInsertOp {
  const position = keyAfter(doc.sections, afterId);
  return {
    kind: 'section.insert',
    opId: newClientId(),
    section: placeSection(template, newClientId(), position),
    afterId,
  };
}

/** A copy of a section right below it (new id, same content, revs reset). */
export function sectionDuplicate(doc: EventDoc, sectionId: string): SectionInsertOp | null {
  const source = doc.sections.find((s) => s.id === sectionId);
  if (!source) return null;
  const { id: _id, position: _p, rev: _r, keyRevs: _k, ...template } = structuredClone(source);
  return sectionInsert(doc, template, sectionId);
}

/** Move a section to an index of the current order (0 = top). Null when it would not move. */
export function sectionMoveTo(
  doc: EventDoc,
  sectionId: string,
  toIndex: number,
): SectionMoveOp | null {
  const ordered = orderedSections(doc.sections);
  const from = ordered.findIndex((s) => s.id === sectionId);
  if (from < 0) return null;
  const rest = ordered.filter((s) => s.id !== sectionId);
  const index = Math.max(0, Math.min(rest.length, toIndex));
  if (index === from) return null;
  const before = rest[index - 1]?.position ?? null;
  const after = rest[index]?.position ?? null;
  return {
    kind: 'section.move',
    opId: newClientId(),
    id: sectionId,
    position: keyBetween(before, after),
  };
}

/** Move one step up (-1) or down (+1). */
export function sectionStep(doc: EventDoc, sectionId: string, step: -1 | 1): SectionMoveOp | null {
  const ordered = orderedSections(doc.sections);
  const from = ordered.findIndex((s) => s.id === sectionId);
  if (from < 0) return null;
  return sectionMoveTo(doc, sectionId, from + step);
}

export function sectionDelete(section: Pick<EventSection, 'id' | 'rev'>): SectionDeleteOp {
  return { kind: 'section.delete', opId: newClientId(), id: section.id, baseRev: section.rev };
}

/** The target an op writes to, for presence, rebasing and the conflict dialog. */
export function opTarget(op: DraftOp): { target: 'section' | 'theme' | 'meta'; id: string | null } {
  switch (op.kind) {
    case 'theme.update':
      return { target: 'theme', id: null };
    case 'page.update':
      return { target: 'meta', id: null };
    case 'section.insert':
      return { target: 'section', id: op.section.id };
    default:
      return { target: 'section', id: op.id };
  }
}

/** The keys an op writes (as keyRevs name them). */
export function opKeys(op: DraftOp): string[] {
  switch (op.kind) {
    case 'section.update':
      return [...Object.keys(op.set), ...(op.unset ?? [])];
    case 'theme.update':
    case 'page.update':
      return Object.keys(op.set);
    case 'section.move':
      return ['position'];
    case 'section.insert':
      return [
        'variant',
        'name',
        'style',
        'motion',
        'visibility',
        ...Object.keys(op.section.props).map((k) => `props.${k}`),
      ];
    case 'section.delete':
      return [];
  }
}

/**
 * Fold a later op into an earlier unsent one when both write the same keys
 * of the same target (one person typing into one field): the later values
 * win, the earlier baseRev stays. Null when they do not fold.
 */
export function coalesce(first: DraftOp, next: DraftOp): DraftOp | null {
  const sameKeys = (a: string[], b: string[]) =>
    a.length === b.length && a.every((k) => b.includes(k));
  if (first.kind === 'section.update' && next.kind === 'section.update') {
    if (first.id !== next.id || !sameKeys(opKeys(first), opKeys(next))) return null;
    const { unset: _unset, ...rest } = first;
    return {
      ...rest,
      set: { ...first.set, ...next.set },
      ...(next.unset?.length ? { unset: next.unset } : {}),
    };
  }
  if (first.kind === 'theme.update' && next.kind === 'theme.update') {
    if (!sameKeys(opKeys(first), opKeys(next))) return null;
    return { ...first, set: { ...first.set, ...next.set } };
  }
  if (first.kind === 'page.update' && next.kind === 'page.update') {
    if (!sameKeys(opKeys(first), opKeys(next))) return null;
    return { ...first, set: { ...first.set, ...next.set } };
  }
  if (first.kind === 'section.move' && next.kind === 'section.move' && first.id === next.id) {
    return { ...first, position: next.position };
  }
  return null;
}
