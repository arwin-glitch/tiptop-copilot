import { describe, expect, it } from 'vitest';
import { capabilitiesForGrant, ownerCapabilities } from '@/lib/events/capabilities';
import { newEventDoc, placeSection, sectionTemplate } from '@/lib/events/doc';
import { enforceOpScope } from '@/lib/events/editor-auth';
import { keyBetween } from '@/lib/events/fractional';
import { applyOps, changesSince } from '@/lib/events/merge';
import { draftOpsRequest, invertOp, type DraftOp } from '@/lib/events/ops';
import type { EventDoc } from '@/lib/events/schema';
import { getThemePreset } from '@/lib/events/themes';

/**
 * Property-level merge (D-075): edits to different keys merge, the same key
 * conflicts with the other person's value, moves are last-writer-wins on one
 * fractional key, and every op is all-or-nothing.
 */

const HERO = '00000000-0000-4000-8000-000000000001';
const AGENDA = '00000000-0000-4000-8000-000000000002';
const RSVP = '00000000-0000-4000-8000-000000000003';
const NEW = '00000000-0000-4000-8000-0000000000aa';

function base(): EventDoc {
  let n = 0;
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'Old headline', subheadline: 'Old sub' }),
      sectionTemplate('agenda', { heading: 'The day' }),
      sectionTemplate('rsvp', { cta: 'RSVP' }),
    ],
    () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`,
  );
}

/** A doc where Morgan changed the hero headline at version 5. */
function afterMorgan(): EventDoc {
  const r = applyOps(
    base(),
    [
      {
        kind: 'section.update',
        opId: 'm1',
        id: HERO,
        baseRev: 0,
        set: { 'props.headline': 'Morgan headline' },
      },
    ],
    { nextVersion: 5 },
  );
  expect(r.applied).toEqual(['m1']);
  return r.doc;
}

describe('section.update', () => {
  it('applies, bumping the section rev and the key revs to the new version', () => {
    const r = applyOps(
      base(),
      [
        {
          kind: 'section.update',
          opId: 'a',
          id: HERO,
          baseRev: 0,
          set: { 'props.headline': 'New' },
        },
      ],
      { nextVersion: 1 },
    );
    expect(r.applied).toEqual(['a']);
    const hero = r.doc.sections.find((s) => s.id === HERO)!;
    expect(hero.props.headline).toBe('New');
    expect(hero.rev).toBe(1);
    expect(hero.keyRevs['props.headline']).toBe(1);
    expect(r.changes.sections.map((s) => s.id)).toEqual([HERO]);
    expect(r.edits[0]).toMatchObject({ op: 'update', sectionId: HERO, keys: ['props.headline'] });
    expect(r.edits[0]!.before).toEqual({ 'props.headline': 'Old headline' });
  });

  it('merges an edit to a different key of the same section', () => {
    const r = applyOps(
      afterMorgan(),
      [
        {
          kind: 'section.update',
          opId: 'b',
          id: HERO,
          baseRev: 0,
          set: { 'props.subheadline': 'Arwin sub' },
        },
      ],
      { nextVersion: 6 },
    );
    expect(r.conflicts).toEqual([]);
    const hero = r.doc.sections.find((s) => s.id === HERO)!;
    expect(hero.props.headline).toBe('Morgan headline');
    expect(hero.props.subheadline).toBe('Arwin sub');
  });

  it('conflicts on the same key, with their value, and changes nothing', () => {
    const before = afterMorgan();
    const r = applyOps(
      before,
      [
        {
          kind: 'section.update',
          opId: 'c',
          id: HERO,
          baseRev: 0,
          set: { 'props.headline': 'Arwin headline', 'props.subheadline': 'x' },
        },
      ],
      { nextVersion: 6 },
    );
    expect(r.applied).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.conflicts[0]).toMatchObject({
      opId: 'c',
      kind: 'key_changed',
      sectionId: HERO,
      keys: ['props.headline'],
      theirs: { 'props.headline': 'Morgan headline' },
    });
    // All-or-nothing: the non-conflicting key was not applied either.
    expect(r.doc.sections.find((s) => s.id === HERO)!.props.subheadline).toBe('Old sub');
  });

  it('does not conflict when the client had already seen the change', () => {
    const r = applyOps(
      afterMorgan(),
      [
        {
          kind: 'section.update',
          opId: 'd',
          id: HERO,
          baseRev: 5,
          set: { 'props.headline': 'Seen it' },
        },
      ],
      { nextVersion: 6 },
    );
    expect(r.applied).toEqual(['d']);
  });

  it('a burst of edits to one key in one batch never conflicts with itself', () => {
    const ops: DraftOp[] = [
      { kind: 'section.update', opId: '1', id: HERO, baseRev: 0, set: { 'props.headline': 'H' } },
      { kind: 'section.update', opId: '2', id: HERO, baseRev: 0, set: { 'props.headline': 'He' } },
      { kind: 'section.update', opId: '3', id: HERO, baseRev: 0, set: { 'props.headline': 'Hey' } },
    ];
    const r = applyOps(base(), ops, { nextVersion: 1 });
    expect(r.applied).toEqual(['1', '2', '3']);
    expect(r.doc.sections.find((s) => s.id === HERO)!.props.headline).toBe('Hey');
  });

  it('an update to a deleted section is section_deleted', () => {
    const r = applyOps(
      base(),
      [
        { kind: 'section.delete', opId: 'del', id: AGENDA, baseRev: 0 },
        {
          kind: 'section.update',
          opId: 'u',
          id: AGENDA,
          baseRev: 0,
          set: { 'props.heading': 'x' },
        },
      ],
      { nextVersion: 1 },
    );
    expect(r.applied).toEqual(['del']);
    expect(r.conflicts[0]).toMatchObject({ opId: 'u', kind: 'section_deleted' });
    expect(r.changes.deletedSectionIds).toEqual([AGENDA]);
  });

  it('invalid values are refused per op', () => {
    const r = applyOps(
      base(),
      [
        { kind: 'section.update', opId: 'v', id: HERO, baseRev: 0, set: { variant: 'scorecard' } },
        {
          kind: 'section.update',
          opId: 'l',
          id: HERO,
          baseRev: 0,
          set: { 'props.href': 'javascript:x' },
        },
        { kind: 'section.update', opId: 's', id: HERO, baseRev: 0, set: { style: { css: 'x' } } },
      ],
      { nextVersion: 1 },
    );
    expect(r.applied).toEqual([]);
    expect(r.conflicts.map((c) => c.kind)).toEqual(['invalid', 'invalid', 'invalid']);
  });

  it('unset removes a prop', () => {
    const r = applyOps(
      base(),
      [
        {
          kind: 'section.update',
          opId: 'x',
          id: HERO,
          baseRev: 0,
          set: { name: 'Cover' },
          unset: ['props.subheadline'],
        },
      ],
      { nextVersion: 1 },
    );
    const hero = r.doc.sections.find((s) => s.id === HERO)!;
    expect('subheadline' in hero.props).toBe(false);
    expect(hero.name).toBe('Cover');
  });
});

describe('insert, move and delete', () => {
  it('insert places a section; a taken position is moved after afterId', () => {
    const doc = base();
    const template = sectionTemplate('faq', { heading: 'Questions' });
    const taken = doc.sections.find((s) => s.id === AGENDA)!.position;
    const r = applyOps(
      doc,
      [
        {
          kind: 'section.insert',
          opId: 'i',
          section: placeSection(template, NEW, taken),
          afterId: AGENDA,
        },
      ],
      { nextVersion: 1 },
    );
    expect(r.applied).toEqual(['i']);
    const inserted = r.doc.sections.find((s) => s.id === NEW)!;
    expect(inserted.position).not.toBe(taken);
    const agendaPos = doc.sections.find((s) => s.id === AGENDA)!.position;
    const rsvpPos = doc.sections.find((s) => s.id === RSVP)!.position;
    expect(inserted.position > agendaPos && inserted.position < rsvpPos).toBe(true);
    expect(inserted.rev).toBe(1);
  });

  it('insert with an existing id is section_exists', () => {
    const doc = base();
    const r = applyOps(
      doc,
      [
        {
          kind: 'section.insert',
          opId: 'i',
          section: structuredClone(doc.sections[0]!),
          afterId: null,
        },
      ],
      { nextVersion: 1 },
    );
    expect(r.conflicts[0]?.kind).toBe('section_exists');
  });

  it('two moves of the same section: the last writer wins', () => {
    const doc = base();
    const top = keyBetween(null, doc.sections[0]!.position);
    const r1 = applyOps(doc, [{ kind: 'section.move', opId: 'a', id: RSVP, position: top }], {
      nextVersion: 1,
    });
    const end = keyBetween(
      r1.doc.sections.find((s) => s.id === HERO)!.position,
      r1.doc.sections.find((s) => s.id === AGENDA)!.position,
    );
    const r2 = applyOps(r1.doc, [{ kind: 'section.move', opId: 'b', id: RSVP, position: end }], {
      nextVersion: 2,
    });
    expect(r2.doc.sections.find((s) => s.id === RSVP)!.position).toBe(end);
  });

  it('a move onto a taken position lands just after its holder', () => {
    const doc = base();
    const heroPos = doc.sections.find((s) => s.id === HERO)!.position;
    const r = applyOps(doc, [{ kind: 'section.move', opId: 'm', id: RSVP, position: heroPos }], {
      nextVersion: 1,
    });
    const moved = r.doc.sections.find((s) => s.id === RSVP)!.position;
    expect(moved > heroPos).toBe(true);
    expect(moved < doc.sections.find((s) => s.id === AGENDA)!.position).toBe(true);
  });

  it('delete conflicts when the section changed since, and is idempotent when gone', () => {
    const changed = applyOps(
      afterMorgan(),
      [{ kind: 'section.delete', opId: 'd', id: HERO, baseRev: 0 }],
      {
        nextVersion: 6,
      },
    );
    expect(changed.conflicts[0]?.kind).toBe('section_changed');
    const twice = applyOps(base(), [{ kind: 'section.delete', opId: 'd', id: NEW, baseRev: 0 }], {
      nextVersion: 1,
    });
    expect(twice.applied).toEqual(['d']);
    expect(twice.changed).toBe(false);
  });
});

describe('theme and page', () => {
  it('theme keys merge per key and conflict on the same key', () => {
    const preset = getThemePreset('tiptop-signature').theme;
    const first = applyOps(
      base(),
      [
        {
          kind: 'theme.update',
          opId: 't1',
          baseRev: 0,
          set: { palette: { ...preset.palette, accent: '#123456' } },
        },
      ],
      { nextVersion: 1 },
    );
    expect(first.applied).toEqual(['t1']);
    expect(first.changes.theme?.palette.accent).toBe('#123456');
    const other = applyOps(
      first.doc,
      [{ kind: 'theme.update', opId: 't2', baseRev: 0, set: { mode: 'dark' } }],
      { nextVersion: 2 },
    );
    expect(other.applied).toEqual(['t2']);
    const clash = applyOps(
      first.doc,
      [{ kind: 'theme.update', opId: 't3', baseRev: 0, set: { palette: preset.palette } }],
      { nextVersion: 2 },
    );
    expect(clash.conflicts[0]).toMatchObject({
      kind: 'key_changed',
      target: 'theme',
      keys: ['palette'],
    });
    const bad = applyOps(
      base(),
      [{ kind: 'theme.update', opId: 't4', baseRev: 0, set: { mode: 'neon' } }],
      {
        nextVersion: 1,
      },
    );
    expect(bad.conflicts[0]?.kind).toBe('invalid');
  });

  it('page meta updates', () => {
    const r = applyOps(
      base(),
      [{ kind: 'page.update', opId: 'p', baseRev: 0, set: { seoTitle: 'Hello' } }],
      {
        nextVersion: 1,
      },
    );
    expect(r.doc.meta.seoTitle).toBe('Hello');
    expect(changesSince(r.doc, 0).meta?.seoTitle).toBe('Hello');
    expect(changesSince(r.doc, 1).meta).toBeNull();
  });
});

describe('capabilities through the authorize hook', () => {
  const locks = { logo: true, palette: true, fonts: true, intro: true };

  it('an outside content editor scoped to one section can edit only its content', () => {
    const caps = capabilitiesForGrant(
      {
        role: 'editor',
        scope: { design: false, content: true, sections: [AGENDA], brand_locked: true },
      },
      locks,
    );
    const r = applyOps(
      base(),
      [
        {
          kind: 'section.update',
          opId: 'ok',
          id: AGENDA,
          baseRev: 0,
          set: { 'props.heading': 'Ours' },
        },
        {
          kind: 'section.update',
          opId: 'scope',
          id: HERO,
          baseRev: 0,
          set: { 'props.headline': 'x' },
        },
        {
          kind: 'section.update',
          opId: 'design',
          id: AGENDA,
          baseRev: 0,
          set: { variant: 'timeline' },
        },
        {
          kind: 'section.update',
          opId: 'gate',
          id: AGENDA,
          baseRev: 0,
          set: { visibility: { mode: 'everyone', tags: [] } },
        },
        { kind: 'section.delete', opId: 'struct', id: AGENDA, baseRev: 0 },
        { kind: 'theme.update', opId: 'theme', baseRev: 0, set: { mode: 'dark' } },
        { kind: 'page.update', opId: 'meta', baseRev: 0, set: { seoTitle: 'x' } },
      ],
      { nextVersion: 1, authorize: enforceOpScope(caps) },
    );
    expect(r.applied).toEqual(['ok']);
    expect(Object.fromEntries(r.conflicts.map((c) => [c.opId, c.message]))).toEqual({
      scope: 'Outside your scope',
      design: 'Outside your scope',
      gate: 'Only TipTop can change this',
      struct: 'Outside your scope',
      theme: 'Outside your scope',
      meta: 'Only TipTop can change this',
    });
    expect(r.conflicts.every((c) => c.kind === 'forbidden')).toBe(true);
  });

  it('a design editor cannot touch brand-locked theme keys or the brand itself', () => {
    const caps = capabilitiesForGrant(
      {
        role: 'editor',
        scope: { design: true, content: false, sections: 'all', brand_locked: true },
      },
      locks,
    );
    const preset = getThemePreset('tiptop-signature').theme;
    const r = applyOps(
      base(),
      [
        { kind: 'theme.update', opId: 'ok', baseRev: 0, set: { mode: 'dark' } },
        { kind: 'theme.update', opId: 'palette', baseRev: 0, set: { palette: preset.palette } },
        { kind: 'theme.update', opId: 'brand', baseRev: 0, set: { brand: preset.brand } },
      ],
      { nextVersion: 1, authorize: enforceOpScope(caps) },
    );
    expect(r.applied).toEqual(['ok']);
    expect(r.conflicts.map((c) => c.message)).toEqual([
      'Brand locked by TipTop',
      'Only TipTop can change this',
    ]);
  });

  it('owners can do everything; a viewer link nothing; a paused editor nothing', () => {
    const ops: DraftOp[] = [
      { kind: 'section.update', opId: 'x', id: HERO, baseRev: 0, set: { 'props.headline': 'y' } },
    ];
    expect(
      applyOps(base(), ops, { nextVersion: 1, authorize: enforceOpScope(ownerCapabilities()) })
        .applied,
    ).toEqual(['x']);
    const viewer = capabilitiesForGrant(
      {
        role: 'viewer',
        scope: { design: true, content: true, sections: 'all', brand_locked: false },
      },
      locks,
    );
    expect(
      applyOps(base(), ops, { nextVersion: 1, authorize: enforceOpScope(viewer) }).applied,
    ).toEqual([]);
    const paused = capabilitiesForGrant(
      {
        role: 'editor',
        scope: { design: true, content: true, sections: 'all', brand_locked: false },
        editingPaused: true,
      },
      locks,
    );
    expect(
      applyOps(base(), ops, { nextVersion: 1, authorize: enforceOpScope(paused) }).applied,
    ).toEqual([]);
  });

  it('an owner-only prop (from the registry) is locked for outsiders', () => {
    const caps = capabilitiesForGrant(
      {
        role: 'editor',
        scope: { design: false, content: true, sections: 'all', brand_locked: true },
      },
      locks,
    );
    const authorize = enforceOpScope(caps, {
      isOwnerOnlyProp: (type, key) => type === 'rsvp' && key === 'endpoint',
    });
    const r = applyOps(
      base(),
      [
        {
          kind: 'section.update',
          opId: 'label',
          id: RSVP,
          baseRev: 0,
          set: { 'props.cta': 'Join us' },
        },
        {
          kind: 'section.update',
          opId: 'wiring',
          id: RSVP,
          baseRev: 0,
          set: { 'props.endpoint': 'x' },
        },
      ],
      { nextVersion: 1, authorize },
    );
    expect(r.applied).toEqual(['label']);
    expect(r.conflicts[0]?.opId).toBe('wiring');
  });
});

describe('the request body and undo', () => {
  it('validates batches strictly', () => {
    expect(draftOpsRequest.safeParse({ baseVersion: 0, ops: [] }).success).toBe(false);
    expect(
      draftOpsRequest.safeParse({
        baseVersion: 0,
        ops: [
          {
            kind: 'section.update',
            opId: 'a',
            id: HERO,
            baseRev: 0,
            set: { 'props.x': 1 },
            extra: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      draftOpsRequest.safeParse({
        baseVersion: 0,
        ops: [{ kind: 'section.update', opId: 'a', id: HERO, baseRev: 0, set: { html: '<b>' } }],
      }).success,
    ).toBe(false);
    expect(
      draftOpsRequest.safeParse({
        baseVersion: 0,
        ops: [{ kind: 'theme.update', opId: 'a', baseRev: 0, set: { customCss: 'x' } }],
      }).success,
    ).toBe(false);
  });

  it('the inverse of an update restores the old value as a rev-checked op', () => {
    const doc = base();
    const op: DraftOp = {
      kind: 'section.update',
      opId: 'a',
      id: HERO,
      baseRev: 0,
      set: { 'props.headline': 'New' },
    };
    const applied = applyOps(doc, [op], { nextVersion: 1 });
    const inverse = invertOp(
      op,
      { section: doc.sections.find((s) => s.id === HERO)! },
      'undo-a',
      1,
    )!;
    expect(inverse).toMatchObject({
      kind: 'section.update',
      baseRev: 1,
      set: { 'props.headline': 'Old headline' },
    });
    const undone = applyOps(applied.doc, [inverse], { nextVersion: 2 });
    expect(undone.doc.sections.find((s) => s.id === HERO)!.props.headline).toBe('Old headline');
    // If someone changed it after, undo conflicts instead of overwriting.
    const later = applyOps(
      applied.doc,
      [
        {
          kind: 'section.update',
          opId: 'm',
          id: HERO,
          baseRev: 1,
          set: { 'props.headline': 'Morgan' },
        },
      ],
      { nextVersion: 2 },
    );
    const blocked = applyOps(later.doc, [inverse], { nextVersion: 3 });
    expect(blocked.conflicts[0]?.kind).toBe('key_changed');
  });

  it('insert and delete invert each other', () => {
    const doc = base();
    const del: DraftOp = { kind: 'section.delete', opId: 'd', id: AGENDA, baseRev: 0 };
    const inverse = invertOp(
      del,
      { section: doc.sections.find((s) => s.id === AGENDA)! },
      'undo-d',
      1,
    );
    expect(inverse?.kind).toBe('section.insert');
    const gone = applyOps(doc, [del], { nextVersion: 1 });
    const back = applyOps(gone.doc, [inverse!], { nextVersion: 2 });
    expect(back.doc.sections.some((s) => s.id === AGENDA)).toBe(true);
  });
});
