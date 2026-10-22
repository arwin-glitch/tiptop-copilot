import type { EventEditorRole, EventEditorScope } from '@/lib/types/domain';
import type { DraftOp } from './ops';
import type { BlockType, EventTheme, SectionKey, ThemeKey } from './schema';

/**
 * Who may do what to one event. Every Events surface asks these flags and
 * predicates rather than checking roles itself, so the rules live once:
 *
 *   - Owner (any signed-in org member): everything.
 *   - Outside editor (edit link, no account): the DRAFT only, within the
 *     link's scope (design, content, chosen sections), never brand-locked
 *     parts, never publish, settings, guests, messages, sharing or restore.
 *   - Viewer link: read-only preview of the draft.
 *   - Check-in staff link: door list, check-in/undo and walk-ins only.
 *
 * Pure and isomorphic: Studio greys out what the server would refuse, and
 * the server (WS3's enforceOpScope in lib/events/editor-auth.ts, called by
 * the ops service) refuses it anyway. The UI is never the boundary.
 */

export type EventActorKind = 'owner' | 'editor' | 'viewer' | 'checkin';

export interface BrandLocks {
  logo: boolean;
  palette: boolean;
  fonts: boolean;
  intro: boolean;
}

export interface EventCapabilities {
  actor: EventActorKind;
  /** See the unpublished draft (Studio, preview). */
  viewDraft: boolean;
  /** Theme keys (minus locked/owner-only ones) and section variant/style/motion. */
  editDesign: boolean;
  /** Section props and names. */
  editContent: boolean;
  /** Add, reorder and delete sections. Outsiders only with scope = all sections. */
  structure: boolean;
  /** Sections this actor may touch: 'all' or ids. */
  sections: 'all' | readonly string[];
  /** Effective brand locks for this actor (owners: none). */
  locks: BrandLocks;
  uploadMedia: boolean;
  /** Section visibility (gating) — owner-only: an outsider could ungate LP materials. */
  editVisibility: boolean;
  /** SEO title/description and share card — owner-only. */
  editMeta: boolean;
  /** Brand kit and the locks themselves — owner-only. */
  editBrand: boolean;
  /** Fields the block registry marks owner-only (RSVP form internals). */
  editOwnerOnlyProps: boolean;
  publish: boolean;
  /** Date, time, venue, capacity, slug, visibility, access, registration. */
  manageSettings: boolean;
  manageGuests: boolean;
  seeGuestEmails: boolean;
  message: boolean;
  share: boolean;
  viewHistory: boolean;
  restoreVersions: boolean;
  checkIn: boolean;
  seeDoorList: boolean;
  exportGuests: boolean;
}

const NO_LOCKS: BrandLocks = { logo: false, palette: false, fonts: false, intro: false };

export function ownerCapabilities(): EventCapabilities {
  return {
    actor: 'owner',
    viewDraft: true,
    editDesign: true,
    editContent: true,
    structure: true,
    sections: 'all',
    locks: { ...NO_LOCKS },
    uploadMedia: true,
    editVisibility: true,
    editMeta: true,
    editBrand: true,
    editOwnerOnlyProps: true,
    publish: true,
    manageSettings: true,
    manageGuests: true,
    seeGuestEmails: true,
    message: true,
    share: true,
    viewHistory: true,
    restoreVersions: true,
    checkIn: true,
    seeDoorList: true,
    exportGuests: true,
  };
}

/** Nothing at all: an unknown, expired or revoked link. */
export function noCapabilities(): EventCapabilities {
  return {
    ...ownerCapabilities(),
    actor: 'viewer',
    viewDraft: false,
    editDesign: false,
    editContent: false,
    structure: false,
    sections: [],
    locks: { logo: true, palette: true, fonts: true, intro: true },
    uploadMedia: false,
    editVisibility: false,
    editMeta: false,
    editBrand: false,
    editOwnerOnlyProps: false,
    publish: false,
    manageSettings: false,
    manageGuests: false,
    seeGuestEmails: false,
    message: false,
    share: false,
    viewHistory: false,
    restoreVersions: false,
    checkIn: false,
    seeDoorList: false,
    exportGuests: false,
  };
}

/**
 * What a link holder may do. `themeLocks` are the doc's
 * theme.brand.locks; they bind an outside editor only when the link was made
 * with brand lock on (the default).
 */
export function capabilitiesForGrant(
  grant: { role: EventEditorRole; scope: EventEditorScope; editingPaused?: boolean },
  themeLocks: BrandLocks,
): EventCapabilities {
  const none = noCapabilities();
  if (grant.role === 'checkin') {
    return { ...none, actor: 'checkin', checkIn: true, seeDoorList: true };
  }
  if (grant.role === 'viewer') {
    return { ...none, actor: 'viewer', viewDraft: true };
  }
  const paused = grant.editingPaused === true;
  const scope = grant.scope;
  const allSections = scope.sections === 'all';
  return {
    ...none,
    actor: 'editor',
    viewDraft: true,
    editDesign: !paused && scope.design,
    editContent: !paused && scope.content,
    structure: !paused && allSections && (scope.design || scope.content),
    sections: allSections ? 'all' : [...scope.sections],
    locks: scope.brand_locked ? { ...themeLocks } : { ...NO_LOCKS },
    uploadMedia: !paused && (scope.design || scope.content),
  };
}

