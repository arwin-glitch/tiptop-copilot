import { describe, expect, it } from 'vitest';
import { contrastProblems, contrastRatio, mediaUses, readyChecklist } from '@/lib/events/checklist';
import { shiftDays } from '@/lib/events/dates';
import { describeDiff, diffDocs, rebaseOnto } from '@/lib/events/diff';
import { applyOps } from '@/lib/events/merge';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { idSeq, sampleDoc } from '../helpers/events';

/**
 * The pure pieces behind Publish and History (D-075): the section-level diff
 * and its words, restoring onto current revisions, the Ready checklist, and
 * wall-clock date shifting for "Duplicate as next year".
 */

const labels = { block: (t: string) => t.charAt(0).toUpperCase() + t.slice(1) };

function edit(doc: EventDoc, mutate: (d: EventDoc) => void): EventDoc {
  const copy = structuredClone(doc);
  mutate(copy);
  return copy;
}

describe('diffDocs', () => {
  it('names changed keys per section, added and removed sections, theme and page', () => {
    const before = sampleDoc();
    const [hero, agenda, text] = before.sections;
    const after = edit(before, (d) => {
      d.sections[0]!.props.headline = 'New headline';
      d.sections[0]!.style = { ...d.sections[0]!.style, background: 'dark' };
      d.sections.splice(2, 1); // text removed
      d.sections[1]!.position = 'a5'; // agenda moved only
      d.theme.palette = { ...d.theme.palette, accent: '#1F5A46' };
      d.meta.seoTitle = 'Supper';
    });
    after.sections.push({ ...structuredClone(text!), id: idSeq('new')(), position: 'a9' });
    const diff = diffDocs(before, after);
    expect(diff.empty).toBe(false);
    const byId = new Map(diff.sections.map((c) => [c.sectionId, c]));
    expect(byId.get(hero!.id)).toMatchObject({
      change: 'changed',
      keys: ['style', 'props.headline'],
    });
    expect(byId.get(agenda!.id)).toMatchObject({ change: 'moved', keys: ['position'] });
    expect(byId.get(text!.id)?.change).toBe('removed');
    expect(diff.sections.filter((c) => c.change === 'added')).toHaveLength(1);
    expect(diff.theme).toEqual(['palette']);
    expect(diff.meta).toEqual(['seoTitle']);

    const words = describeDiff(diff, labels).map((l) => l.text);
    expect(words).toContain('Hero – style, headline');
    expect(words).toContain('Agenda – moved');
    expect(words).toContain('Text – removed');
    expect(words).toContain('Theme – colours');
    expect(words).toContain('Page – SEO title');
  });

  it('ignores revision bookkeeping and finds nothing between equal pages', () => {
    const doc = sampleDoc();
    const bumped = edit(doc, (d) => {
      d.sections[0]!.rev = 9;
      d.sections[0]!.keyRevs = { 'props.headline': 9 };
      d.theme.rev = 4;
    });
    expect(diffDocs(doc, bumped).empty).toBe(true);
    expect(diffDocs(null, doc).sections.every((c) => c.change === 'added')).toBe(true);
  });
});

describe('rebaseOnto (restore)', () => {
  it('lays old content over current revs: changed keys get the new rev, revs never go back', () => {
    const v1 = sampleDoc();
    const hero = v1.sections[0]!;
    // Two edits land after v1: headline (rev 1) and the agenda items (rev 2).
    const step1 = applyOps(
      v1,
      [
        {
          kind: 'section.update',
          opId: 'a',
          id: hero.id,
          baseRev: 0,
          set: { 'props.headline': 'Later' },
        },
      ],
      { nextVersion: 1 },
    ).doc;
    const agenda = step1.sections[1]!;
    const current = applyOps(
      step1,
      [
        {
          kind: 'section.update',
          opId: 'b',
          id: agenda.id,
          baseRev: 1,
          set: { 'props.items': [] },
        },
      ],
      { nextVersion: 2 },
    ).doc;

    const { doc, diff } = rebaseOnto(current, v1, 3);
    expect(parseEventDoc(doc).ok).toBe(true);
    const h = doc.sections.find((s) => s.id === hero.id)!;
    expect(h.props.headline).toBe('A fictional gathering');
    expect(h.rev).toBe(3);
    expect(h.keyRevs['props.headline']).toBe(3);
    // Untouched sections keep their current rev (sync does not resend them).
    const rsvp = doc.sections.find((s) => s.type === 'rsvp')!;
    expect(rsvp.rev).toBe(current.sections.find((s) => s.type === 'rsvp')!.rev);
    expect(diff.sections.map((c) => c.sectionId).sort()).toEqual([hero.id, agenda.id].sort());

    // A collaborator's pending edit to the restored key now conflicts; to another key it merges.
    const pending = applyOps(
      doc,
      [
        {
          kind: 'section.update',
          opId: 'x',
          id: hero.id,
          baseRev: 1,
          set: { 'props.headline': 'Mine' },
        },
        {
          kind: 'section.update',
          opId: 'y',
          id: hero.id,
          baseRev: 1,
          set: { 'props.subheadline': 'Ok' },
        },
      ],
      { nextVersion: 4 },
    );
    expect(pending.applied).toEqual(['y']);
    expect(pending.conflicts.map((c) => c.opId)).toEqual(['x']);
  });
});

