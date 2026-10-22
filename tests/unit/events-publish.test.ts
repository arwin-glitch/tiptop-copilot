import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import { isPageLive, type EventActor, type OgImageInput } from '@/lib/events/contracts';
import { orderedSections, parseEventDoc } from '@/lib/events/schema';
import {
  applyDraftOps,
  archiveEvent,
  cancelEvent,
  deleteEvent,
  duplicateEvent,
  getDraft,
  getPublishPreview,
  libraryTab,
  ownerActor,
  publishEvent,
  unpublishEvent,
  type EventOwner,
} from '@/lib/services/events';
import { LocalEventStorage, setEventStorageForTesting } from '@/lib/storage/event-storage';
import type { EventMedia } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';
import { outsideActor } from '../helpers/events';

/**
 * Publish and the event lifecycle (D-075): owners publish what they
 * reviewed (409 if it moved), the share card is stored per version, alt text
 * blocks, unpublish keeps guests, cancel keeps a live notice, delete is for
 * never-published drafts, duplicate shifts dates on the wall clock.
 */

const og = vi.hoisted(() => ({
  render: vi.fn(async (_input: unknown): Promise<Uint8Array | null> => null),
}));
vi.mock('@/lib/events/og', () => ({ renderOgImage: (input: unknown) => og.render(input) }));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let h: Harness;
let owner: EventOwner;
let actor: EventActor;
let root: string;
let storage: LocalEventStorage;
let counter = 0;

const ANNUAL = DEMO_EVENT_IDS.annualMeeting;
const PUTTING = DEMO_EVENT_IDS.puttingNight;

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
  actor = ownerActor(owner);
  root = path.join('.demo-data', 'test', `publish-storage-${process.pid}-${++counter}`);
  storage = new LocalEventStorage({ root });
  setEventStorageForTesting(storage);
  og.render.mockReset();
  og.render.mockResolvedValue(PNG);
});

afterEach(async () => {
  setEventStorageForTesting(null);
  await rm(root, { recursive: true, force: true });
  await h.dispose();
});

async function draft(eventId: string, who: EventActor = actor) {
  const d = await getDraft(h.store, who, eventId);
  if (!d.ok) throw new Error(d.error.message);
  return d.value;
}

async function editHeadline(eventId: string, who: EventActor, text: string) {
  const d = await draft(eventId, who);
  const hero = d.doc.sections.find((s) => s.type === 'hero')!;
  const r = await applyDraftOps(h.store, who, eventId, {
    baseVersion: d.version,
    ops: [
      {
        kind: 'section.update',
        opId: `h${Math.random().toString(36).slice(2, 8)}`,
        id: hero.id,
        baseRev: hero.rev,
        set: { 'props.headline': text },
      },
    ],
  });
  if (!r.ok || !r.value.applied.length) throw new Error('edit failed');
  return r.value.version;
}

describe('the publish preview', () => {
  it('lists section-level changes since the last publish, with who made them', async () => {
    await editHeadline(ANNUAL, actor, 'Harborview Annual Meeting 2030');
    await editHeadline(ANNUAL, outsideActor(ANNUAL, owner.organizationId), 'Harborview 2030');
    const preview = await getPublishPreview(h.store, owner, ANNUAL);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.draftVersion).toBe(2);
    expect(preview.value.neverPublished).toBe(false);
    expect(preview.value.lines).toEqual([
      expect.objectContaining({
        text: 'Hero – headline',
        authors: ['Demo Owner', 'Morgan Example (outside)'],
      }),
    ]);
    expect(preview.value.canPublish).toBe(true);
    expect(preview.value.checklist.find((c) => c.id === 'og')?.ok).toBe(true);
  });
});

