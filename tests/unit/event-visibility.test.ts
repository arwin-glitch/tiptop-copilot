import { describe, expect, it } from 'vitest';
import { PUBLIC_VIEWER, SAMPLE_GUEST_VIEWER, type EventViewer } from '@/lib/events/contracts';
import { newEventDoc, sectionTemplate } from '@/lib/events/doc';
import type { EventDoc, VisibilityMode } from '@/lib/events/schema';
import { getThemePreset } from '@/lib/events/themes';
import {
  filterDocForViewer,
  ruleAllows,
  sessionVisibleTo,
  venueForViewer,
  viewerForGuest,
} from '@/lib/events/visibility';
import type { EventGuestStatus, EventVenue } from '@/lib/types/domain';

/**
 * Server-side gating (D-075): a section, field or list item a viewer does
 * not qualify for is removed from the document, never hidden with CSS; the
 * venue's address follows the reveal rule. Fictional data.
 */

let n = 0;
const id = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

function viewer(statuses: Record<string, EventGuestStatus>, tags: string[] = []): EventViewer {
  return viewerForGuest(
    { id: 'g1', first_name: 'Robin', last_name: 'Example', company: 'Sample Co', tags },
    Object.entries(statuses).map(([session_id, status]) => ({
      guest_id: 'g1',
      session_id,
      status,
    })),
  );
}

const going = viewer({ s1: 'going' });
const pending = viewer({ s1: 'pending' });
const waitlistedLp = viewer({ s1: 'waitlist' }, ['LP']);
const invitedLp = viewer({ s1: 'invited' }, ['LP']);
const goingLp = viewer({ s1: 'going' }, ['lp']);
const owner: EventViewer = { ...PUBLIC_VIEWER, kind: 'owner' };

function gatedDoc(): EventDoc {
  const doc = newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'Welcome' }),
      sectionTemplate('text', { heading: 'Registered only', body: 'Pre-reads soon' }),
      sectionTemplate('materials', {
        heading: 'Pre-reads',
        items: [
          { title: 'Agenda', visibility: { mode: 'everyone', tags: [] } },
          { title: 'Fund letter', visibility: { mode: 'tags', tags: ['LP'] } },
          { title: 'Broken rule', visibility: { mode: 'nope' } },
        ],
      }),
      sectionTemplate('agenda', {
        items: [
          { title: 'Meeting talk', sessionId: 's1' },
          { title: 'Reception toast', sessionId: 's2' },
          { title: 'Untied item' },
        ],
      }),
      sectionTemplate('venue', { address: '100 Example Avenue', note: 'Courtyard entrance' }),
      sectionTemplate('join_remote', {
        heading: 'Join remotely',
        joinUrl: 'https://example.com/meet',
        fieldVisibility: { joinUrl: { mode: 'going', tags: [] } },
      }),
    ],
    id,
  );
  const modes: VisibilityMode[] = [
    'everyone',
    'registered',
    'tags',
    'everyone',
    'everyone',
    'everyone',
  ];
  doc.sections.forEach((s, i) => {
    s.visibility = { mode: modes[i]!, tags: modes[i] === 'tags' ? ['LP'] : [] };
  });
  return doc;
}

describe('rules', () => {
  it('match the spec: everyone, registered, going, tags (in good standing), hidden', () => {
    const rule = (mode: VisibilityMode, tags: string[] = []) => ({ mode, tags });
    expect(ruleAllows(rule('everyone'), PUBLIC_VIEWER)).toBe(true);
    expect(ruleAllows(rule('hidden'), going)).toBe(false);
    expect(ruleAllows(rule('hidden'), owner)).toBe(true);
    expect(ruleAllows(rule('registered'), PUBLIC_VIEWER)).toBe(false);
    expect(ruleAllows(rule('registered'), pending)).toBe(true);
    expect(ruleAllows(rule('going'), pending)).toBe(false);
    expect(ruleAllows(rule('going'), going)).toBe(true);
    // Tags: the tag (case-insensitive) and good standing.
    expect(ruleAllows(rule('tags', ['LP']), goingLp)).toBe(true);
    expect(ruleAllows(rule('tags', ['LP']), invitedLp)).toBe(true);
    expect(ruleAllows(rule('tags', ['LP']), waitlistedLp)).toBe(false);
    expect(ruleAllows(rule('tags', ['LP']), going)).toBe(false);
    expect(ruleAllows(rule('tags', ['LP']), PUBLIC_VIEWER)).toBe(false);
    // Studio's sample guest (statuses unknown) previews tag-gated content when tagged.
    expect(ruleAllows(rule('tags', ['LP']), { ...SAMPLE_GUEST_VIEWER, tags: ['LP'] })).toBe(true);
  });
});

