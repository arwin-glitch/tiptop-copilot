import { describe, expect, it } from 'vitest';
import { blockRegistry } from '@/lib/events/blocks';
import { newEventDoc, sectionTemplate } from '@/lib/events/doc';
import {
  checkPalette,
  contrastRatio,
  fixContrast,
  paletteFromColors,
} from '@/lib/events/editor/contrast';
import {
  coalesce,
  diffSection,
  opKeys,
  sectionDuplicate,
  sectionInsert,
  sectionMoveTo,
  sectionStep,
  sectionUpdateFromDiff,
} from '@/lib/events/editor/doc-ops';
import { fieldsFor, inferFields, sectionLabel } from '@/lib/events/editor/fields';
import { factsForViewer, viewerFor } from '@/lib/events/editor/preview';
import {
  OUTSIDER_OVERRIDE_AFTER_MS,
  PresenceTracker,
  softLockFor,
} from '@/lib/events/editor/presence';
import {
  diffLine,
  isEmptySection,
  mediaIdsInDoc,
  publishDiff,
  readyChecklist,
} from '@/lib/events/editor/publish';
import { readSyncQuery, syncQueryString } from '@/lib/events/editor/sync-query';
import type { EventPublicFacts, PresenceEntry } from '@/lib/events/contracts';
import { draftOp } from '@/lib/events/ops';
import { applyOps } from '@/lib/events/merge';
import { orderedSections, type EventDoc } from '@/lib/events/schema';
import { getThemePreset } from '@/lib/events/themes';

/**
 * Studio's pure helpers: edits as ops, the publish diff and checklist,
 * contrast, inferred fields, preview viewers, soft locks and the sync query.
 * Fictional content only.
 */

