import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import {
  bumpScheduleVersion,
  createEvent,
  resolveSlug,
  updateEventSettings,
  type EventOwner,
} from '@/lib/services/events';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Event settings and permanent slugs (D-075): a renamed link keeps working
 * forever as a 301, no other event can take an old link, and the calendar
 * SEQUENCE moves whenever the time or the venue does. Fictional data only.
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

const published = DEMO_EVENT_IDS.annualMeeting; // published in the fixtures
const draft = DEMO_EVENT_IDS.puttingNight; // never published

describe('slug renames', () => {
  it('keep the old slug of a published event as a permanent alias that 301s', async () => {
    const renamed = await updateEventSettings(h.store, owner, published, {
      slug: 'harborview-2030',
    });
    expect(renamed.ok && renamed.value.slug).toBe('harborview-2030');

    const old = await resolveSlug(h.store, owner.organizationId, DEMO_EVENT_SLUGS.annualMeeting);
    expect(old.ok && old.value).toMatchObject({ redirectTo: '/e/harborview-2030' });
    expect(old.ok && old.value.event.id).toBe(published);
    const current = await resolveSlug(h.store, owner.organizationId, 'harborview-2030');
    expect(current.ok && current.value.redirectTo).toBeNull();

    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.slug_changed', entity_id: published },
    });
    expect(audit[0]?.metadata).toMatchObject({
      from: DEMO_EVENT_SLUGS.annualMeeting,
      to: 'harborview-2030',
    });
  });

  it('never let another event take an old slug, by rename or at creation', async () => {
    await updateEventSettings(h.store, owner, published, { slug: 'harborview-2030' });
    const taken = await updateEventSettings(h.store, owner, draft, {
      slug: DEMO_EVENT_SLUGS.annualMeeting,
    });
    expect(!taken.ok && taken.error.code).toBe('conflict');
    const created = await createEvent(h.store, owner, {
      title: 'Copycat',
      slug: DEMO_EVENT_SLUGS.annualMeeting,
    });
    expect(!created.ok && created.error.code).toBe('conflict');
    // A new event from the same title steps around it.
    const fromTitle = await createEvent(h.store, owner, { title: 'Harborview Annual Meeting' });
    expect(fromTitle.ok && fromTitle.value.slug).toBe('harborview-annual-meeting-2');
  });

  it('let an event take back its own old slug (the alias goes away)', async () => {
    await updateEventSettings(h.store, owner, published, { slug: 'harborview-2030' });
    const back = await updateEventSettings(h.store, owner, published, {
      slug: DEMO_EVENT_SLUGS.annualMeeting,
    });
    expect(back.ok && back.value.slug).toBe(DEMO_EVENT_SLUGS.annualMeeting);
    const aliases = await h.store.list('event_slug_aliases', owner.organizationId, {
      eq: { event_id: published },
    });
    expect(aliases.map((a) => a.slug)).toEqual(['harborview-2030']);
  });

  it('do not reserve the old slug of a draft that was never shared', async () => {
    await updateEventSettings(h.store, owner, draft, { slug: 'putting-night-2030' });
    const aliases = await h.store.list('event_slug_aliases', owner.organizationId, {
      eq: { event_id: draft },
    });
    expect(aliases).toEqual([]);
    const reuse = await createEvent(h.store, owner, {
      title: 'Something else',
      slug: DEMO_EVENT_SLUGS.puttingNight,
    });
    expect(reuse.ok).toBe(true);
  });

  it('refuse bad and reserved slugs and unknown events', async () => {
    for (const slug of ['Bad Slug', 'edit', '-x', 'a'.repeat(51)]) {
      const r = await updateEventSettings(h.store, owner, draft, { slug });
      expect(!r.ok && r.error.code).toBe('invalid_input');
    }
    expect((await resolveSlug(h.store, owner.organizationId, 'no-such-event')).ok).toBe(false);
    const missing = await updateEventSettings(
      h.store,
      owner,
      '00000000-0000-4000-8000-00000000dead',
      {
        title: 'x',
      },
    );
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });
});

