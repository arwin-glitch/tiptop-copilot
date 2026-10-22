'use client';

import * as React from 'react';
import { blockRegistry } from '@/lib/events/blocks';
import {
  canSetMetaKey,
  canSetSectionKey,
  canSetThemeKey,
  canStructure,
  type DenyReason,
} from '@/lib/events/capabilities';
import type { MediaMap, MotionPreview, ResolvedMedia } from '@/lib/events/contracts';
import type { SectionTemplate } from '@/lib/events/doc';
import {
  pageUpdate,
  sectionDelete,
  sectionDuplicate,
  sectionInsert,
  sectionMoveTo,
  sectionStep,
  sectionUpdate,
  themeUpdate,
} from '@/lib/events/editor/doc-ops';
import type { DraftEditor } from '@/lib/events/editor/draft-editor';
import { sectionLabel } from '@/lib/events/editor/fields';
import type { PreviewChoice } from '@/lib/events/editor/preview';
import type { StudioMediaItem } from '@/lib/events/editor/publish';
import type { SessionState, StudioSession } from '@/lib/events/editor/session';
import type {
  EventDoc,
  EventSection,
  JsonValue,
  MetaKey,
  SectionKey,
  ThemeKey,
} from '@/lib/events/schema';
import type { StudioBootstrap } from './studio-types';

/**
 * Studio's shared state: the draft editor and its network session, what is
 * selected, the preview settings, and the actions every panel uses. Every
 * action checks the actor's capabilities first (the same predicates the
 * server enforces), so a locked control does nothing even if clicked.
 */

export type Device = 'desktop' | 'tablet' | 'phone' | 'fit';
export const DEVICE_WIDTH: Record<Device, number | null> = {
  desktop: 1280,
  tablet: 768,
  phone: 390,
  fit: null,
};

export type RailTab = 'sections' | 'theme' | 'brand' | 'effects' | 'media';

export interface StudioContextValue {
  boot: StudioBootstrap;
  editor: DraftEditor;
  session: StudioSession;
  doc: EventDoc;
  sessionState: SessionState;
  readOnly: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  device: Device;
  setDevice: (d: Device) => void;
  motion: MotionPreview;
  setMotion: (m: MotionPreview) => void;
  preview: PreviewChoice;
  setPreview: (p: PreviewChoice) => void;
  fullPreview: boolean;
  setFullPreview: (v: boolean) => void;
  railTab: RailTab;
  setRailTab: (t: RailTab) => void;
  galleryAfter: string | null | undefined;
  openGallery: (afterId: string | null) => void;
  closeGallery: () => void;
  mediaItems: StudioMediaItem[];
  setMediaItems: React.Dispatch<React.SetStateAction<StudioMediaItem[]>>;
  /** What the canvas renders media with; a just-processed upload is added here. */
  media: MediaMap;
  addMedia: (item: ResolvedMedia) => void;
  /** A version being previewed read-only in the canvas (History). */
  versionPreview: { label: string; doc: EventDoc; versionId: string } | null;
  setVersionPreview: (v: { label: string; doc: EventDoc; versionId: string } | null) => void;
  /** The live page (owners), for the publish diff and the "N changes" badge. */
  publishedDoc: EventDoc | null;
  publishedDraftVersion: number;
  markPublished: (doc: EventDoc, draftVersion: number) => void;
  /** Sections whose soft lock this person chose to override. */
  overridden: ReadonlySet<string>;
  override: (sectionId: string) => void;
  labelOf: (section: EventSection) => string;
  /* permission checks */
  sectionDenied: (
    sectionId: string,
    key: SectionKey,
    type?: EventSection['type'],
  ) => DenyReason | null;
  themeDenied: (key: ThemeKey) => DenyReason | null;
  metaDenied: () => DenyReason | null;
  structureDenied: () => DenyReason | null;
  /* edits */
  updateSection: (
    sectionId: string,
    set: Record<string, JsonValue>,
    label?: string,
    unset?: string[],
  ) => void;
  updateTheme: (set: Partial<Record<ThemeKey, unknown>>, label?: string) => void;
  updatePage: (set: Partial<Record<MetaKey, unknown>>, label?: string) => void;
  insertSection: (template: SectionTemplate, afterId: string | null) => string | null;
  duplicateSection: (sectionId: string) => void;
  moveSection: (sectionId: string, toIndex: number) => void;
  stepSection: (sectionId: string, step: -1 | 1) => void;
  deleteSection: (sectionId: string) => void;
}