describe('publishEvent', () => {
  it('copies the reviewed draft, stores the share card per version and saves a version', async () => {
    const version = await editHeadline(ANNUAL, actor, 'Harborview 2030');
    const stale = await publishEvent(h.store, owner, ANNUAL, version - 1);
    expect(!stale.ok && stale.error.code).toBe('conflict');

    const result = await publishEvent(h.store, owner, ANNUAL, version);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      publishedVersion: 2,
      path: '/e/harborview-annual-meeting',
      ogImageUrl: `http://localhost:3000/api/event-media/og/${ANNUAL}/v2.png`,
    });
    const event = (await h.store.get('events', owner.organizationId, ANNUAL))!;
    expect(event).toMatchObject({
      status: 'published',
      published_version: 2,
      published_draft_version: version,
      og_image_path: `og/${ANNUAL}/v2.png`,
    });
    const live = parseEventDoc(event.published_doc);
    expect(live.ok && live.value.sections.find((s) => s.type === 'hero')!.props.headline).toBe(
      'Harborview 2030',
    );
    expect((await storage.get('public', `og/${ANNUAL}/v2.png`)).ok).toBe(true);
    const versions = await h.store.list('event_versions', owner.organizationId, {
      eq: { event_id: ANNUAL, kind: 'published' },
    });
    expect(versions.map((v) => v.name)).toContain('Published v2');
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.published', entity_id: ANNUAL },
    });
    expect(audit[0]?.metadata).toMatchObject({ version: 2, changes: ['Hero – headline'] });
  });

  it('draws the share card from the PUBLIC view only: no gated sections, no unrevealed address', async () => {
    const d = await draft(ANNUAL);
    const text = d.doc.sections.find((s) => s.type === 'text')!;
    const r = await applyDraftOps(h.store, actor, ANNUAL, {
      baseVersion: d.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'gate',
          id: text.id,
          baseRev: text.rev,
          set: { visibility: { mode: 'going', tags: [] } },
        },
      ],
    });
    expect(r.ok && r.value.applied).toEqual(['gate']);
    await publishEvent(h.store, owner, ANNUAL, d.version + 1);
    const input = og.render.mock.calls[0]![0] as OgImageInput;
    expect(input.doc.sections.some((s) => s.id === text.id)).toBe(false);
    expect(input.facts.venue).toMatchObject({
      name: 'The Lantern Hall',
      address: null,
      revealed: false,
    });
    expect(input.layout).toBe('cover');
  });

  it('publishes without a card when the renderer fails, and blocks on missing alt text', async () => {
    og.render.mockRejectedValue(new Error('renderer exploded'));
    const noCard = await publishEvent(h.store, owner, PUTTING, 0);
    expect(noCard.ok && noCard.value.ogImageUrl).toBeNull();
    expect(isPageLive((await h.store.get('events', owner.organizationId, PUTTING))!)).toBe(true);

    const mediaId = '00000000-0000-4000-8000-0000000fa001';
    const now = new Date().toISOString();
    const media: EventMedia = {
      id: mediaId,
      organization_id: owner.organizationId,
      event_id: PUTTING,
      kind: 'image',
      status: 'ready',
      original_path: `${owner.organizationId}/${PUTTING}/${mediaId}/original.jpg`,
      original_name: 'deck.jpg',
      content_type: 'image/jpeg',
      bytes: 10,
      variants: [],
      poster_path: null,
      width: 10,
      height: 10,
      duration_ms: null,
      thumbhash: null,
      colors: [],
      alt: null,
      decorative: false,
      gated: false,
      error: null,
      created_by_actor: `u:${owner.userId}`,
      created_at: now,
      updated_at: now,
    };
    await h.store.insert('event_media', media);
    const d = await draft(PUTTING);
    const hero = d.doc.sections.find((s) => s.type === 'hero')!;
    await applyDraftOps(h.store, actor, PUTTING, {
      baseVersion: d.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'img',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.image': { mediaId } },
        },
      ],
    });
    const preview = await getPublishPreview(h.store, owner, PUTTING);
    expect(preview.ok && preview.value.canPublish).toBe(false);
    const blocked = await publishEvent(h.store, owner, PUTTING, d.version + 1);
    expect(!blocked.ok && blocked.error).toMatchObject({
      code: 'invalid_input',
      details: { check: 'alt_text' },
    });
    await h.store.update('event_media', owner.organizationId, mediaId, { alt: 'A putting green' });
    og.render.mockResolvedValue(PNG);
    const done = await publishEvent(h.store, owner, PUTTING, d.version + 1);
    expect(done.ok && done.value.publishedVersion).toBe(2);
  });
});