describe('filterDocForViewer', () => {
  it('removes gated sections for the public, keeps them for owners', () => {
    const doc = gatedDoc();
    const publicDoc = filterDocForViewer(doc, PUBLIC_VIEWER);
    expect(publicDoc.sections.map((s) => s.type)).toEqual([
      'hero',
      'agenda',
      'venue',
      'join_remote',
    ]);
    expect(filterDocForViewer(doc, owner)).toBe(doc);
    expect(filterDocForViewer(doc, goingLp).sections.map((s) => s.type)).toContain('materials');
  });

  it('removes gated list items, malformed rules included, and items of hidden sessions', () => {
    const doc = gatedDoc();
    const forGoing = filterDocForViewer(doc, going, { visibleSessionIds: new Set(['s1']) });
    const agenda = forGoing.sections.find((s) => s.type === 'agenda')!;
    expect((agenda.props.items as { title: string }[]).map((i) => i.title)).toEqual([
      'Meeting talk',
      'Untied item',
    ]);
    const forLp = filterDocForViewer(doc, goingLp, { visibleSessionIds: new Set(['s1', 's2']) });
    const materials = forLp.sections.find((s) => s.type === 'materials')!;
    expect((materials.props.items as { title: string }[]).map((i) => i.title)).toEqual([
      'Agenda',
      'Fund letter',
    ]);
  });

  it('removes fields gated by fieldVisibility and never sends the map', () => {
    const doc = gatedDoc();
    const remote = (v: EventViewer) =>
      filterDocForViewer(doc, v).sections.find((s) => s.type === 'join_remote')!.props;
    expect(remote(PUBLIC_VIEWER)).not.toHaveProperty('joinUrl');
    expect(remote(PUBLIC_VIEWER)).not.toHaveProperty('fieldVisibility');
    expect(remote(going).joinUrl).toBe('https://example.com/meet');
  });

  it('strips address-like props from venue sections when the address is not revealed', () => {
    const doc = gatedDoc();
    const venue = filterDocForViewer(doc, PUBLIC_VIEWER, { venueRevealed: false }).sections.find(
      (s) => s.type === 'venue',
    )!;
    expect(venue.props).not.toHaveProperty('address');
    expect(venue.props.note).toBe('Courtyard entrance');
  });

  it('never mutates the stored document', () => {
    const doc = gatedDoc();
    const before = JSON.stringify(doc);
    filterDocForViewer(doc, PUBLIC_VIEWER, { visibleSessionIds: new Set(), venueRevealed: false });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('sessions and venue', () => {
  it('shows tag-limited sessions only to those tags, or to a guest already placed in them', () => {
    const reception = { id: 's2', visible_to_tags: ['Reception'] };
    expect(sessionVisibleTo(reception, PUBLIC_VIEWER)).toBe(false);
    expect(sessionVisibleTo(reception, viewer({}, ['reception']))).toBe(true);
    expect(sessionVisibleTo(reception, viewer({ s2: 'invited' }))).toBe(true);
    expect(sessionVisibleTo({ id: 's1', visible_to_tags: [] }, PUBLIC_VIEWER)).toBe(true);
  });

  it('reveals the address by rule, on the server', () => {
    const venue: EventVenue = {
      kind: 'in_person',
      name: 'The Lantern Hall',
      address: '100 Example Avenue',
      lat: 1,
      lng: 2,
      place_id: null,
      maps_url: 'https://maps.example.com/x',
      online_url: null,
      reveal: 'going',
      notes: 'Courtyard',
    };
    const hidden = venueForViewer(venue, pending);
    expect(hidden).toMatchObject({
      name: 'The Lantern Hall',
      address: null,
      lat: null,
      mapsUrl: null,
      notes: null,
      revealed: false,
    });
    expect(venueForViewer(venue, going)).toMatchObject({
      address: '100 Example Avenue',
      revealed: true,
    });
    expect(venueForViewer({ ...venue, reveal: 'registered' }, pending).revealed).toBe(true);
    expect(venueForViewer({ ...venue, reveal: 'public' }, PUBLIC_VIEWER).revealed).toBe(true);
  });

  it('builds a guest viewer from their rows', () => {
    expect(going).toMatchObject({
      kind: 'guest',
      firstName: 'Robin',
      name: 'Robin Example',
      registered: true,
      going: true,
    });
    expect(pending).toMatchObject({ registered: true, going: false });
    expect(viewer({ s1: 'invited' })).toMatchObject({ registered: false, going: false });
  });
});
