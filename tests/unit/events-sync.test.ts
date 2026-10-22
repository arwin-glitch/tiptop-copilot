import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { EventActor } from '@/lib/events/contracts';
import {
  applyDraftOps,
  getDraft,
  ownerActor,
  presenceColor,
  syncDraft,
} from '@/lib/services/events';
import { createHarness, type Harness } from '../helpers/harness';
import { outsideActor } from '../helpers/events';

/**
 * Studio's sync poll (D-075): changes after a draft_version (sections by
 * rev, deletions as tombstones), the whole doc when the log cannot reach
 * back, and presence for avatars and soft locks — others only, self never.
 */

let h: Harness;
let owner: EventActor;
const EVENT = DEMO_EVENT_IDS.puttingNight;

beforeEach(async () => {
  h = await createHarness();
  owner = ownerActor({
    userId: h.auth.userId,
    organizationId: h.auth.organizationId,
    name: 'Demo Owner',
  });
});

afterEach(async () => {
  await h.dispose();
});

async function draft() {
  const d = await getDraft(h.store, owner, EVENT);
  if (!d.ok) throw new Error(d.error.message);
  return d.value;
}

describe('syncDraft', () => {
  it('returns nothing new at the current version, and records presence', async () => {
    const d = await draft();
    const hero = d.doc.sections.find((s) => s.type === 'hero')!;
    const mine = await syncDraft(h.store, owner, EVENT, d.version, {
      focusedSectionId: hero.id,
      typing: true,
    });
    expect(mine.ok && mine.value).toMatchObject({
      version: 0,
      full: null,
      changes: { sections: [], deletedSectionIds: [], theme: null, meta: null },
      presence: [],
      selfColor: presenceColor(`u:${h.auth.userId}`),
    });

    const morgan = outsideActor(EVENT, h.auth.organizationId);
    const theirs = await syncDraft(h.store, morgan, EVENT, d.version, {
      focusedSectionId: '00000000-0000-4000-8000-00000000beef', // not a section: dropped
      typing: false,
    });
    expect(theirs.ok && theirs.value.presence).toEqual([
      expect.objectContaining({
        actorKey: `u:${h.auth.userId}`,
        name: 'Demo Owner',
        outside: false,
        focusedSectionId: hero.id,
        typing: true,
        active: true,
      }),
    ]);
    const back = await syncDraft(h.store, owner, EVENT, d.version, null);
    expect(back.ok && back.value.presence).toEqual([
      expect.objectContaining({ name: 'Morgan Example', outside: true, focusedSectionId: null }),
    ]);
  });

  it('ignores people not seen for a minute and marks the soft-lock window', async () => {
    const d = await draft();
    await h.store.insert('event_presence', {
      event_id: EVENT,
      actor_key: 'g:00000000-0000-4000-8000-00000000a0a0',
      organization_id: h.auth.organizationId,
      name: 'Long Gone',
      color: '#2B6D56',
      focused_section_id: null,
      typing: false,
      last_seen_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    });
    await h.store.insert('event_presence', {
      event_id: EVENT,
      actor_key: 'g:00000000-0000-4000-8000-00000000a0a1',
      organization_id: h.auth.organizationId,
      name: 'Idle Reader',
      color: '#3559B7',
      focused_section_id: null,
      typing: false,
      last_seen_at: new Date(Date.now() - 40 * 1000).toISOString(),
    });
    const r = await syncDraft(h.store, owner, EVENT, d.version, null);
    expect(r.ok && r.value.presence.map((p) => [p.name, p.active])).toEqual([
      ['Idle Reader', false],
    ]);
  });

  it('sends changed sections and tombstones after a sync point', async () => {
    const d = await draft();
    const [hero, , rsvp] = d.doc.sections;
    await applyDraftOps(h.store, owner, EVENT, {
      baseVersion: 0,
      ops: [
        {
          kind: 'section.update',
          opId: 'a',
          id: hero!.id,
          baseRev: hero!.rev,
          set: { 'props.headline': 'Putt Night' },
        },
      ],
    });
    await applyDraftOps(h.store, owner, EVENT, {
      baseVersion: 1,
      ops: [{ kind: 'section.delete', opId: 'b', id: rsvp!.id, baseRev: rsvp!.rev }],
    });
    const fromZero = await syncDraft(h.store, owner, EVENT, 0, null);
    expect(fromZero.ok && fromZero.value.version).toBe(2);
    expect(fromZero.ok && fromZero.value.changes.sections.map((s) => s.id)).toEqual([hero!.id]);
    expect(fromZero.ok && fromZero.value.changes.deletedSectionIds).toEqual([rsvp!.id]);
    const fromOne = await syncDraft(h.store, owner, EVENT, 1, null);
    expect(fromOne.ok && fromOne.value.changes.sections).toEqual([]);
    expect(fromOne.ok && fromOne.value.changes.deletedSectionIds).toEqual([rsvp!.id]);
  });

  it('sends the whole doc when the log cannot reach back or the client is ahead', async () => {
    const d = await draft();
    const hero = d.doc.sections.find((s) => s.type === 'hero')!;
    await applyDraftOps(h.store, owner, EVENT, {
      baseVersion: 0,
      ops: [
        {
          kind: 'section.update',
          opId: 'a',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.headline': 'Putt Night' },
        },
      ],
    });
    const fresh = await syncDraft(h.store, owner, EVENT, -1, null);
    expect(fresh.ok && fresh.value.full?.sections).toHaveLength(d.doc.sections.length);
    const ahead = await syncDraft(h.store, owner, EVENT, 99, null);
    expect(ahead.ok && ahead.value.full).not.toBeNull();
    // The edit log was pruned: a client at 0 cannot be patched forward.
    await h.store.removeWhere('event_edits', h.auth.organizationId, { eq: { event_id: EVENT } });
    const pruned = await syncDraft(h.store, owner, EVENT, 0, null);
    expect(pruned.ok && pruned.value.full).not.toBeNull();
  });

  it('only reaches the link’s own event and says when editing is paused', async () => {
    const elsewhere = outsideActor(DEMO_EVENT_IDS.annualMeeting, h.auth.organizationId);
    const r = await syncDraft(h.store, elsewhere, EVENT, 0, null);
    expect(!r.ok && r.error.code).toBe('not_found');
    const bad = await syncDraft(h.store, owner, EVENT, 1.5, null);
    expect(!bad.ok && bad.error.code).toBe('invalid_input');
    await h.store.update('events', h.auth.organizationId, EVENT, { editing_paused: true });
    const paused = await syncDraft(
      h.store,
      outsideActor(EVENT, h.auth.organizationId),
      EVENT,
      0,
      null,
    );
    expect(paused.ok && paused.value.editingPaused).toBe(true);
  });
});