describe('the lifecycle', () => {
  it('unpublish keeps the snapshot and guests; republish brings it back', async () => {
    const off = await unpublishEvent(h.store, owner, ANNUAL);
    expect(off.ok && off.value.status).toBe('draft');
    expect(off.ok && off.value.published_doc).not.toBeNull();
    expect(off.ok && isPageLive(off.value)).toBe(false);
    expect(
      await h.store.count('event_guests', owner.organizationId, { eq: { event_id: ANNUAL } }),
    ).toBe(6);
    const again = await unpublishEvent(h.store, owner, ANNUAL);
    expect(!again.ok && again.error.code).toBe('invalid_input');
    const back = await publishEvent(h.store, owner, ANNUAL, 0);
    expect(back.ok).toBe(true);
  });

  it('cancel needs a published page, keeps it live with the message and bumps the calendar', async () => {
    const neverPublished = await cancelEvent(h.store, owner, PUTTING, 'Rained out');
    expect(!neverPublished.ok && neverPublished.error.code).toBe('invalid_input');
    const cancelled = await cancelEvent(h.store, owner, ANNUAL, '  We are moving to spring.  ');
    expect(cancelled.ok && cancelled.value).toMatchObject({
      status: 'cancelled',
      cancel_message: 'We are moving to spring.',
      schedule_version: 1,
    });
    expect(cancelled.ok && isPageLive(cancelled.value)).toBe(true);
    // Publishing a fix to the page keeps the cancelled notice.
    const republished = await publishEvent(h.store, owner, ANNUAL, 0);
    expect(republished.ok).toBe(true);
    expect((await h.store.get('events', owner.organizationId, ANNUAL))!.status).toBe('cancelled');
  });

  it('archive takes it off the web; an archived event is not published again', async () => {
    const archived = await archiveEvent(h.store, owner, ANNUAL);
    expect(archived.ok && archived.value.status).toBe('archived');
    expect(archived.ok && isPageLive(archived.value)).toBe(false);
    const pub = await publishEvent(h.store, owner, ANNUAL, 0);
    expect(!pub.ok && pub.error.code).toBe('invalid_input');
  });

  it('delete is for never-published drafts and templates; it removes every child row', async () => {
    const refused = await deleteEvent(h.store, owner, ANNUAL);
    expect(!refused.ok && refused.error.message).toMatch(/Archive it instead/);
    await editHeadline(PUTTING, actor, 'Putt Night');
    const deleted = await deleteEvent(h.store, owner, PUTTING);
    expect(deleted.ok).toBe(true);
    expect(await h.store.get('events', owner.organizationId, PUTTING)).toBeNull();
    for (const table of ['event_sessions', 'event_edits', 'event_versions'] as const) {
      expect(await h.store.count(table, owner.organizationId, { eq: { event_id: PUTTING } })).toBe(
        0,
      );
    }
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.deleted', entity_id: PUTTING },
    });
    expect(audit).toHaveLength(1);
  });
});

