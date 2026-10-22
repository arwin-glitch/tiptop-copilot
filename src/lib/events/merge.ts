import { keyAfter, positionFree } from './fractional';
import type { DraftChanges, DraftOp, OpConflict } from './ops';
import {
  MAX_SECTIONS,
  isSectionKey,
  metaKeySchema,
  parseEventDoc,
  parseSection,
  sectionKeySchema,
  themeKeySchema,
  type EventDoc,
  type EventPageMeta,
  type EventSection,
  type EventTheme,
  type JsonValue,
  type MetaKey,
  type ParseOptions,
  type SectionKey,
  type ThemeKey,
} from './schema';

/**
 * Applies a batch of draft ops to a document: property-level merge in the
 * style of Figma's multiplayer, no CRDT.
 *
 *   - section.update conflicts only when a key it sets changed after its
 *     baseRev (keyRevs[key] > baseRev); edits to different keys merge.
 *     An op is all-or-nothing: one conflicting key fails the whole op.
 *   - section.move is last-writer-wins on one fractional key; a position
 *     another section holds is moved just after it.
 *   - section.insert with a taken position is placed after `afterId`.
 *   - section.delete conflicts when the section changed after baseRev.
 *   - an update or move against a missing section is 'section_deleted'.
 *   - theme.update / page.update work like section.update on their keys.
 *
 * Keys changed earlier in the same batch never conflict with later ops of
 * that batch (it is one person's burst of edits).
 *
 * Pure and isomorphic: the server runs it inside a compare-and-set on
 * draft_version (lib/services/events.ts), and Studio can run it to predict
 * the result. Every key a batch changes gets rev = `nextVersion`.
 */

