import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilitiesForGrant } from '@/lib/events/capabilities';
import type { EventActor, EventGrant } from '@/lib/events/contracts';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import { parseEventDoc } from '@/lib/events/schema';
import {
  applyDraftOps,
  createEvent,
  getDraft,
  getEvent,
  getEventSessions,
  libraryTab,
  listEvents,
  ownerActor,
  slugify,
  slugProblem,
  type EventOwner,
} from '@/lib/services/events';
import { guestCounts, guestLevelStatus } from '@/lib/services/event-guests';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';

/**
 * The events service on the demo store (D-075): creating events, the
 * library, and draft ops under the compare-and-set. Fictional data only.
 */

let h: Harness;
let owner: EventOwner;

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
});

afterEach(async () => {
  await h.dispose();
});

describe('slugs', () => {
  it('are made from titles and checked', () => {
    expect(slugify('Annual Meeting 2027!')).toBe('annual-meeting-2027');
    expect(slugify('Café Soirée — Spring')).toBe('cafe-soiree-spring');
    expect(slugify('***')).toBe('event');
    expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(50);
    expect(slugProblem('edit')).toMatch(/reserved/);
    expect(slugProblem('Bad Slug')).toMatch(/lowercase/);
    expect(slugProblem('-dash')).not.toBeNull();
    expect(slugProblem('good-slug-1')).toBeNull();
  });
});