describe('duplicateEvent', () => {
  it('copies page, sessions and questions with dates moved on the wall clock; never guests', async () => {
    const source = (await h.store.get('events', owner.organizationId, ANNUAL))!;
    const copy = await duplicateEvent(h.store, owner, ANNUAL, { shiftDays: 364 });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const e = copy.value;
    expect(e).toMatchObject({
      title: 'Harborview Annual Meeting (copy)',
      slug: 'harborview-annual-meeting-copy',
      status: 'draft',
      published_doc: null,
      draft_version: 0,
      is_template: false,
      access: source.access,
      visibility: source.visibility,
    });
    expect(libraryTab(e)).toBe('drafts');
    // Same local hour a year on (America/Chicago).
    const hour = (iso: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(new Date(iso));
    expect(hour(e.starts_at!)).toBe(hour(source.starts_at!));
    expect(Date.parse(e.starts_at!) - Date.parse(source.starts_at!)).toBeGreaterThan(363 * 864e5);

    const sessions = await h.store.list('event_sessions', owner.organizationId, {
      eq: { event_id: e.id },
    });
    expect(sessions.map((s) => s.name).sort()).toEqual(['Annual Meeting', 'Evening Reception']);
    const reception = sessions.find((s) => s.name === 'Evening Reception')!;
    expect(e.questions.find((q) => q.type === 'dietary')?.session_id).toBe(reception.id);
    expect(
      await h.store.count('event_guests', owner.organizationId, { eq: { event_id: e.id } }),
    ).toBe(0);
    expect(
      await h.store.count('event_versions', owner.organizationId, { eq: { event_id: e.id } }),
    ).toBe(0);

    const doc = parseEventDoc(e.draft_doc);
    const sourceDoc = parseEventDoc(source.draft_doc);
    if (!doc.ok || !sourceDoc.ok) throw new Error('docs');
    expect(orderedSections(doc.value.sections).map((s) => s.type)).toEqual(
      orderedSections(sourceDoc.value.sections).map((s) => s.type),
    );
    expect(
      doc.value.sections.some((s) => sourceDoc.value.sections.some((o) => o.id === s.id)),
    ).toBe(false);
    expect(doc.value.sections.every((s) => s.rev === 0)).toBe(true);
  });

  it('saves as a template under Templates', async () => {
    const t = await duplicateEvent(h.store, owner, PUTTING, {
      shiftDays: 0,
      asTemplate: true,
      title: 'Putting template',
    });
    expect(t.ok && t.value).toMatchObject({ is_template: true, title: 'Putting template' });
    expect(t.ok && libraryTab(t.value)).toBe('templates');
    const pub = await publishEvent(h.store, owner, t.ok ? t.value.id : '', 0);
    expect(!pub.ok && pub.error.message).toMatch(/Templates/);
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.template_saved' },
    });
    expect(audit).toHaveLength(1);
    expect((await deleteEvent(h.store, owner, t.ok ? t.value.id : '')).ok).toBe(true);
  });

  it('copies the media rows the page uses, under new ids, sharing the stored files', async () => {
    const mediaId = '00000000-0000-4000-8000-0000000fa002';
    const now = new Date().toISOString();
    await h.store.insert('event_media', {
      id: mediaId,
      organization_id: owner.organizationId,
      event_id: PUTTING,
      kind: 'image',
      status: 'ready',
      original_path: `${owner.organizationId}/${PUTTING}/${mediaId}/original.jpg`,
      original_name: 'green.jpg',
      content_type: 'image/jpeg',
      bytes: 10,
      variants: [
        {
          w: 640,
          format: 'webp',
          path: `${owner.organizationId}/${PUTTING}/abc.640.webp`,
          bytes: 5,
        },
      ],
      poster_path: null,
      width: 640,
      height: 400,
      duration_ms: null,
      thumbhash: null,
      colors: [],
      alt: 'The green',
      decorative: false,
      gated: false,
      error: null,
      created_by_actor: `u:${owner.userId}`,
      created_at: now,
      updated_at: now,
    });
    const d = await draft(PUTTING);
    const hero = d.doc.sections.find((s) => s.type === 'hero')!;
    await applyDraftOps(h.store, actor, PUTTING, {
      baseVersion: d.version,
      ops: [
        {
          kind: 'section.update',
          opId: 'img',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.image': { mediaId } },
        },
      ],
    });
    const copy = await duplicateEvent(h.store, owner, PUTTING, { shiftDays: 7 });
    if (!copy.ok) throw new Error(copy.error.message);
    const media = await h.store.list('event_media', owner.organizationId, {
      eq: { event_id: copy.value.id },
    });
    expect(media).toHaveLength(1);
    expect(media[0]!.id).not.toBe(mediaId);
    expect(media[0]!.variants[0]!.path).toBe(`${owner.organizationId}/${PUTTING}/abc.640.webp`);
    const doc = parseEventDoc(copy.value.draft_doc);
    const copiedHero = doc.ok ? doc.value.sections.find((s) => s.type === 'hero')! : null;
    expect(copiedHero?.props.image).toEqual({ mediaId: media[0]!.id });
  });

  it('refuses silly shifts', async () => {
    const r = await duplicateEvent(h.store, owner, ANNUAL, { shiftDays: 1.5 });
    expect(!r.ok && r.error.code).toBe('invalid_input');
  });
});
