import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { EventActor } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';
import { claimGrant } from '@/lib/events/editor-auth';
import { sectionDelete, sectionInsert, sectionUpdate } from '@/lib/events/editor/doc-ops';
import { DraftEditor, UNDO_LIMIT } from '@/lib/events/editor/draft-editor';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { createEditorLink } from '@/lib/services/event-editors';
import { syncStudio } from '@/lib/services/event-presence';
import { applyDraftOps, ownerActor } from '@/lib/services/events';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Studio's client draft against the real ops service (D-075): two people
 * editing, per-key merge, conflicts and their choices, rebasing one's own
 * queued ops, and per-user undo that never overwrites a collaborator.
 * Fictional people only.
 */

let h: Harness;
let riley: EventActor;
let morgan: EventActor;
const EVENT = DEMO_EVENT_IDS.annualMeeting;

async function serverDoc(): Promise<{ doc: EventDoc; version: number }> {
  const event = await h.store.get('events', h.auth.organizationId, EVENT);
  const parsed = parseEventDoc(event!.draft_doc);
  if (!parsed.ok) throw new Error('bad doc');
  return { doc: parsed.value, version: event!.draft_version };
}

async function client(): Promise<DraftEditor> {
  const { doc, version } = await serverDoc();
  return new DraftEditor({ doc, version });
}

/** Send what the editor has queued, as this actor, and hand the answer back. */
async function send(editor: DraftEditor, actor: EventActor): Promise<void> {
  const batch = editor.takeBatch();
  if (!batch) return;
  const result = await applyDraftOps(h.store, actor, EVENT, batch);
  if (!result.ok) throw new Error(result.error.message);
  editor.ack(result.value);
}

async function sync(editor: DraftEditor, actor: EventActor): Promise<void> {
  const result = await syncStudio(h.store, actor, EVENT, editor.syncedVersion, null);
  if (!result.ok) throw new Error(result.error.message);
  editor.applySync(result.value);
}

function hero(doc: EventDoc) {
  return doc.sections.find((s) => s.type === 'hero')!;
}

beforeEach(async () => {
  h = await createHarness();
  riley = ownerActor({
    userId: h.auth.userId,
    organizationId: h.auth.organizationId,
    name: 'Riley Example',
  });
  const issued = await createEditorLink(
    h.store,
    { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Riley Example' },
    EVENT,
    { label: 'Morgan – Example Partners', role: 'editor', scope: { design: true, content: true } },
  );
  if (!issued.ok) throw new Error('link');
  const claimed = await claimGrant(h.store, {
    token: issued.value.path.split('#k=')[1]!,
    ip: '203.0.113.5',
    userAgent: 'test',
  });
  if (!claimed.ok) throw new Error('claim');
  morgan = { kind: 'grant', grant: claimed.value.grant, name: 'Morgan – Example Partners' };
});

afterEach(async () => {
  await h.dispose();
});

describe('one person editing', () => {
  it('shows an edit at once, saves it, and undoes it with a rev-checked inverse', async () => {
    const a = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'Welcome back' }), 'Edit headline');
    expect(hero(a.display).props.headline).toBe('Welcome back');
    expect(a.hasUnsaved).toBe(true);
    await send(a, riley);
    expect(a.hasUnsaved).toBe(false);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Welcome back');
    expect(a.canUndo).toBe(true);

    expect(a.undo()).toBe(true);
    expect(hero(a.display).props.headline).toBe('Harborview Annual Meeting');
    await send(a, riley);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Harborview Annual Meeting');
    expect(a.canRedo).toBe(true);

    expect(a.redo()).toBe(true);
    await send(a, riley);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Welcome back');
  });

  it('rebases its own queued edits so it never conflicts with itself', async () => {
    const a = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'One' }));
    const batch = a.takeBatch()!;
    // A second edit to the same key while the first is in flight, made on the old rev.
    a.apply(sectionUpdate(s, { 'props.headline': 'Two' }));
    const first = await applyDraftOps(h.store, riley, EVENT, batch);
    if (!first.ok) throw new Error('first');
    a.ack(first.value);
    await send(a, riley);
    expect(a.conflicts).toEqual([]);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Two');
  });

  it('undoes an added section (deletes it) and a deleted one (puts it back)', async () => {
    const a = await client();
    const insert = sectionInsert(a.display, sectionTemplate('divider', {}), hero(a.display).id);
    a.apply(insert, 'Add divider');
    await send(a, riley);
    // An edit to it in between, by the same person, then undo both.
    a.apply(
      sectionUpdate(
        a.confirmed.sections.find((s) => s.id === insert.section.id)!,
        { name: 'Break' },
      ),
    );
    await send(a, riley);
    a.undo();
    await send(a, riley);
    a.undo();
    await send(a, riley);
    expect((await serverDoc()).doc.sections.some((s) => s.id === insert.section.id)).toBe(false);
    expect(a.notices).toEqual([]);

    const faq = a.confirmed.sections.find((s) => s.type === 'faq')!;
    a.apply(sectionDelete(faq), 'Delete FAQ');
    await send(a, riley);
    expect((await serverDoc()).doc.sections.some((s) => s.id === faq.id)).toBe(false);
    a.undo();
    await send(a, riley);
    const back = (await serverDoc()).doc.sections.find((s) => s.id === faq.id);
    expect(back?.props).toEqual(faq.props);
    expect(back?.position).toBe(faq.position);
  });

  it('keeps at most 100 undo steps', async () => {
    const a = await client();
    const id = hero(a.display).id;
    for (let i = 0; i < UNDO_LIMIT + 5; i++) {
      const section = a.confirmed.sections.find((x) => x.id === id)!;
      a.apply(sectionUpdate(section, { name: `Hero ${i}` }));
      const batch = a.takeBatch()!;
      const version = a.version + 1;
      a.ack({
        version,
        applied: batch.ops.map((o) => o.opId),
        conflicts: [],
        changes: {
          sections: [
            {
              ...section,
              name: `Hero ${i}`,
              rev: version,
              keyRevs: { ...section.keyRevs, name: version },
            },
          ],
          deletedSectionIds: [],
          theme: null,
          meta: null,
        },
      });
    }
    let steps = 0;
    while (a.canUndo) {
      a.undo();
      steps++;
      a.discardPending();
    }
    expect(steps).toBe(UNDO_LIMIT);
  });
});

