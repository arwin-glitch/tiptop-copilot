import { z } from 'zod';
import {
  entityId,
  isSectionKey,
  jsonValue,
  META_KEYS,
  positionKey,
  rev,
  sectionSchema,
  THEME_KEYS,
  type EventPageMeta,
  type EventSection,
  type EventTheme,
  type JsonValue,
} from './schema';

/**
 * Draft edits travel as ops, never as whole documents. Studio (owners and
 * outside editors alike) turns each change into one op and POSTs batches to
 * /api/events/[id]/draft/ops (or the outsider proxy /api/e/edit/[id]/ops):
 *
 *   { baseVersion, ops: DraftOp[] }  →  DraftOpsResult
 *
 * The server applies them with merge.ts inside a compare-and-set on
 * events.draft_version (retrying up to 3 times when two writes race).
 *
 * `baseRev` on an op is the rev the client last saw for its TARGET: the
 * section's `rev`, or `theme.rev` / `meta.rev`. An update conflicts only when
 * a key it sets changed after that (keyRevs[key] > baseRev), so edits to
 * different keys of the same section merge.
 *
 * Every op carries a client-made `opId` (unique per client) so the response
 * can say which were applied and which conflicted, and undo stacks can track
 * them. Pure and isomorphic.
 */

export const MAX_OPS_PER_BATCH = 50;

const opId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/);

/** Keys set by a section.update: these fields or `props.<key>`. */
const sectionSet = z
  .record(z.string(), jsonValue)
  .refine((set) => Object.keys(set).length > 0 && Object.keys(set).length <= 40, 'Set 1–40 keys.')
  .refine((set) => Object.keys(set).every(isSectionKey), 'Unknown section field.');

export const sectionUpdateOp = z.strictObject({
  kind: z.literal('section.update'),
  opId,
  id: entityId,
  baseRev: rev,
  set: sectionSet,
  /** Props keys to remove: `props.<key>` only. */
  unset: z
    .array(z.string().regex(/^props\.[a-zA-Z][a-zA-Z0-9_]{0,39}$/))
    .max(40)
    .optional(),
});

export const sectionInsertOp = z.strictObject({
  kind: z.literal('section.insert'),
  opId,
  /** The whole new section. Its rev/keyRevs are ignored and set by the server. */
  section: sectionSchema,
  /**
   * Where the client put it. If `section.position` is taken by then, the
   * server places it right after this section instead (null: at the top).
   */
  afterId: entityId.nullable(),
});

export const sectionMoveOp = z.strictObject({
  kind: z.literal('section.move'),
  opId,
  id: entityId,
  /** The new fractional key (lib/events/fractional.ts). Last writer wins. */
  position: positionKey,
});

export const sectionDeleteOp = z.strictObject({
  kind: z.literal('section.delete'),
  opId,
  id: entityId,
  /** Conflicts if the section changed after this rev (someone's fresh work). */
  baseRev: rev,
});

const themeSet = z
  .record(z.string(), z.unknown())
  .refine((set) => Object.keys(set).length > 0, 'Set at least one key.')
  .refine(
    (set) => Object.keys(set).every((k) => (THEME_KEYS as readonly string[]).includes(k)),
    'Unknown theme field.',
  );

export const themeUpdateOp = z.strictObject({
  kind: z.literal('theme.update'),
  opId,
  baseRev: rev,
  /** Whole top-level theme keys: { palette: {...} }. Values validated per key. */
  set: themeSet,
});

const metaSet = z
  .record(z.string(), z.unknown())
  .refine((set) => Object.keys(set).length > 0, 'Set at least one key.')
  .refine(
    (set) => Object.keys(set).every((k) => (META_KEYS as readonly string[]).includes(k)),
    'Unknown page field.',
  );

export const pageUpdateOp = z.strictObject({
  kind: z.literal('page.update'),
  opId,
  baseRev: rev,
  set: metaSet,
});

export const draftOp = z.discriminatedUnion('kind', [
  sectionUpdateOp,
  sectionInsertOp,
  sectionMoveOp,
  sectionDeleteOp,
  themeUpdateOp,
  pageUpdateOp,
]);
export type DraftOp = z.infer<typeof draftOp>;
export type DraftOpKind = DraftOp['kind'];
export type SectionUpdateOp = z.infer<typeof sectionUpdateOp>;
export type SectionInsertOp = z.infer<typeof sectionInsertOp>;
export type SectionMoveOp = z.infer<typeof sectionMoveOp>;
export type SectionDeleteOp = z.infer<typeof sectionDeleteOp>;
export type ThemeUpdateOp = z.infer<typeof themeUpdateOp>;
export type PageUpdateOp = z.infer<typeof pageUpdateOp>;

