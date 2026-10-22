import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { EventActor } from '@/lib/events/contracts';
import { parseEventDoc } from '@/lib/events/schema';
import {
  AUTOSAVE_KEEP,
  createNamedVersion,
  getVersion,
  listActivity,
  listVersions,
  maybeCheckpoint,
  pruneAutosaves,
  restoreVersion,
} from '@/lib/services/event-versions';
import { applyDraftOps, getDraft, ownerActor, syncDraft } from '@/lib/services/events';
import type { EventVersion } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { createHarness, type Harness } from '../helpers/harness';
import { outsideActor } from '../helpers/events';

/**
 * Version history (D-075): autosave checkpoints every 5 minutes of activity,
 * named versions, non-destructive restore (pre_restore first, a new draft
 * version, revs never backwards), retention, and the per-section activity log.
 */

let h: Harness;
let owner: EventActor;
const ANNUAL = DEMO_EVENT_IDS.annualMeeting;
const PUTTING = DEMO_EVENT_IDS.puttingNight;

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

async function draft(eventId: string) {
  const d = await getDraft(h.store, owner, eventId);
  if (!d.ok) throw new Error(d.error.message);
  return d.value;
}

async function setHeadline(eventId: string, text: string, who: EventActor = owner) {
  const d = await draft(eventId);
  const hero = d.doc.sections.find((s) => s.type === 'hero')!;
  const r = await applyDraftOps(h.store, who, eventId, {
    baseVersion: d.version,
    ops: [
      {
        kind: 'section.update',
        opId: newId().slice(0, 8),
        id: hero.id,
        baseRev: hero.rev,
        set: { 'props.headline': text },
      },
    ],
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.version;
}

const versionsOf = (eventId: string) =>
  h.store.list(
    'event_versions',
    h.auth.organizationId,
    { eq: { event_id: eventId } },
    { orderBy: [{ field: 'version', direction: 'asc' }] },
  );

describe('autosave checkpoints', () => {
  it('save after 5+ minutes of activity, not on every keystroke', async () => {
    // The fixture draft was created days ago: the first save checkpoints.
    await setHeadline(PUTTING, 'One');
    await setHeadline(PUTTING, 'Two');
    let versions = await versionsOf(PUTTING);
    expect(versions.map((v) => [v.kind, v.draft_version])).toEqual([['autosave', 1]]);

    const later = new Date(Date.now() + 6 * 60 * 1000);
    const saved = await maybeCheckpoint(h.store, owner, PUTTING, { now: later });
    expect(saved.ok && saved.value?.draftVersion).toBe(2);
    // Nothing changed since: nothing to save, even when forced.
    const again = await maybeCheckpoint(h.store, owner, PUTTING, { force: true });
    expect(again.ok && again.value).toBeNull();
    await setHeadline(PUTTING, 'Three');
    const forced = await maybeCheckpoint(h.store, owner, PUTTING, { force: true });
    expect(forced.ok && forced.value?.draftVersion).toBe(3);
    versions = await versionsOf(PUTTING);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('keep at most the newest 100 autosaves and none older than 30 days', async () => {
    const now = Date.now();
    const rows: EventVersion[] = Array.from({ length: 110 }, (_, i) => ({
      id: newId(),
      organization_id: h.auth.organizationId,
      event_id: PUTTING,
      version: i + 1,
      kind: i === 0 ? 'named' : 'autosave',
      name: i === 0 ? 'Keep me' : null,
      doc: {},
      draft_version: i,
      author_user_id: null,
      author_editor_id: null,
      author_name: 'Demo Owner',
      // The 5 oldest are two months old.
      created_at: new Date(now - (i < 5 ? 60 : 1) * 24 * 60 * 60 * 1000).toISOString(),
    }));
    await h.store.insertMany('event_versions', rows);
    const removed = await pruneAutosaves(h.store, h.auth.organizationId, PUTTING);
    expect(removed).toBe(109 - AUTOSAVE_KEEP);
    const left = await versionsOf(PUTTING);
    expect(left.filter((v) => v.kind === 'autosave')).toHaveLength(AUTOSAVE_KEEP);
    expect(left.some((v) => v.name === 'Keep me')).toBe(true);
  });
});

describe('named versions and the list', () => {
  it('owners name versions; the list says what changed since the version before', async () => {
    await setHeadline(PUTTING, 'Before');
    const named = await createNamedVersion(h.store, owner, PUTTING, '  Before the partner pass ');
    expect(named.ok && named.value).toMatchObject({
      kind: 'named',
      name: 'Before the partner pass',
    });
    await setHeadline(PUTTING, 'After');
    await maybeCheckpoint(h.store, owner, PUTTING, { force: true });

    const list = await listVersions(h.store, owner, PUTTING);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.map((v) => v.kind)).toEqual(['autosave', 'named', 'autosave']);
    expect(list.value[0]!.summary).toEqual(['Cover – title']);
    expect(list.value[2]!.summary).toEqual(['The first saved version']);

    const one = await getVersion(h.store, owner, PUTTING, list.value[1]!.id);
    expect(one.ok && one.value.doc.sections.find((s) => s.type === 'hero')!.props.headline).toBe(
      'Before',
    );
  });

  it('outside links cannot see, name or restore versions', async () => {
    const morgan = outsideActor(PUTTING, h.auth.organizationId);
    expect((await listVersions(h.store, morgan, PUTTING)).ok).toBe(false);
    const named = await createNamedVersion(h.store, morgan, PUTTING, 'Mine');
    expect(!named.ok && named.error.code).toBe('forbidden');
    const restored = await restoreVersion(h.store, morgan, PUTTING, newId());
    expect(!restored.ok && restored.error.code).toBe('forbidden');
    expect((await createNamedVersion(h.store, owner, PUTTING, '   ')).ok).toBe(false);
  });
});

describe('restore', () => {
  it('never overwrites: saves the current draft, restores as a new draft version, needs Publish', async () => {
    const [published] = await versionsOf(ANNUAL); // the fixture's published v1
    const before = await draft(ANNUAL);
    await setHeadline(ANNUAL, 'A newer headline');
    // A section added after v1 …
    const d = await draft(ANNUAL);
    const extra = {
      ...structuredClone(d.doc.sections.find((s) => s.type === 'text')!),
      id: newId(),
      position: 'zz',
    };
    await applyDraftOps(h.store, owner, ANNUAL, {
      baseVersion: d.version,
      ops: [{ kind: 'section.insert', opId: 'add', section: extra, afterId: null }],
    });
    const current = await draft(ANNUAL);

    const restored = await restoreVersion(h.store, owner, ANNUAL, published!.id);
    expect(restored.ok && restored.value.draftVersion).toBe(current.version + 1);
    const after = await draft(ANNUAL);
    const hero = after.doc.sections.find((s) => s.type === 'hero')!;
    expect(hero.props.headline).toBe('Harborview Annual Meeting');
    expect(after.doc.sections.some((s) => s.id === extra.id)).toBe(false);
    expect(hero.rev).toBe(current.version + 1);
    // Revs never go backwards.
    for (const s of after.doc.sections) {
      const was = current.doc.sections.find((c) => c.id === s.id);
      if (was) expect(s.rev).toBeGreaterThanOrEqual(was.rev);
    }
    expect(parseEventDoc(after.doc).ok).toBe(true);

    const kinds = (await versionsOf(ANNUAL)).map((v) => v.kind);
    expect(kinds.slice(-2)).toEqual(['pre_restore', 'restore']);
    const pre = (await versionsOf(ANNUAL)).find((v) => v.kind === 'pre_restore')!;
    expect(pre.draft_version).toBe(current.version);

    // The live page is untouched.
    const event = (await h.store.get('events', h.auth.organizationId, ANNUAL))!;
    expect(event.published_version).toBe(1);
    expect(event.published_draft_version).toBe(before.publishedDraftVersion);

    // Someone polling from before the restore gets the changed hero and a tombstone.
    const sync = await syncDraft(h.store, owner, ANNUAL, current.version, null);
    expect(sync.ok && sync.value.full).toBeNull();
    expect(sync.ok && sync.value.changes.sections.map((s) => s.id)).toEqual([hero.id]);
    expect(sync.ok && sync.value.changes.deletedSectionIds).toEqual([extra.id]);

    const audit = await h.store.list('audit_events', h.auth.organizationId, {
      eq: { action: 'event.version_restored', entity_id: ANNUAL },
    });
    expect(audit).toHaveLength(1);
  });

  it('restoring what is already there changes nothing', async () => {
    const [published] = await versionsOf(ANNUAL);
    const restored = await restoreVersion(h.store, owner, ANNUAL, published!.id);
    expect(restored.ok && restored.value.draftVersion).toBe(0);
    expect((await versionsOf(ANNUAL)).map((v) => v.kind)).toEqual(['published']);
    const missing = await restoreVersion(h.store, owner, ANNUAL, newId());
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });
});

describe('activity', () => {
  it('lists who changed which keys, per section, with outside edits marked', async () => {
    await setHeadline(PUTTING, 'Owner edit');
    await setHeadline(PUTTING, 'Outside edit', outsideActor(PUTTING, h.auth.organizationId));
    const hero = (await draft(PUTTING)).doc.sections.find((s) => s.type === 'hero')!;
    const all = await listActivity(h.store, owner, PUTTING, { sectionId: hero.id });
    expect(all.ok && all.value.map((a) => [a.authorName, a.outside, a.keys])).toEqual([
      ['Morgan Example', true, ['props.headline']],
      ['Demo Owner', false, ['props.headline']],
    ]);
    const page = await listActivity(h.store, owner, PUTTING, { sectionId: null });
    expect(page.ok && page.value).toEqual([]);
  });
});