describe('two people editing', () => {
  it('merges edits to different keys of one section without asking', async () => {
    const a = await client();
    const b = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'From Riley' }));
    b.apply(sectionUpdate(s, { 'props.subheadline': 'From Morgan' }));
    await send(a, riley);
    await send(b, morgan);
    expect(b.conflicts).toEqual([]);
    const server = hero((await serverDoc()).doc);
    expect(server.props).toMatchObject({ headline: 'From Riley', subheadline: 'From Morgan' });
    await sync(a, riley);
    expect(hero(a.display).props.subheadline).toBe('From Morgan');
  });

  it('asks about the same key, names who won, and keeps mine on request', async () => {
    const a = await client();
    const b = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'Riley wins?' }));
    b.apply(sectionUpdate(s, { 'props.headline': 'Morgan wins?' }));
    await send(a, riley);
    await send(b, morgan);
    expect(b.conflicts).toHaveLength(1);
    const c = b.conflicts[0]!;
    // Studio polls at once after a conflict.
    await sync(b, morgan);
    expect(c.conflict).toMatchObject({
      kind: 'key_changed',
      keys: ['props.headline'],
      theirs: { 'props.headline': 'Riley wins?' },
      by: { name: 'Riley Example' },
    });
    // The display already shows what the server holds.
    expect(hero(b.display).props.headline).toBe('Riley wins?');
    b.keepMine(c.id);
    await send(b, morgan);
    expect(b.conflicts).toEqual([]);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Morgan wins?');
  });

  it('uses theirs on request: nothing is sent', async () => {
    const a = await client();
    const b = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'Kept' }));
    b.apply(sectionUpdate(s, { 'props.headline': 'Dropped' }));
    await send(a, riley);
    await send(b, morgan);
    await sync(b, morgan);
    b.takeTheirs(b.conflicts[0]!.id);
    expect(b.hasUnsaved).toBe(false);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Kept');
  });

  it("won't undo over a collaborator's later change", async () => {
    const a = await client();
    const b = await client();
    const s = hero(a.display);
    a.apply(sectionUpdate(s, { 'props.headline': 'Riley first' }));
    await send(a, riley);
    await sync(b, morgan);
    b.apply(
      sectionUpdate(
        b.confirmed.sections.find((x) => x.id === s.id)!,
        { 'props.headline': 'Morgan after' },
      ),
    );
    await send(b, morgan);
    a.undo();
    await send(a, riley);
    expect(a.notices.map((n) => n.text)).toEqual([
      "Can't undo – Morgan – Example Partners changed this since.",
    ]);
    expect(a.conflicts).toEqual([]);
    expect(hero((await serverDoc()).doc).props.headline).toBe('Morgan after');
  });

  it('offers to restore a section someone deleted under my edit', async () => {
    const a = await client();
    const b = await client();
    const text = a.display.sections.find((s) => s.type === 'text')!;
    a.apply(sectionDelete(text), 'Delete text');
    b.apply(sectionUpdate(text, { 'props.heading': 'Reading list' }), 'Edit heading');
    await send(a, riley);
    await send(b, morgan);
    expect(b.conflicts[0]?.conflict).toMatchObject({
      kind: 'section_deleted',
      by: { name: 'Riley Example' },
    });
    b.keepMine(b.conflicts[0]!.id);
    await send(b, morgan);
    const restored = (await serverDoc()).doc.sections.find((s) => s.id === text.id);
    expect(restored?.props.heading).toBe('Reading list');
  });

  it('applies sync results only when they are newer than what it holds', async () => {
    const a = await client();
    const s = hero(a.display);
    const before = await syncStudio(h.store, riley, EVENT, a.syncedVersion, null);
    a.apply(sectionUpdate(s, { 'props.headline': 'Fresh' }));
    await send(a, riley);
    if (!before.ok) throw new Error('sync');
    // A slow, older poll answer arriving after the ack must not roll it back.
    a.applySync({
      ...before.value,
      changes: { ...before.value.changes, sections: [s] },
    });
    expect(hero(a.confirmed).props.headline).toBe('Fresh');
  });
});