/** One row's worth of event_edits (the per-section activity/blame log). */
export interface EditRecord {
  opId: string;
  op: 'insert' | 'update' | 'move' | 'delete' | 'theme' | 'page';
  sectionId: string | null;
  keys: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface MergeOptions extends ParseOptions {
  /** The draft_version this batch commits as. */
  nextVersion: number;
  /**
   * Capability check for one op against the doc as it stands at that point
   * in the batch (WS3's enforceOpScope supplies it). Return a conflict to
   * refuse the op; null to allow.
   */
  authorize?: (op: DraftOp, doc: EventDoc) => OpConflict | null;
}

export interface MergeResult {
  doc: EventDoc;
  applied: string[];
  conflicts: OpConflict[];
  changes: DraftChanges;
  edits: EditRecord[];
  /** Whether anything changed (false: do not bump draft_version). */
  changed: boolean;
}

function conflict(
  op: DraftOp,
  partial: Omit<OpConflict, 'opId' | 'by' | 'theirs' | 'keys' | 'sectionId'> &
    Partial<Pick<OpConflict, 'theirs' | 'keys' | 'sectionId'>>,
): OpConflict {
  return {
    opId: op.opId,
    by: null,
    theirs: {},
    keys: [],
    sectionId: 'id' in op ? op.id : op.kind === 'section.insert' ? op.section.id : null,
    ...partial,
  };
}

function sectionValue(section: EventSection, key: SectionKey): JsonValue | undefined {
  if (key.startsWith('props.')) return section.props[key.slice(6)];
  return (section as unknown as Record<string, JsonValue>)[key];
}

/** Keys of a section, as keyRevs names them, for an inserted section. */
function allSectionKeys(section: EventSection): string[] {
  return [
    'variant',
    'name',
    'style',
    'motion',
    'visibility',
    ...Object.keys(section.props).map((k) => `props.${k}`),
  ];
}

export function applyOps(
  input: EventDoc,
  ops: readonly DraftOp[],
  options: MergeOptions,
): MergeResult {
  const v = options.nextVersion;
  const doc: EventDoc = structuredClone(input);
  const applied: string[] = [];
  const conflicts: OpConflict[] = [];
  const edits: EditRecord[] = [];
  const touchedSections = new Set<string>();
  const deletedSections = new Set<string>();
  /** `${target}:${key}` changed by this batch. */
  const batchKeys = new Set<string>();
  let themeTouched = false;
  let metaTouched = false;

  const stale = (target: string, key: string, keyRev: number | undefined, baseRev: number) =>
    (keyRev ?? 0) > baseRev && !(keyRev === v && batchKeys.has(`${target}:${key}`));

  for (const op of ops) {
    const refused = options.authorize?.(op, doc) ?? null;
    if (refused) {
      conflicts.push(refused);
      continue;
    }

    switch (op.kind) {
      case 'section.update': {
        const index = doc.sections.findIndex((s) => s.id === op.id);
        const section = doc.sections[index];
        if (!section) {
          conflicts.push(
            conflict(op, {
              kind: 'section_deleted',
              target: 'section',
              message: 'This section was deleted.',
            }),
          );
          break;
        }
        const keys = [...Object.keys(op.set), ...(op.unset ?? [])] as SectionKey[];
        const staleKeys = keys.filter((k) =>
          stale(`s:${op.id}`, k, section.keyRevs[k], op.baseRev),
        );
        if (staleKeys.length) {
          const theirs: Record<string, unknown> = {};
          for (const k of staleKeys) theirs[k] = sectionValue(section, k) ?? null;
          conflicts.push(
            conflict(op, {
              kind: 'key_changed',
              target: 'section',
              keys: staleKeys,
              theirs,
              message: 'Someone else changed this since you started.',
            }),
          );
          break;
        }
        const next: EventSection = structuredClone(section);
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        let invalid: string | null = null;
        for (const [key, value] of Object.entries(op.set)) {
          if (!isSectionKey(key)) {
            invalid = `Unknown field ${key}.`;
            break;
          }
          before[key] = sectionValue(section, key) ?? null;
          after[key] = value;
          if (key.startsWith('props.')) {
            next.props[key.slice(6)] = value;
          } else {
            const parsed = sectionKeySchema(key).safeParse(value);
            if (!parsed.success) {
              invalid = `${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
              break;
            }
            (next as unknown as Record<string, unknown>)[key] = parsed.data;
          }
        }
        for (const key of op.unset ?? []) {
          before[key] = sectionValue(section, key as SectionKey) ?? null;
          after[key] = null;
          delete next.props[key.slice(6)];
        }
        if (!invalid) {
          const checked = parseSection(next, options);
          if (!checked.ok) invalid = checked.issues[0] ?? 'Invalid section.';
        }
        if (invalid) {
          conflicts.push(
            conflict(op, { kind: 'invalid', target: 'section', keys, message: invalid }),
          );
          break;
        }
        for (const k of keys) {
          next.keyRevs[k] = v;
          batchKeys.add(`s:${op.id}:${k}`);
        }
        next.rev = v;
        doc.sections[index] = next;
        touchedSections.add(op.id);
        applied.push(op.opId);
        edits.push({ opId: op.opId, op: 'update', sectionId: op.id, keys, before, after });
        break;
      }

      case 'section.insert': {
        if (doc.sections.some((s) => s.id === op.section.id)) {
          conflicts.push(
            conflict(op, {
              kind: 'section_exists',
              target: 'section',
              message: 'That section already exists.',
            }),
          );
          break;
        }
        if (doc.sections.length >= MAX_SECTIONS) {
          conflicts.push(
            conflict(op, {
              kind: 'invalid',
              target: 'section',
              message: `A page holds at most ${MAX_SECTIONS} sections.`,
            }),
          );
          break;
        }
        const section: EventSection = structuredClone(op.section);
        if (!positionFree(doc.sections, section.position)) {
          section.position = keyAfter(doc.sections, op.afterId);
        }
        section.rev = v;
        section.keyRevs = {};
        for (const k of allSectionKeys(section)) section.keyRevs[k] = v;
        const checked = parseSection(section, options);
        if (!checked.ok) {
          conflicts.push(
            conflict(op, {
              kind: 'invalid',
              target: 'section',
              message: checked.issues[0] ?? 'Invalid section.',
            }),
          );
          break;
        }
        doc.sections.push(section);
        deletedSections.delete(section.id);
        touchedSections.add(section.id);
        for (const k of allSectionKeys(section)) batchKeys.add(`s:${section.id}:${k}`);
        applied.push(op.opId);
        edits.push({
          opId: op.opId,
          op: 'insert',
          sectionId: section.id,
          keys: [],
          before: null,
          after: section as unknown as Record<string, unknown>,
        });
        break;
      }

      case 'section.move': {
        const index = doc.sections.findIndex((s) => s.id === op.id);
        const section = doc.sections[index];
        if (!section) {
          conflicts.push(
            conflict(op, {
              kind: 'section_deleted',
              target: 'section',
              message: 'This section was deleted.',
            }),
          );
          break;
        }
        let position = op.position;
        if (!positionFree(doc.sections, position, op.id)) {
          const holder = doc.sections.find((s) => s.position === position && s.id !== op.id)!;
          position = keyAfter(
            doc.sections.filter((s) => s.id !== op.id),
            holder.id,
          );
        }
        const next = { ...section, position, rev: v, keyRevs: { ...section.keyRevs, position: v } };
        doc.sections[index] = next;
        touchedSections.add(op.id);
        applied.push(op.opId);
        edits.push({
          opId: op.opId,
          op: 'move',
          sectionId: op.id,
          keys: ['position'],
          before: { position: section.position },
          after: { position },
        });
        break;
      }

      case 'section.delete': {
        const index = doc.sections.findIndex((s) => s.id === op.id);
        const section = doc.sections[index];
        if (!section) {
          // Already gone: deleting twice is a no-op, not an error.
          applied.push(op.opId);
          break;
        }
        const changedSince =
          section.rev > op.baseRev && !(section.rev === v && touchedSections.has(op.id));
        if (changedSince) {
          conflicts.push(
            conflict(op, {
              kind: 'section_changed',
              target: 'section',
              message: 'This section changed since you last saw it.',
            }),
          );
          break;
        }
        doc.sections.splice(index, 1);
        touchedSections.delete(op.id);
        deletedSections.add(op.id);
        applied.push(op.opId);
        edits.push({
          opId: op.opId,
          op: 'delete',
          sectionId: op.id,
          keys: [],
          before: section as unknown as Record<string, unknown>,
          after: null,
        });
        break;
      }

      case 'theme.update': {
        const keys = Object.keys(op.set) as ThemeKey[];
        const staleKeys = keys.filter((k) => stale('theme', k, doc.theme.keyRevs[k], op.baseRev));
        if (staleKeys.length) {
          const theirs: Record<string, unknown> = {};
          for (const k of staleKeys) theirs[k] = doc.theme[k];
          conflicts.push(
            conflict(op, {
              kind: 'key_changed',
              target: 'theme',
              keys: staleKeys,
              theirs,
              message: 'Someone else changed the theme since you started.',
            }),
          );
          break;
        }
        const next: EventTheme = structuredClone(doc.theme);
        const before: Record<string, unknown> = {};
        let invalid: string | null = null;
        for (const key of keys) {
          const parsed = themeKeySchema(key).safeParse(op.set[key]);
          if (!parsed.success) {
            invalid = `${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
            break;
          }
          before[key] = doc.theme[key];
          (next as Record<string, unknown>)[key] = parsed.data;
        }
        if (!invalid && options.validateTheme) invalid = options.validateTheme(next)[0] ?? null;
        if (invalid) {
          conflicts.push(
            conflict(op, { kind: 'invalid', target: 'theme', keys, message: invalid }),
          );
          break;
        }
        for (const k of keys) {
          next.keyRevs[k] = v;
          batchKeys.add(`theme:${k}`);
        }
        next.rev = v;
        doc.theme = next;
        themeTouched = true;
        applied.push(op.opId);
        edits.push({
          opId: op.opId,
          op: 'theme',
          sectionId: null,
          keys,
          before,
          after: { ...op.set },
        });
        break;
      }

      case 'page.update': {
        const keys = Object.keys(op.set) as MetaKey[];
        const staleKeys = keys.filter((k) => stale('meta', k, doc.meta.keyRevs[k], op.baseRev));
        if (staleKeys.length) {
          const theirs: Record<string, unknown> = {};
          for (const k of staleKeys) theirs[k] = doc.meta[k];
          conflicts.push(
            conflict(op, {
              kind: 'key_changed',
              target: 'meta',
              keys: staleKeys,
              theirs,
              message: 'Someone else changed the page settings since you started.',
            }),
          );
          break;
        }
        const next: EventPageMeta = structuredClone(doc.meta);
        const before: Record<string, unknown> = {};
        let invalid: string | null = null;
        for (const key of keys) {
          const parsed = metaKeySchema(key).safeParse(op.set[key]);
          if (!parsed.success) {
            invalid = `${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
            break;
          }
          before[key] = doc.meta[key];
          (next as Record<string, unknown>)[key] = parsed.data;
        }
        if (invalid) {
          conflicts.push(conflict(op, { kind: 'invalid', target: 'meta', keys, message: invalid }));
          break;
        }
        for (const k of keys) {
          next.keyRevs[k] = v;
          batchKeys.add(`meta:${k}`);
        }
        next.rev = v;
        doc.meta = next;
        metaTouched = true;
        applied.push(op.opId);
        edits.push({
          opId: op.opId,
          op: 'page',
          sectionId: null,
          keys,
          before,
          after: { ...op.set },
        });
        break;
      }
    }
  }

  const changed = edits.length > 0;
  // Whole-document limits (size, duplicate positions) are checked once at
  // the end; a batch that breaks them is refused as a whole.
  if (changed) {
    const whole = parseEventDoc(doc, options);
    if (!whole.ok) {
      return {
        doc: structuredClone(input),
        applied: [],
        conflicts: [
          ...conflicts,
          ...applied.map((opId) => ({
            opId,
            kind: 'invalid' as const,
            target: 'section' as const,
            sectionId: null,
            keys: [],
            theirs: {},
            by: null,
            message: whole.issues[0] ?? 'The page is not valid.',
          })),
        ],
        changes: { sections: [], deletedSectionIds: [], theme: null, meta: null },
        edits: [],
        changed: false,
      };
    }
  }

  return {
    doc,
    applied,
    conflicts,
    changes: {
      sections: doc.sections.filter((s) => touchedSections.has(s.id)),
      deletedSectionIds: [...deletedSections],
      theme: themeTouched ? doc.theme : null,
      meta: metaTouched ? doc.meta : null,
    },
    edits,
    changed,
  };
}

/**
 * Everything that changed after draft_version `since`, read off the revs in
 * the doc (deletions come from event_edits; the service adds them).
 */
export function changesSince(
  doc: EventDoc,
  since: number,
): Omit<DraftChanges, 'deletedSectionIds'> {
  return {
    sections: doc.sections.filter((s) => s.rev > since),
    theme: doc.theme.rev > since ? doc.theme : null,
    meta: doc.meta.rev > since ? doc.meta : null,
  };
}