describe('the Ready checklist', () => {
  const event = {
    title: 'Lakeside Founders Supper',
    slug: 'lakeside-supper',
    starts_at: '2030-05-01T23:00:00.000Z',
    venue: {
      kind: 'in_person' as const,
      name: 'The Boathouse',
      address: null,
      lat: null,
      lng: null,
      place_id: null,
      maps_url: null,
      online_url: null,
      reveal: 'public' as const,
      notes: null,
    },
    registration: { open: true } as never,
    access: 'open' as const,
    is_template: false,
  };

  it('blocks only on alt text; background images need none', () => {
    const doc = sampleDoc();
    const photo = '00000000-0000-4000-8000-00000000f001';
    const backdrop = '00000000-0000-4000-8000-00000000f002';
    doc.sections[0]!.props.image = { mediaId: photo };
    doc.sections[1]!.style = { ...doc.sections[1]!.style, backgroundMedia: { mediaId: backdrop } };
    expect(mediaUses(doc)).toEqual(
      expect.arrayContaining([
        { mediaId: photo, decorative: false },
        { mediaId: backdrop, decorative: true },
      ]),
    );
    const media: {
      id: string;
      kind: 'image';
      status: 'ready';
      alt: string | null;
      decorative: boolean;
    }[] = [
      { id: photo, kind: 'image' as const, status: 'ready' as const, alt: null, decorative: false },
      {
        id: backdrop,
        kind: 'image' as const,
        status: 'ready' as const,
        alt: null,
        decorative: false,
      },
    ];
    const items = readyChecklist({
      event,
      sessions: [],
      doc,
      media,
      ogRendered: true,
      blockLabel: labels.block,
    });
    const alt = items.find((i) => i.id === 'alt_text')!;
    expect(alt).toMatchObject({ ok: false, blocking: true });
    expect(alt.detail).toMatch(/1 image needs alt text/);
    expect(items.filter((i) => i.blocking).map((i) => i.id)).toEqual(['alt_text']);

    media[0]!.alt = 'Guests on the deck at sunset';
    const fixed = readyChecklist({
      event,
      sessions: [],
      doc,
      media,
      ogRendered: true,
      blockLabel: labels.block,
    });
    expect(fixed.every((i) => i.ok)).toBe(true);
  });

  it('warns about missing venue, RSVP, empty sections, unprocessed media and contrast', () => {
    const doc = sampleDoc();
    doc.sections = doc.sections.filter((s) => s.type !== 'rsvp');
    doc.sections[2]!.props = { heading: '', body: '' };
    doc.sections[0]!.props.image = { mediaId: '00000000-0000-4000-8000-00000000f009' };
    doc.theme.mode = 'light';
    doc.theme.palette = { ...doc.theme.palette, text: '#BBBBBB' };
    const items = readyChecklist({
      event: { ...event, venue: { ...event.venue, kind: 'hybrid' }, starts_at: null },
      sessions: [{ starts_at: null }],
      doc,
      media: [],
      ogRendered: false,
      blockLabel: labels.block,
    });
    const failing = items.filter((i) => !i.ok).map((i) => i.id);
    expect(failing).toEqual(
      expect.arrayContaining([
        'date',
        'venue',
        'rsvp',
        'media',
        'contrast',
        'empty_sections',
        'og',
      ]),
    );
    expect(items.find((i) => i.id === 'empty_sections')!.detail).toMatch(/Text/);
  });

  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
    expect(contrastProblems(sampleDoc().theme)).toEqual([]);
  });
});

describe('shiftDays', () => {
  it('keeps the wall-clock time across a DST change', () => {
    // 6:00 PM in Chicago in January (CST, UTC-6) …
    const jan = '2027-01-26T00:00:00.000Z';
    // … moved 182 days lands in July (CDT, UTC-5) still at 6:00 PM local.
    expect(shiftDays(jan, 182, 'America/Chicago')).toBe('2027-07-26T23:00:00.000Z');
    // A year on keeps the hour, too.
    expect(shiftDays(jan, 364, 'America/Chicago')).toBe('2028-01-25T00:00:00.000Z');
    expect(shiftDays(null, 10, 'America/Chicago')).toBeNull();
    expect(shiftDays(jan, 0, 'America/Chicago')).toBe(jan);
    expect(shiftDays(jan, 1, 'Not/AZone')).toBe('2027-01-27T00:00:00.000Z');
  });
});