describe('undo before autosave (design review)', () => {
  it('undoes an unsaved edit locally, with no round trip, and redo puts it back', async () => {
    const a = await client();
    const before = (hero(a.display).props as { headline?: string }).headline;
    a.apply(
      sectionUpdate(hero(a.display), { 'props.headline': 'Typed just now' }),
      'Edit headline',
    );
    expect(a.canUndo).toBe(true);
    expect(a.undo()).toBe(true);
    expect((hero(a.display).props as { headline?: string }).headline).toBe(before);
    expect(a.hasUnsaved).toBe(false);
    expect(a.canRedo).toBe(true);
    expect(a.redo()).toBe(true);
    expect((hero(a.display).props as { headline?: string }).headline).toBe('Typed just now');
    // And it still saves normally.
    await send(a, riley);
    expect((hero((await serverDoc()).doc).props as { headline?: string }).headline).toBe(
      'Typed just now',
    );
  });

  it('works offline: queued ops that failed to send are undone locally too', async () => {
    const a = await client();
    a.apply(sectionUpdate(hero(a.display), { 'props.headline': 'Offline edit' }), 'Edit');
    expect(a.takeBatch()).not.toBeNull();
    a.requeue(); // the network failed
    expect(a.undo()).toBe(true);
    expect(a.pending).toHaveLength(0);
  });

  it('redo right after undoing a saved change takes the queued undo back', async () => {
    const a = await client();
    a.apply(sectionUpdate(hero(a.display), { 'props.headline': 'Saved edit' }), 'Edit');
    await send(a, riley);
    expect(a.undo()).toBe(true); // queues the inverse
    expect(a.canRedo).toBe(true);
    expect(a.redo()).toBe(true); // before the inverse was saved
    expect(a.hasUnsaved).toBe(false);
    expect((hero(a.display).props as { headline?: string }).headline).toBe('Saved edit');
    expect(a.canUndo).toBe(true);
  });

  it('an edit undone while in flight is undone once the server confirms it', async () => {
    const a = await client();
    const before = (hero(a.display).props as { headline?: string }).headline;
    a.apply(sectionUpdate(hero(a.display), { 'props.headline': 'In flight' }), 'Edit');
    const batch = a.takeBatch()!;
    expect(a.undo()).toBe(true);
    const result = await applyDraftOps(h.store, riley, EVENT, batch);
    if (!result.ok) throw new Error(result.error.message);
    a.ack(result.value);
    await send(a, riley); // the inverse
    expect((hero((await serverDoc()).doc).props as { headline?: string }).headline).toBe(before);
  });
});