describe('createEvent', () => {
  it('creates a draft with a valid page, one session and an audit row', async () => {
    const created = await createEvent(h.store, owner, {
      title: 'Spring Founders Dinner',
      startsAt: '2030-04-10T23:00:00.000Z',
      endsAt: '2030-04-11T02:00:00.000Z',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({
      slug: 'spring-founders-dinner',
      status: 'draft',
      draft_version: 0,
    });
    expect(parseEventDoc(created.value.draft_doc).ok).toBe(true);
    const sessions = await getEventSessions(h.store, owner.organizationId, created.value.id);
    expect(sessions.ok && sessions.value.map((s) => s.name)).toEqual(['Spring Founders Dinner']);
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.created', entity_id: created.value.id },
    });
    expect(audit).toHaveLength(1);
  });

  it('takes several sessions and spans the event across them', async () => {
    const created = await createEvent(h.store, owner, {
      title: 'Two Part Day',
      sessions: [
        {
          name: 'Meeting',
          startsAt: '2030-01-25T19:00:00.000Z',
          endsAt: '2030-01-25T23:00:00.000Z',
        },
        {
          name: 'Reception',
          startsAt: '2030-01-26T00:00:00.000Z',
          endsAt: '2030-01-26T03:00:00.000Z',
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.starts_at).toBe('2030-01-25T19:00:00.000Z');
    expect(created.value.ends_at).toBe('2030-01-26T03:00:00.000Z');
    const sessions = await getEventSessions(h.store, owner.organizationId, created.value.id);
    expect(sessions.ok && sessions.value.map((s) => s.name)).toEqual(['Meeting', 'Reception']);
  });

  it('never reuses a slug: a second event with the same title gets -2', async () => {
    const a = await createEvent(h.store, owner, { title: 'Holiday Party' });
    const b = await createEvent(h.store, owner, { title: 'Holiday Party' });
    expect(a.ok && a.value.slug).toBe('holiday-party');
    expect(b.ok && b.value.slug).toBe('holiday-party-2');
    const taken = await createEvent(h.store, owner, { title: 'Another', slug: 'holiday-party' });
    expect(!taken.ok && taken.error.code).toBe('conflict');
  });

  it('refuses bad input plainly', async () => {
    expect((await createEvent(h.store, owner, { title: '' })).ok).toBe(false);
    expect((await createEvent(h.store, owner, { title: 'x', timeZone: 'Mars/Olympus' })).ok).toBe(
      false,
    );
    expect((await createEvent(h.store, owner, { title: 'x', slug: 'checkin' })).ok).toBe(false);
    expect((await createEvent(h.store, owner, { title: 'x', startsAt: 'tomorrow-ish' })).ok).toBe(
      false,
    );
  });
});

describe('the library', () => {
  it('lists the fictional fixtures on the right tabs with guest counts', async () => {
    const upcoming = await listEvents(h.store, owner.organizationId, { tab: 'upcoming' });
    const drafts = await listEvents(h.store, owner.organizationId, { tab: 'drafts' });
    expect(upcoming.ok && upcoming.value.map((e) => e.slug)).toEqual([
      DEMO_EVENT_SLUGS.annualMeeting,
    ]);
    expect(drafts.ok && drafts.value.map((e) => e.slug)).toEqual([DEMO_EVENT_SLUGS.puttingNight]);
    const card = upcoming.ok ? upcoming.value[0]! : null;
    // Avery, Bianca, Eli and Eli's plus-one are going; Dana pending; Carlos invited.
    expect(card?.counts).toMatchObject({ going: 4, pending: 1, invited: 1, plusOnes: 1, total: 6 });
    expect(card?.swatch).toEqual({ bg: '#F6F1E4', accent: '#2B6D56', text: '#0E2720' });
    expect(card?.hasUnpublishedChanges).toBe(false);
  });

  it('searches by title and puts past and template events on their tabs', async () => {
    const found = await listEvents(h.store, owner.organizationId, { search: 'putting' });
    expect(found.ok && found.value.map((e) => e.id)).toEqual([DEMO_EVENT_IDS.puttingNight]);
    const event = await getEvent(h.store, owner.organizationId, DEMO_EVENT_IDS.annualMeeting);
    if (!event.ok) throw new Error('fixture missing');
    expect(libraryTab({ ...event.value, ends_at: '2001-01-01T00:00:00.000Z' })).toBe('past');
    expect(libraryTab({ ...event.value, is_template: true })).toBe('templates');
  });

  it('counts by guest-level status: the strongest across sessions', async () => {
    expect(guestLevelStatus(['not_going', 'pending'])).toBe('pending');
    expect(guestLevelStatus(['maybe', 'going'])).toBe('going');
    expect(guestLevelStatus([])).toBe('invited');
    const counts = await guestCounts(h.store, owner.organizationId, [DEMO_EVENT_IDS.puttingNight]);
    expect(counts[DEMO_EVENT_IDS.puttingNight]?.total).toBe(0);
  });

  it('never shows another organization’s events', async () => {
    const other = await addSecondOrganization(h);
    const list = await listEvents(h.store, other.organizationId);
    expect(list.ok && list.value).toEqual([]);
    expect((await getEvent(h.store, other.organizationId, DEMO_EVENT_IDS.annualMeeting)).ok).toBe(
      false,
    );
  });
});

describe('draft ops', () => {
  async function draftOf(actor: EventActor) {
    const d = await getDraft(h.store, actor, DEMO_EVENT_IDS.puttingNight);
    if (!d.ok) throw new Error(d.error.message);
    return d.value;
  }

  it('applies a batch, bumps draft_version and logs who changed what', async () => {
    const actor = ownerActor(owner);
    const before = await draftOf(actor);
    const hero = before.doc.sections.find((s) => s.type === 'hero')!;
    const result = await applyDraftOps(h.store, actor, DEMO_EVENT_IDS.puttingNight, {
      baseVersion: before.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'a1',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.headline': 'Putt Night' },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      version: before.version + 1,
      applied: ['a1'],
      conflicts: [],
    });
    const after = await draftOf(actor);
    expect(after.version).toBe(before.version + 1);
    expect(after.doc.sections.find((s) => s.id === hero.id)!.props.headline).toBe('Putt Night');
    const edits = await h.store.list('event_edits', owner.organizationId, {
      eq: { event_id: DEMO_EVENT_IDS.puttingNight },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      section_id: hero.id,
      op: 'update',
      keys: ['props.headline'],
      actor_key: `u:${owner.userId}`,
      author_name: 'Demo Owner',
    });
  });

  it('a conflict names the person whose change won', async () => {
    const actor = ownerActor(owner);
    const before = await draftOf(actor);
    const hero = before.doc.sections.find((s) => s.type === 'hero')!;
    const morgan: EventActor = { ...actor, name: 'Morgan Example' } as EventActor;
    await applyDraftOps(h.store, morgan, DEMO_EVENT_IDS.puttingNight, {
      baseVersion: before.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'm',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.headline': 'Morgan' },
        },
      ],
    });
    const mine = await applyDraftOps(h.store, actor, DEMO_EVENT_IDS.puttingNight, {
      baseVersion: before.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'a',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.headline': 'Mine' },
        },
      ],
    });
    expect(mine.ok && mine.value.conflicts[0]).toMatchObject({
      kind: 'key_changed',
      theirs: { 'props.headline': 'Morgan' },
      by: { name: 'Morgan Example' },
    });
    expect(mine.ok && mine.value.version).toBe(before.version + 1);
  });

  it('refuses a malformed body and an unknown event', async () => {
    const actor = ownerActor(owner);
    const bad = await applyDraftOps(h.store, actor, DEMO_EVENT_IDS.puttingNight, { ops: 'nope' });
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
    const missing = await applyDraftOps(h.store, actor, '00000000-0000-4000-8000-00000000dead', {
      baseVersion: 0,
      ops: [{ kind: 'page.update', opId: 'p', baseRev: 0, set: { seoTitle: 'x' } }],
    });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('an outside link only reaches its own event, and only its scope; paused means read-only', async () => {
    const event = await getEvent(h.store, owner.organizationId, DEMO_EVENT_IDS.puttingNight);
    if (!event.ok) throw new Error('fixture missing');
    const scope = { design: false, content: true, sections: 'all' as const, brand_locked: true };
    const grant: EventGrant = {
      grantId: '00000000-0000-4000-8000-0000000000a1',
      eventId: DEMO_EVENT_IDS.puttingNight,
      organizationId: owner.organizationId,
      role: 'editor',
      scope,
      label: 'Morgan – Example Club',
      tokenVersion: 1,
      expiresAt: '2099-01-01T00:00:00.000Z',
      capabilities: capabilitiesForGrant(
        { role: 'editor', scope },
        { logo: true, palette: true, fonts: true, intro: true },
      ),
    };
    const outsider: EventActor = { kind: 'grant', grant, name: 'Morgan' };

    const elsewhere = await getDraft(h.store, outsider, DEMO_EVENT_IDS.annualMeeting);
    expect(!elsewhere.ok && elsewhere.error.code).toBe('not_found');

    const draft = await draftOf(outsider);
    const hero = draft.doc.sections.find((s) => s.type === 'hero')!;
    const result = await applyDraftOps(h.store, outsider, DEMO_EVENT_IDS.puttingNight, {
      baseVersion: draft.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'copy',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.subheadline': 'Bring a putter' },
        },
        { kind: 'theme.update', opId: 'theme', baseRev: 0, set: { mode: 'dark' } },
      ],
    });
    expect(result.ok && result.value.applied).toEqual(['copy']);
    expect(result.ok && result.value.conflicts.map((c) => c.kind)).toEqual(['forbidden']);
    const edits = await h.store.list('event_edits', owner.organizationId, {
      eq: { event_id: DEMO_EVENT_IDS.puttingNight },
    });
    expect(edits[0]?.actor_key).toBe(`g:${grant.grantId}`);

    await h.store.update('events', owner.organizationId, DEMO_EVENT_IDS.puttingNight, {
      editing_paused: true,
    });
    const paused = await applyDraftOps(h.store, outsider, DEMO_EVENT_IDS.puttingNight, {
      baseVersion: draft.version + 1,
      ops: [
        {
          kind: 'section.update',
          opId: 'p',
          id: hero.id,
          baseRev: draft.version + 1,
          set: { 'props.subheadline': 'x' },
        },
      ],
    });
    expect(!paused.ok && paused.error.code).toBe('forbidden');
  });
});