/* ------------------------------------------------------------- predicates */

/** Why something is refused, in the words Studio shows next to a lock icon. */
export type DenyReason =
  | 'Outside your scope'
  | 'Brand locked by TipTop'
  | 'Only TipTop can change this'
  | 'Editing is paused';

/** Which brand lock covers each theme key (none: not lockable). */
export const THEME_KEY_LOCK: Partial<Record<ThemeKey, keyof BrandLocks>> = {
  palette: 'palette',
  paletteDark: 'palette',
  gradient: 'palette',
  typography: 'fonts',
  intro: 'intro',
};

export function inSectionScope(caps: EventCapabilities, sectionId: string): boolean {
  return caps.sections === 'all' || caps.sections.includes(sectionId);
}

export function canSetThemeKey(caps: EventCapabilities, key: ThemeKey): DenyReason | null {
  if (key === 'brand') return caps.editBrand ? null : 'Only TipTop can change this';
  if (!caps.editDesign)
    return caps.viewDraft ? 'Outside your scope' : 'Only TipTop can change this';
  const lock = THEME_KEY_LOCK[key];
  if (lock && caps.locks[lock]) return 'Brand locked by TipTop';
  return null;
}

export function canSetMetaKey(caps: EventCapabilities): DenyReason | null {
  return caps.editMeta ? null : 'Only TipTop can change this';
}

/**
 * Whether the actor may set one section key. `ownerOnlyProp` comes from the
 * block registry's field descriptors (e.g. RSVP form internals): labels are
 * editable by outsiders, the form's wiring is not.
 */
export function canSetSectionKey(
  caps: EventCapabilities,
  sectionId: string,
  key: SectionKey,
  ownerOnlyProp?: (key: string) => boolean,
): DenyReason | null {
  if (!inSectionScope(caps, sectionId)) return 'Outside your scope';
  if (key === 'visibility') return caps.editVisibility ? null : 'Only TipTop can change this';
  if (key === 'name' || key.startsWith('props.')) {
    if (!caps.editContent) return 'Outside your scope';
    if (key.startsWith('props.') && ownerOnlyProp?.(key.slice(6)) && !caps.editOwnerOnlyProps) {
      return 'Only TipTop can change this';
    }
    return null;
  }
  // variant, style, motion
  return caps.editDesign ? null : 'Outside your scope';
}

export function canStructure(caps: EventCapabilities): DenyReason | null {
  return caps.structure ? null : 'Outside your scope';
}

/** Context the op check needs about the current draft. */
export interface OpCheckContext {
  /** The block type of an existing section, or null when it does not exist. */
  sectionType: (id: string) => BlockType | null;
  /** Owner-only props per block type, from the registry (WS2). Optional. */
  isOwnerOnlyProp?: (type: BlockType, key: string) => boolean;
}

/** One op against the actor's capabilities: null when allowed, else the reason. */
export function checkOp(
  caps: EventCapabilities,
  op: DraftOp,
  ctx: OpCheckContext,
): { reason: DenyReason; keys: string[] } | null {
  switch (op.kind) {
    case 'section.update': {
      const type = ctx.sectionType(op.id);
      const ownerOnly =
        type && ctx.isOwnerOnlyProp ? (k: string) => ctx.isOwnerOnlyProp!(type, k) : undefined;
      const keys = [...Object.keys(op.set), ...(op.unset ?? [])] as SectionKey[];
      const denied = keys
        .map((k) => [k, canSetSectionKey(caps, op.id, k, ownerOnly)] as const)
        .filter(([, reason]) => reason !== null);
      return denied.length ? { reason: denied[0]![1]!, keys: denied.map(([k]) => k) } : null;
    }
    case 'section.insert': {
      const reason = canStructure(caps);
      if (reason) return { reason, keys: [] };
      // A new section may not arrive pre-gated by someone who cannot gate.
      if (!caps.editVisibility && op.section.visibility.mode !== 'everyone') {
        return { reason: 'Only TipTop can change this', keys: ['visibility'] };
      }
      return null;
    }
    case 'section.move':
    case 'section.delete': {
      const reason = canStructure(caps);
      return reason ? { reason, keys: [] } : null;
    }
    case 'theme.update': {
      const denied = (Object.keys(op.set) as ThemeKey[])
        .map((k) => [k, canSetThemeKey(caps, k)] as const)
        .filter(([, reason]) => reason !== null);
      return denied.length ? { reason: denied[0]![1]!, keys: denied.map(([k]) => k) } : null;
    }
    case 'page.update': {
      const reason = canSetMetaKey(caps);
      return reason ? { reason, keys: Object.keys(op.set) } : null;
    }
  }
}

/** The doc's brand locks, for capabilitiesForGrant. */
export function themeLocks(theme: Pick<EventTheme, 'brand'>): BrandLocks {
  return { ...theme.brand.locks };
}