/** The body of POST …/draft/ops. */
export const draftOpsRequest = z.strictObject({
  /** The draft_version the client last synced to (informational; merge is per key). */
  baseVersion: rev,
  ops: z.array(draftOp).min(1).max(MAX_OPS_PER_BATCH),
});
export type DraftOpsRequest = z.infer<typeof draftOpsRequest>;

/* ---------------------------------------------------------------- results */

export type OpConflictKind =
  /** A key this op sets changed after baseRev. `theirs` holds the current values. */
  | 'key_changed'
  /** The section is gone (deleted by someone). Studio offers Restore / Discard. */
  | 'section_deleted'
  /** An insert whose id already exists. */
  | 'section_exists'
  /** A delete of a section that changed after baseRev. */
  | 'section_changed'
  /** The op failed validation (bad value, unknown variant, props the block refuses). */
  | 'invalid'
  /** Outside the actor's capabilities (scope, brand lock, owner-only field). */
  | 'forbidden';

export interface OpConflict {
  opId: string;
  kind: OpConflictKind;
  target: 'section' | 'theme' | 'meta';
  sectionId: string | null;
  /** The keys involved (for key_changed / forbidden). */
  keys: string[];
  /** Current server values of those keys, so the dialog can compare. */
  theirs: Record<string, JsonValue | unknown>;
  /** Who made the change that won, when known (from event_edits). */
  by: { name: string; actorKey: string } | null;
  /** A plain sentence for the dialog: "Morgan changed Headline in Hero". */
  message: string;
}

/** What changed on the server as a result of a batch (or since a sync point). */
export interface DraftChanges {
  /** Sections inserted or changed, in their full new state. */
  sections: EventSection[];
  /** Ids of sections deleted. */
  deletedSectionIds: string[];
  theme: EventTheme | null;
  meta: EventPageMeta | null;
}

/** The response to POST …/draft/ops. */
export interface DraftOpsResult {
  /** draft_version after this batch (unchanged when nothing applied). */
  version: number;
  /** opIds applied, in order. */
  applied: string[];
  conflicts: OpConflict[];
  /** The post-state of everything this batch touched: replace local copies with it. */
  changes: DraftChanges;
}

/* ------------------------------------------------------------ inversion */

/**
 * The op that undoes `op`, given the state just before it applied. Undo
 * sends this as a NEW rev-checked op (baseRev = the rev after `op`), so undo
 * never overwrites a collaborator: if someone changed the key since, it
 * conflicts and Studio says "Can't undo – Morgan changed this since".
 * Returns null when there is nothing to invert (e.g. the target is unknown).
 */
export function invertOp(
  op: DraftOp,
  before: { section?: EventSection | null; theme?: EventTheme; meta?: EventPageMeta },
  newOpId: string,
  revAfter: number,
): DraftOp | null {
  switch (op.kind) {
    case 'section.update': {
      const s = before.section;
      if (!s) return null;
      const set: Record<string, JsonValue> = {};
      const unset: string[] = [];
      for (const key of [...Object.keys(op.set), ...(op.unset ?? [])]) {
        if (key.startsWith('props.')) {
          const prop = key.slice(6);
          if (prop in s.props) set[key] = s.props[prop] as JsonValue;
          else unset.push(key);
        } else {
          set[key] = (s as unknown as Record<string, JsonValue>)[key] as JsonValue;
        }
      }
      return {
        kind: 'section.update',
        opId: newOpId,
        id: op.id,
        baseRev: revAfter,
        set: Object.keys(set).length ? set : { name: s.name },
        ...(unset.length ? { unset } : {}),
      };
    }
    case 'section.insert':
      return { kind: 'section.delete', opId: newOpId, id: op.section.id, baseRev: revAfter };
    case 'section.move':
      return before.section
        ? { kind: 'section.move', opId: newOpId, id: op.id, position: before.section.position }
        : null;
    case 'section.delete':
      return before.section
        ? { kind: 'section.insert', opId: newOpId, section: before.section, afterId: null }
        : null;
    case 'theme.update': {
      if (!before.theme) return null;
      const set: Record<string, unknown> = {};
      for (const key of Object.keys(op.set))
        set[key] = (before.theme as Record<string, unknown>)[key];
      return { kind: 'theme.update', opId: newOpId, baseRev: revAfter, set };
    }
    case 'page.update': {
      if (!before.meta) return null;
      const set: Record<string, unknown> = {};
      for (const key of Object.keys(op.set))
        set[key] = (before.meta as Record<string, unknown>)[key];
      return { kind: 'page.update', opId: newOpId, baseRev: revAfter, set };
    }
  }
}