let n = 0;
const ids = () => `0f000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

function doc(): EventDoc {
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'Riverside Supper', subheadline: '' }),
      sectionTemplate('text', { heading: 'About', body: 'An evening for founders.' }),
      sectionTemplate('faq', { heading: 'Questions', items: [{ q: 'Parking?', a: 'Next door.' }] }),
    ],
    ids,
  );
}

describe('edits as ops', () => {
  it('diffs a section into one rev-checked update, with removed props unset', () => {
    const d = doc();
    const before = d.sections[1]!;
    const after = {
      ...before,
      name: 'Story',
      props: { heading: 'Our story' },
      style: { ...before.style, padding: 'xl' as const },
    };
    expect(diffSection(before, after)).toEqual({
      set: { name: 'Story', style: after.style, 'props.heading': 'Our story' },
      unset: ['props.body'],
    });
    const op = sectionUpdateFromDiff(before, after)!;
    expect(draftOp.safeParse(op).success).toBe(true);
    expect(op).toMatchObject({ kind: 'section.update', id: before.id, baseRev: before.rev });
    expect(sectionUpdateFromDiff(before, before)).toBeNull();
  });

  it('inserts, duplicates and moves with fractional positions the server accepts', () => {
    const d = doc();
    const insert = sectionInsert(d, sectionTemplate('divider', {}), d.sections[0]!.id);
    const dup = sectionDuplicate(d, d.sections[2]!.id)!;
    const toTop = sectionMoveTo(d, d.sections[2]!.id, 0)!;
    for (const op of [insert, dup, toTop]) expect(draftOp.safeParse(op).success).toBe(true);
    const merged = applyOps(d, [insert, dup, toTop], { nextVersion: 1 });
    expect(merged.applied).toHaveLength(3);
    const order = orderedSections(merged.doc.sections).map((s) => s.type);
    expect(order).toEqual(['faq', 'hero', 'divider', 'text', 'faq']);
    expect(dup.section.props).toEqual(d.sections[2]!.props);
    expect(dup.section.id).not.toBe(d.sections[2]!.id);
    expect(sectionStep(d, d.sections[0]!.id, -1)).toBeNull();
    expect(sectionMoveTo(d, d.sections[0]!.id, 0)).toBeNull();
  });

  it('folds a burst of typing into one op and keeps the first baseRev', () => {
    const d = doc();
    const s = d.sections[0]!;
    const a = {
      kind: 'section.update' as const,
      opId: 'a',
      id: s.id,
      baseRev: 3,
      set: { 'props.headline': 'Riv' },
    };
    const b = {
      kind: 'section.update' as const,
      opId: 'b',
      id: s.id,
      baseRev: 5,
      set: { 'props.headline': 'River' },
    };
    expect(coalesce(a, b)).toEqual({ ...a, set: { 'props.headline': 'River' } });
    const other = { ...b, set: { 'props.subheadline': 'x' } };
    expect(coalesce(a, other)).toBeNull();
    expect(opKeys(a)).toEqual(['props.headline']);
  });
});

describe('the publish dialog', () => {
  it('lists section changes in page order with readable field names', () => {
    const published = doc();
    const draft = structuredClone(published);
    draft.sections[0]!.props.headline = 'Riverside Supper 2031';
    draft.sections.splice(2, 1);
    draft.sections.push({ ...structuredClone(published.sections[1]!), id: ids(), position: 'z0' });
    draft.theme.palette.accent = '#123456';
    const items = publishDiff(published, draft, (s) => sectionLabel(s, blockRegistry));
    expect(items.map(diffLine)).toEqual([
      'Cover – headline',
      'Text – added',
      'FAQ – removed',
      'Theme – palette',
    ]);
  });

  it('blocks on missing alt text and warns on the rest', () => {
    const d = doc();
    const mediaId = ids();
    d.sections[0]!.props.mediaId = mediaId;
    d.sections.push({
      ...structuredClone(d.sections[1]!),
      id: ids(),
      position: 'z1',
      props: { heading: '', body: '' },
    });
    d.theme.palette.muted = '#DDDDDD';
    const facts = {
      title: 'Riverside Supper',
      startsAt: '2031-05-01T23:00:00Z',
      venue: { kind: 'in_person', name: 'The Boathouse', address: null, onlineUrl: null },
      registrationOpen: true,
      slug: 'riverside-supper',
      path: '/e/riverside-supper',
    } as unknown as EventPublicFacts;
    const list = readyChecklist({
      doc: d,
      facts,
      media: [
        {
          id: mediaId,
          kind: 'image',
          status: 'ready',
          alt: null,
          decorative: false,
          name: 'cover.jpg',
          colors: [],
          previewUrl: null,
        },
      ],
      labelOf: (s) => sectionLabel(s, blockRegistry),
    });
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(byId.alt).toMatchObject({ ok: false, blocking: true });
    expect(byId.rsvp).toMatchObject({ ok: false, blocking: false });
    expect(byId.contrast?.ok).toBe(false);
    expect(byId.empty?.ok).toBe(false);
    expect(byId.basics?.ok).toBe(true);
    expect(mediaIdsInDoc(d)).toEqual([mediaId]);
    expect(isEmptySection(d.sections.at(-1)!)).toBe(true);
    expect(isEmptySection(d.sections[0]!)).toBe(false);
  });
});

describe('contrast', () => {
  it('grades pairs and fixes a colour only toward the target', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    const fixed = fixContrast('#9A9A9A', '#FFFFFF');
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(fixContrast('#000000', '#FFFFFF')).toBe('#000000');
    const signature = getThemePreset('tiptop-signature').theme;
    expect(checkPalette(signature.palette).every((p) => p.ratio >= 4.5)).toBe(true);
    const fromLogo = paletteFromColors(['#E4572E', '#29335C'], signature.palette);
    expect(checkPalette(fromLogo).every((p) => p.ratio >= 4.5)).toBe(true);
  });
});

describe('inspector fields', () => {
  it('falls back to known fields, then infers the rest from props', () => {
    const d = doc();
    const faq = fieldsFor(undefined, d.sections[2]!);
    expect(faq.fromRegistry).toBe(false);
    expect(faq.fields.map((f) => f.key)).toEqual(['heading', 'items']);
    const inferred = inferFields({
      ctaHref: 'https://example.com',
      count: 3,
      people: [{ name: 'A', photoMediaId: null }],
    });
    expect(inferred.map((f) => [f.key, f.kind])).toEqual([
      ['ctaHref', 'link'],
      ['count', 'number'],
      ['people', 'list'],
    ]);
    expect(inferred[2]!.itemFields!.map((f) => f.kind)).toEqual(['text', 'media']);
  });
});

describe('preview as', () => {
  const facts = {
    venue: {
      kind: 'in_person',
      name: 'The Boathouse',
      address: '1 River Rd',
      lat: 1,
      lng: 2,
      mapsUrl: 'https://maps.example.com',
      onlineUrl: null,
      notes: null,
      revealRule: 'going',
      revealed: true,
    },
  } as unknown as EventPublicFacts;

  it('hides a gated venue from viewers who do not qualify', () => {
    expect(factsForViewer(facts, viewerFor({ kind: 'public' }, [])).venue?.address).toBeNull();
    expect(factsForViewer(facts, viewerFor({ kind: 'going' }, [])).venue?.address).toBe(
      '1 River Rd',
    );
    expect(viewerFor({ kind: 'tag', tag: 'LP' }, []).tags).toEqual(['LP']);
    expect(viewerFor({ kind: 'sample' }, []).firstName).toBe('Sarah');
  });
});

describe('soft locks', () => {
  const morgan: PresenceEntry = {
    actorKey: 'g:1',
    name: 'Morgan',
    color: '#3B5BA9',
    outside: true,
    focusedSectionId: 'sec',
    typing: true,
    lastSeenAt: new Date().toISOString(),
    active: true,
  };

  it('locks a section someone else is in; owners override at once, outsiders after 60 s', () => {
    const tracker = new PresenceTracker();
    tracker.observe([morgan], 1_000);
    const owner = softLockFor(
      'sec',
      [morgan],
      { actorKey: 'u:1', owner: true },
      tracker,
      new Set(),
      2_000,
    );
    expect(owner).toMatchObject({ canOverride: true });
    const outsider = softLockFor(
      'sec',
      [morgan],
      { actorKey: 'g:2', owner: false },
      tracker,
      new Set(),
      2_000,
    );
    expect(outsider).toMatchObject({ canOverride: false, overrideInSeconds: 59 });
    tracker.observe([{ ...morgan, typing: false }], 30_000);
    const later = softLockFor(
      'sec',
      [morgan],
      { actorKey: 'g:2', owner: false },
      tracker,
      new Set(),
      1_000 + OUTSIDER_OVERRIDE_AFTER_MS,
    );
    expect(later?.canOverride).toBe(true);
    expect(
      softLockFor(
        'sec',
        [morgan],
        { actorKey: 'g:2', owner: false },
        tracker,
        new Set(['sec']),
        2_000,
      ),
    ).toBeNull();
    expect(
      softLockFor(
        'sec',
        [{ ...morgan, active: false }],
        { actorKey: 'u:1', owner: true },
        tracker,
        new Set(),
        2_000,
      ),
    ).toBeNull();
  });
});

describe('the sync query', () => {
  it('round-trips and drops anything that is not an id', () => {
    const q = {
      since: 7,
      presence: { focusedSectionId: '0f000000-0000-4000-8000-000000000001', typing: true },
    };
    expect(readSyncQuery(new URLSearchParams(syncQueryString(q)))).toEqual(q);
    expect(readSyncQuery(new URLSearchParams('since=-3&focus=<script>&typing=yes'))).toEqual({
      since: 0,
      presence: { focusedSectionId: null, typing: false },
    });
  });
});