const Ctx = React.createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = React.useContext(Ctx);
  if (!value) throw new Error('useStudio outside Studio');
  return value;
}

export function useEditorDoc(editor: DraftEditor): EventDoc {
  return React.useSyncExternalStore(editor.subscribe, editor.getDisplay, editor.getDisplay);
}

export function useEditorRevision(editor: DraftEditor): number {
  return React.useSyncExternalStore(editor.subscribe, editor.getRevision, editor.getRevision);
}

export function useSessionState(session: StudioSession): SessionState {
  return React.useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

export function StudioProvider({
  boot,
  editor,
  session,
  children,
}: {
  boot: StudioBootstrap;
  editor: DraftEditor;
  session: StudioSession;
  children: React.ReactNode;
}) {
  const doc = useEditorDoc(editor);
  const sessionState = useSessionState(session);
  const caps = boot.capabilities;
  const readOnly =
    sessionState.lost ||
    (!caps.editContent && !caps.editDesign && !caps.structure && boot.actor.role !== 'owner');
  const [chosenId, setSelectedId] = React.useState<string | null>(null);
  // A selected section someone deleted is simply no longer selected.
  const selectedId = chosenId && doc.sections.some((s) => s.id === chosenId) ? chosenId : null;
  const [device, setDevice] = React.useState<Device>('fit');
  const [motion, setMotion] = React.useState<MotionPreview>('full');
  const [preview, setPreview] = React.useState<PreviewChoice>({ kind: 'studio' });
  const [fullPreview, setFullPreview] = React.useState(false);
  const [railTab, setRailTab] = React.useState<RailTab>('sections');
  const [galleryAfter, setGalleryAfter] = React.useState<string | null | undefined>(undefined);
  const [mediaItems, setMediaItems] = React.useState<StudioMediaItem[]>(boot.mediaItems);
  const [media, setMedia] = React.useState<MediaMap>(boot.media);
  const [versionPreview, setVersionPreview] =
    React.useState<StudioContextValue['versionPreview']>(null);
  const [overridden, setOverridden] = React.useState<Set<string>>(() => new Set());
  const [published, setPublished] = React.useState({
    doc: boot.publishedDoc,
    draftVersion: boot.publishedDraftVersion,
  });

  const select = React.useCallback(
    (id: string | null) => {
      setSelectedId(id);
      session.setFocus(id);
    },
    [session],
  );

  const labelOf = React.useCallback(
    (section: EventSection) => sectionLabel(section, blockRegistry),
    [],
  );

  const sectionDenied = React.useCallback(
    (sectionId: string, key: SectionKey, type?: EventSection['type']): DenyReason | null => {
      if (sessionState.editingPaused && !boot.actor.owner) return 'Editing is paused';
      const sectionType = type ?? doc.sections.find((s) => s.id === sectionId)?.type;
      return canSetSectionKey(caps, sectionId, key, (k) =>
        sectionType ? blockRegistry.isOwnerOnlyProp(sectionType, k) : false,
      );
    },
    [boot.actor.owner, caps, doc.sections, sessionState.editingPaused],
  );
  const themeDenied = React.useCallback(
    (key: ThemeKey): DenyReason | null =>
      sessionState.editingPaused && !boot.actor.owner
        ? 'Editing is paused'
        : canSetThemeKey(caps, key),
    [boot.actor.owner, caps, sessionState.editingPaused],
  );
  const metaDenied = React.useCallback(() => canSetMetaKey(caps), [caps]);
  const structureDenied = React.useCallback(
    (): DenyReason | null =>
      sessionState.editingPaused && !boot.actor.owner ? 'Editing is paused' : canStructure(caps),
    [boot.actor.owner, caps, sessionState.editingPaused],
  );

  const confirmedSection = React.useCallback(
    (id: string) => editor.confirmed.sections.find((s) => s.id === id) ?? { id, rev: 0 },
    [editor],
  );

  const updateSection = React.useCallback<StudioContextValue['updateSection']>(
    (sectionId, set, label, unset = []) => {
      if (readOnly) return;
      const keys = [...Object.keys(set), ...unset] as SectionKey[];
      if (!keys.length || keys.some((k) => sectionDenied(sectionId, k))) return;
      const section = doc.sections.find((s) => s.id === sectionId);
      const name = label ?? `Edit ${section ? labelOf(section) : 'section'}`;
      editor.apply(sectionUpdate(confirmedSection(sectionId), set, unset), name);
    },
    [confirmedSection, doc.sections, editor, labelOf, readOnly, sectionDenied],
  );

  const updateTheme = React.useCallback<StudioContextValue['updateTheme']>(
    (set, label = 'Edit theme') => {
      if (readOnly) return;
      const allowed = Object.fromEntries(
        Object.entries(set).filter(([k]) => !themeDenied(k as ThemeKey)),
      );
      if (!Object.keys(allowed).length) return;
      editor.apply(themeUpdate(editor.confirmed.theme, allowed), label);
    },
    [editor, readOnly, themeDenied],
  );

  const updatePage = React.useCallback<StudioContextValue['updatePage']>(
    (set, label = 'Edit page settings') => {
      if (readOnly || metaDenied()) return;
      editor.apply(pageUpdate(editor.confirmed.meta, set), label);
    },
    [editor, metaDenied, readOnly],
  );

  const insertSection = React.useCallback<StudioContextValue['insertSection']>(
    (template, afterId) => {
      if (readOnly || structureDenied()) return null;
      const op = sectionInsert(doc, template, afterId);
      editor.apply(op, `Add ${labelOf({ ...op.section })}`);
      return op.section.id;
    },
    [doc, editor, labelOf, readOnly, structureDenied],
  );

  const duplicateSection = React.useCallback(
    (sectionId: string) => {
      if (readOnly || structureDenied()) return;
      const op = sectionDuplicate(doc, sectionId);
      if (!op) return;
      // A copy may not arrive gated by someone who cannot gate.
      if (!caps.editVisibility) op.section.visibility = { mode: 'everyone', tags: [] };
      editor.apply(op, `Duplicate ${labelOf(op.section)}`);
      select(op.section.id);
    },
    [caps.editVisibility, doc, editor, labelOf, readOnly, select, structureDenied],
  );

  const moveSection = React.useCallback(
    (sectionId: string, toIndex: number) => {
      if (readOnly || structureDenied()) return;
      const op = sectionMoveTo(doc, sectionId, toIndex);
      if (op) editor.apply(op, 'Move section');
    },
    [doc, editor, readOnly, structureDenied],
  );

  const stepSection = React.useCallback(
    (sectionId: string, step: -1 | 1) => {
      if (readOnly || structureDenied()) return;
      const op = sectionStep(doc, sectionId, step);
      if (op) editor.apply(op, 'Move section');
    },
    [doc, editor, readOnly, structureDenied],
  );

  const deleteSection = React.useCallback(
    (sectionId: string) => {
      if (readOnly || structureDenied()) return;
      const section = doc.sections.find((s) => s.id === sectionId);
      if (!section) return;
      editor.apply(sectionDelete(confirmedSection(sectionId)), `Delete ${labelOf(section)}`);
      if (selectedId === sectionId) select(null);
    },
    [
      confirmedSection,
      doc.sections,
      editor,
      labelOf,
      readOnly,
      select,
      selectedId,
      structureDenied,
    ],
  );

  const value: StudioContextValue = {
    boot,
    editor,
    session,
    doc,
    sessionState,
    readOnly,
    selectedId,
    select,
    device,
    setDevice,
    motion,
    setMotion,
    preview,
    setPreview,
    fullPreview,
    setFullPreview,
    railTab,
    setRailTab,
    galleryAfter,
    openGallery: (afterId) => setGalleryAfter(afterId),
    closeGallery: () => setGalleryAfter(undefined),
    mediaItems,
    setMediaItems,
    media,
    addMedia: (item) => setMedia((current) => ({ ...current, [item.id]: item })),
    versionPreview,
    setVersionPreview,
    publishedDoc: published.doc,
    publishedDraftVersion: published.draftVersion,
    markPublished: (publishedDoc, draftVersion) =>
      setPublished({ doc: publishedDoc, draftVersion }),
    overridden,
    override: (id) => setOverridden((prev) => new Set(prev).add(id)),
    labelOf,
    sectionDenied,
    themeDenied,
    metaDenied,
    structureDenied,
    updateSection,
    updateTheme,
    updatePage,
    insertSection,
    duplicateSection,
    moveSection,
    stepSection,
    deleteSection,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