describe('settings', () => {
  it('merge objects, check them whole, and bump the calendar sequence on time or venue changes', async () => {
    const before = (await h.store.get('events', owner.organizationId, published))!;
    const timed = await updateEventSettings(h.store, owner, published, {
      starts_at: '2030-01-25T19:00:00Z',
      ends_at: '2030-01-26T03:00:00Z',
    });
    expect(timed.ok && timed.value.schedule_version).toBe(before.schedule_version + 1);
    expect(timed.ok && timed.value.starts_at).toBe('2030-01-25T19:00:00.000Z');

    const venue = await updateEventSettings(h.store, owner, published, {
      venue: { name: 'The Glasshouse' } as never,
    });
    expect(venue.ok && venue.value.venue.name).toBe('The Glasshouse');
    expect(venue.ok && venue.value.venue.reveal).toBe(before.venue.reveal);
    expect(venue.ok && venue.value.schedule_version).toBe(before.schedule_version + 2);

    // Notes and the reveal rule do not move the calendar.
    const notes = await updateEventSettings(h.store, owner, published, {
      venue: { notes: 'Use the side door.' } as never,
    });
    expect(notes.ok && notes.value.schedule_version).toBe(before.schedule_version + 2);

    const reg = await updateEventSettings(h.store, owner, published, {
      registration: { show_remaining: true } as never,
      capacity: 80,
    });
    expect(reg.ok && reg.value.registration.show_remaining).toBe(true);
    expect(reg.ok && reg.value.registration.plus_ones).toEqual(before.registration.plus_ones);
    const audits = await h.store.list('audit_events', owner.organizationId, {
      eq: { entity_id: published },
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['event.settings_changed', 'event.registration_changed']),
    );
  });

  it('refuse invalid values plainly and change nothing', async () => {
    const cases = [
      { title: '' },
      { visibility: 'everyone' as never },
      { time_zone: 'Mars/Olympus' },
      { starts_at: 'soon' },
      { starts_at: '2030-02-02T00:00:00Z', ends_at: '2030-02-01T00:00:00Z' },
      { capacity: -1 },
      { venue: { online_url: 'javascript:alert(1)' } as never },
      { registration: { plus_ones: { max: 99 } } as never },
      { questions: [{ id: 'x' }] as never },
      { comms: { sender: 'someone' } as never },
    ];
    const before = (await h.store.get('events', owner.organizationId, published))!;
    for (const patch of cases) {
      const r = await updateEventSettings(h.store, owner, published, patch);
      expect(!r.ok && r.error.code, JSON.stringify(patch)).toBe('invalid_input');
    }
    const after = (await h.store.get('events', owner.organizationId, published))!;
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('accept questions tied to the event’s own sessions only', async () => {
    const q = {
      id: '00000000-0000-4000-8000-0000000c0001',
      type: 'dietary' as const,
      label: 'Any dietary needs?',
      help: null,
      required: false,
      options: [],
      session_id: DEMO_EVENT_IDS.sessionReception,
      ask_plus_ones: true,
      position: 0,
      removed_at: null,
    };
    const okResult = await updateEventSettings(h.store, owner, published, { questions: [q] });
    expect(okResult.ok && okResult.value.questions).toHaveLength(1);
    const foreign = await updateEventSettings(h.store, owner, published, {
      questions: [{ ...q, session_id: DEMO_EVENT_IDS.sessionPutting }],
    });
    expect(!foreign.ok && foreign.error.code).toBe('invalid_input');
  });

  it('pausing editing is audited both ways; a no-op change writes nothing', async () => {
    await updateEventSettings(h.store, owner, published, { editing_paused: true });
    await updateEventSettings(h.store, owner, published, { editing_paused: false });
    const actions = (
      await h.store.list('audit_events', owner.organizationId, { eq: { entity_id: published } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['event.editing_paused', 'event.editing_resumed']),
    );
    const before = (await h.store.get('events', owner.organizationId, published))!;
    const same = await updateEventSettings(h.store, owner, published, { title: before.title });
    expect(same.ok && same.value.updated_at).toBe(before.updated_at);
  });

  it('bumpScheduleVersion moves the sequence by one', async () => {
    const before = (await h.store.get('events', owner.organizationId, published))!;
    const bumped = await bumpScheduleVersion(h.store, owner.organizationId, published);
    expect(bumped.ok && bumped.value).toBe(before.schedule_version + 1);
  });
});
