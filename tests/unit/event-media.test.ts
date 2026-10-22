import { rm } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as publicGet } from '@/app/api/event-media/[...path]/route';
import { GET as signedGet } from '@/app/api/event-media/signed/route';
import { PUT as uploadPut } from '@/app/api/event-media/upload/route';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { EventActor } from '@/lib/events/contracts';
import { processImage, sniff, IMAGE_WIDTHS } from '@/lib/events/media-process';
import type { EventDoc } from '@/lib/events/schema';
import {
  GRANT_UPLOADS_PER_HOUR,
  createUploadUrl,
  deleteMedia,
  listResolvedMedia,
  processMedia,
  resolveMedia,
  updateMedia,
} from '@/lib/services/event-media';
import { getDraft, ownerActor } from '@/lib/services/events';
import { PUBLIC_VIEWER } from '@/lib/events/contracts';
import { LocalEventStorage, setEventStorageForTesting } from '@/lib/storage/event-storage';
import { createHarness, type Harness } from '../helpers/harness';
import { outsideActor } from '../helpers/events';

/**
 * The event media pipeline (D-075): signed direct uploads, bytes decide
 * what a file is, sharp re-encodes with EXIF/GPS gone, ungated derivatives in
 * the public bucket, gated ones private behind signed URLs. Runs on the local
 * demo storage, which mirrors both buckets' type lists and caps.
 */

let h: Harness;
let owner: EventActor;
let storage: LocalEventStorage;
let root: string;
let counter = 0;
const EVENT = DEMO_EVENT_IDS.puttingNight;

beforeEach(async () => {
  h = await createHarness();
  owner = ownerActor({
    userId: h.auth.userId,
    organizationId: h.auth.organizationId,
    name: 'Demo Owner',
  });
  root = path.join('.demo-data', 'test', `event-storage-${process.pid}-${++counter}`);
  storage = new LocalEventStorage({ root });
  setEventStorageForTesting(storage);
});

afterEach(async () => {
  setEventStorageForTesting(null);
  await rm(root, { recursive: true, force: true });
  await h.dispose();
});

/** A photo "taken on a phone": rotated by EXIF, with a GPS position and a copyright. */
async function phonePhoto(width = 300, height = 200): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 43, g: 109, b: 86 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: Math.round(width / 3), height, channels: 3, background: '#D4AF37' },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Copyright: 'Fictional Photographer', Orientation: '6' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '30/1 16/1 0/1' },
      })
      .jpeg()
      .toBuffer(),
  );
}

async function upload(
  actor: EventActor,
  bytes: Uint8Array,
  input: { kind?: 'image' | 'video' | 'logo' | 'file'; contentType?: string; gated?: boolean } = {},
) {
  const ticket = await createUploadUrl(h.store, actor, EVENT, {
    kind: input.kind ?? 'image',
    contentType: input.contentType ?? 'image/jpeg',
    bytes: bytes.byteLength,
    name: 'C:\\Users\\someone\\Pictures\\deck photo.jpg',
    gated: input.gated,
  });
  if (!ticket.ok) throw new Error(ticket.error.message);
  const res = await uploadPut(
    new NextRequest(`http://localhost${ticket.value.uploadUrl}`, {
      method: 'PUT',
      body: Buffer.from(bytes),
      headers: { 'content-type': input.contentType ?? 'image/jpeg' },
    }),
  );
  expect(res.status).toBe(200);
  return ticket.value;
}

function docWith(mediaId: string): EventDoc {
  return {
    schemaVersion: 1,
    theme: {} as never,
    meta: {} as never,
    sections: [{ props: { image: { mediaId } } } as never],
  } as EventDoc;
}

describe('sniff and the sharp pipeline', () => {
  it('tells files apart by their bytes', async () => {
    expect(sniff(await phonePhoto())).toBe('jpeg');
    expect(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      'svg',
    );
    expect(sniff(new TextEncoder().encode('\uFEFF  <?xml version="1.0"?><svg/>'))).toBe('svg');
    expect(sniff(new TextEncoder().encode('%PDF-1.7 fictional'))).toBe('pdf');
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    expect(sniff(heic)).toBe('heic');
    const mp4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom'), 0, 0, 2, 0]);
    expect(sniff(mp4)).toBe('mp4');
  });

  it('applies the EXIF rotation, strips EXIF and GPS, and makes every size', async () => {
    const out = await processImage(await phonePhoto(2400, 1600));
    // Orientation 6: the 2400×1600 sensor image is a 1600×2400 portrait.
    expect([out.width, out.height]).toEqual([1600, 2400]);
    expect(out.variants.map((v) => `${v.w}.${v.format}`)).toEqual([
      ...IMAGE_WIDTHS.filter((w) => w <= 1600).flatMap((w) => [`${w}.avif`, `${w}.webp`]),
      '1080.jpg',
    ]);
    for (const v of out.variants) {
      const meta = await sharp(v.data).metadata();
      expect(meta.exif, `${v.w}.${v.format}`).toBeUndefined();
      expect(meta.orientation ?? 1).toBe(1);
      expect(meta.width).toBe(v.w);
    }
    expect(out.thumbhash.length).toBeGreaterThan(10);
    expect(out.colors[0]).toMatch(/^#[0-9A-F]{6}$/);
    // The emerald background leads (JPEG nudges it by a shade or two).
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(out.colors[0]!.slice(i, i + 2), 16));
    expect(Math.abs(r! - 0x2b) + Math.abs(g! - 0x6d) + Math.abs(b! - 0x56)).toBeLessThan(12);
  });

  it('never enlarges a small image and keeps a logo transparent', async () => {
    const logo = new Uint8Array(
      await sharp({
        create: { width: 120, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    const out = await processImage(logo, { logo: true });
    expect(out.variants.map((v) => `${v.w}.${v.format}`)).toEqual([
      '120.avif',
      '120.webp',
      '120.png',
    ]);
    const png = out.variants.find((v) => v.format === 'png')!;
    expect((await sharp(png.data).metadata()).hasAlpha).toBe(true);
  });

  it('refuses SVG, HEIC and garbage with a plain sentence', async () => {
    await expect(processImage(new TextEncoder().encode('<svg onload="x"/>'))).rejects.toThrow(
      /SVG/,
    );
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    await expect(processImage(heic)).rejects.toThrow(/HEIC/);
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    await expect(processImage(broken)).rejects.toThrow(/could not/);
  });
});

describe('uploads end to end (local storage)', () => {
  it('signed upload → process → public derivatives, served by the demo bucket route', async () => {
    const ticket = await upload(owner, await phonePhoto());
    expect(ticket.uploadUrl).toMatch(/^\/api\/event-media\/upload\?token=/);
    expect(ticket.path).toMatch(
      new RegExp(`^${h.auth.organizationId}/${EVENT}/${ticket.mediaId}/original\\.jpg$`),
    );

    const processed = await processMedia(h.store, owner, EVENT, ticket.mediaId);
    expect(processed.ok).toBe(true);
    if (!processed.ok) return;
    expect(processed.value).toMatchObject({
      status: 'ready',
      width: 200,
      height: 300,
      gated: false,
      original_name: 'deck photo.jpg',
    });
    // Idempotent.
    expect((await processMedia(h.store, owner, EVENT, ticket.mediaId)).ok).toBe(true);

    const map = await resolveMedia(
      h.store,
      h.auth.organizationId,
      EVENT,
      docWith(ticket.mediaId),
      PUBLIC_VIEWER,
    );
    const item = map.ok ? map.value[ticket.mediaId]! : null;
    expect(item?.src).toMatch(/^\/api\/event-media\/.+\.200\.webp$/);
    expect(item?.variants.map((v) => v.format)).toEqual(['avif', 'webp', 'jpg']);
    expect(JSON.stringify(item)).not.toContain('original');

    const parts = item!.src!.replace('/api/event-media/', '').split('/');
    const res = await publicGet(new NextRequest(`http://localhost${item!.src}`), {
      params: Promise.resolve({ path: parts }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).exif).toBeUndefined();

    // The original is never reachable through the public route.
    const orig = await publicGet(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({ path: ticket.path.split('/') }),
    });
    expect(orig.status).toBe(404);

    const audit = await h.store.list('audit_events', h.auth.organizationId, {
      eq: { action: 'event.media_uploaded' },
    });
    expect(audit).toHaveLength(1);
  });

  it('gated media stays private and resolves to short-lived signed URLs', async () => {
    const ticket = await upload(owner, await phonePhoto(), { gated: true });
    const processed = await processMedia(h.store, owner, EVENT, ticket.mediaId);
    expect(processed.ok && processed.value.gated).toBe(true);
    const map = await resolveMedia(h.store, h.auth.organizationId, EVENT, docWith(ticket.mediaId), {
      ...PUBLIC_VIEWER,
      going: true,
    });
    const item = map.ok ? map.value[ticket.mediaId]! : null;
    expect(item?.gated).toBe(true);
    expect(item?.src).toMatch(/^\/api\/event-media\/signed\?token=/);
    const res = await signedGet(new NextRequest(`http://localhost${item!.src}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    // Nothing of it in the public folder.
    const variant = processed.ok ? processed.value.variants[0]! : null;
    const pub = await publicGet(new NextRequest('http://localhost/x'), {
      params: Promise.resolve({ path: variant!.path.split('/') }),
    });
    expect(pub.status).toBe(404);
    // The public share card leaves gated media out entirely.
    const card = await resolveMedia(
      h.store,
      h.auth.organizationId,
      EVENT,
      docWith(ticket.mediaId),
      PUBLIC_VIEWER,
      { excludeGated: true },
    );
    expect(card.ok && card.value).toEqual({});
    // Outside links see the gated item in the draft, never a URL to it.
    const forEditor = await resolveMedia(
      h.store,
      h.auth.organizationId,
      EVENT,
      docWith(ticket.mediaId),
      { ...PUBLIC_VIEWER, kind: 'editor' },
    );
    expect(forEditor.ok && forEditor.value[ticket.mediaId]).toMatchObject({
      gated: true,
      src: null,
      variants: [],
    });
    const library = await listResolvedMedia(
      h.store,
      outsideActor(EVENT, h.auth.organizationId),
      EVENT,
    );
    expect(library.ok && library.value.find((m) => m.id === ticket.mediaId)?.src).toBeNull();
    // A forged or expired read token opens nothing.
    expect((await signedGet(new NextRequest('http://localhost/x?token=nope'))).status).toBe(404);
  });

  it('switching gated moves the derivatives to the other bucket', async () => {
    const ticket = await upload(owner, await phonePhoto());
    const ready = await processMedia(h.store, owner, EVENT, ticket.mediaId);
    const path0 = ready.ok ? ready.value.variants[0]!.path : '';
    expect((await storage.get('public', path0)).ok).toBe(true);
    const moved = await updateMedia(h.store, owner, EVENT, ticket.mediaId, { gated: true });
    expect(moved.ok && moved.value.gated).toBe(true);
    expect((await storage.get('public', path0)).ok).toBe(false);
    expect((await storage.get('private', path0)).ok).toBe(true);
  });

  it('refuses SVG, HEIC, QuickTime and oversize files before any upload', async () => {
    const svg = await createUploadUrl(h.store, owner, EVENT, {
      kind: 'image',
      contentType: 'image/svg+xml',
      bytes: 100,
      name: 'logo.svg',
    });
    expect(!svg.ok && svg.error.code).toBe('unsupported_media_type');
    const heic = await createUploadUrl(h.store, owner, EVENT, {
      kind: 'image',
      contentType: 'image/heic',
      bytes: 100,
      name: 'a.heic',
    });
    expect(!heic.ok && heic.error.message).toMatch(/HEIC/);
    const mov = await createUploadUrl(h.store, owner, EVENT, {
      kind: 'video',
      contentType: 'video/quicktime',
      bytes: 100,
      name: 'clip.mov',
    });
    expect(!mov.ok && mov.error.message).toMatch(/MP4/);
    const big = await createUploadUrl(h.store, owner, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 26 * 1024 * 1024,
      name: 'huge.jpg',
    });
    expect(!big.ok && big.error.code).toBe('too_large');
  });

  it('marks a disguised file failed: the bytes, not the declared type, decide', async () => {
    const ticket = await upload(owner, new TextEncoder().encode('<svg onload="alert(1)"/>'), {
      contentType: 'image/png',
    }).catch(() => null);
    // The private bucket refuses nothing it would take as PNG, so the upload lands …
    expect(ticket).not.toBeNull();
    const processed = await processMedia(h.store, owner, EVENT, ticket!.mediaId);
    // … and processing refuses it.
    expect(!processed.ok && processed.error.code).toBe('unsupported_media_type');
    const row = await h.store.get('event_media', h.auth.organizationId, ticket!.mediaId);
    expect(row).toMatchObject({ status: 'failed', variants: [] });
  });

  it('the upload route checks its token and the size it allows', async () => {
    const ticket = await createUploadUrl(h.store, owner, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'a.jpg',
    });
    if (!ticket.ok) throw new Error('no ticket');
    const forged = await uploadPut(
      new NextRequest('http://localhost/api/event-media/upload?token=forged', {
        method: 'PUT',
        body: Buffer.from([1, 2, 3]),
      }),
    );
    expect(forged.status).toBe(403);
    const tooBig = await uploadPut(
      new NextRequest(`http://localhost${ticket.value.uploadUrl}`, {
        method: 'PUT',
        body: Buffer.alloc(26 * 1024 * 1024),
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    expect(tooBig.status).toBe(413);
  });

  it('files stay private, download with their name; videos keep a linked poster', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n% fictional pre-read\n');
    const file = await upload(owner, pdf, { kind: 'file', contentType: 'application/pdf' });
    const fileReady = await processMedia(h.store, owner, EVENT, file.mediaId);
    expect(fileReady.ok && fileReady.value).toMatchObject({ status: 'ready', gated: true });

    const mp4 = new Uint8Array([
      0,
      0,
      0,
      24,
      ...new TextEncoder().encode('ftypisom'),
      0,
      0,
      2,
      0,
      ...new TextEncoder().encode('isomiso2'),
      1,
      2,
      3,
      4,
    ]);
    const video = await upload(owner, mp4, { kind: 'video', contentType: 'video/mp4' });
    const videoReady = await processMedia(h.store, owner, EVENT, video.mediaId);
    expect(videoReady.ok && videoReady.value.variants[0]?.format).toBe('mp4');

    const still = await upload(owner, await phonePhoto());
    await processMedia(h.store, owner, EVENT, still.mediaId);
    const linked = await updateMedia(h.store, owner, EVENT, video.mediaId, {
      posterMediaId: still.mediaId,
    });
    expect(linked.ok && linked.value.poster_path).toMatch(/\.jpg$/);

    const list = await listResolvedMedia(h.store, owner, EVENT);
    const byId = new Map((list.ok ? list.value : []).map((m) => [m.id, m]));
    expect(byId.get(file.mediaId)).toMatchObject({
      kind: 'file',
      fileName: 'deck photo.jpg',
      gated: true,
    });
    expect(byId.get(file.mediaId)?.src).toMatch(/signed\?token=/);
    expect(byId.get(video.mediaId)?.posterUrl).toMatch(/\.jpg$/);
    expect(byId.get(video.mediaId)?.src).toMatch(/\.mp4$/);

    const res = await signedGet(new NextRequest(`http://localhost${byId.get(file.mediaId)!.src}`));
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="deck photo\.jpg"/,
    );
  });

  it('deleting refuses media the page uses and removes the files otherwise', async () => {
    const ticket = await upload(owner, await phonePhoto());
    const ready = await processMedia(h.store, owner, EVENT, ticket.mediaId);
    const draft = await getDraft(h.store, owner, EVENT);
    if (!draft.ok || !ready.ok) throw new Error('setup');
    const doc = structuredClone(draft.value.doc);
    doc.sections[0]!.props.image = { mediaId: ticket.mediaId };
    await h.store.update('events', h.auth.organizationId, EVENT, {
      draft_doc: doc as unknown as Record<string, unknown>,
    });
    const refused = await deleteMedia(h.store, owner, EVENT, ticket.mediaId);
    expect(!refused.ok && refused.error.code).toBe('conflict');

    await h.store.update('events', h.auth.organizationId, EVENT, {
      draft_doc: draft.value.doc as unknown as Record<string, unknown>,
    });
    const deleted = await deleteMedia(h.store, owner, EVENT, ticket.mediaId);
    expect(deleted.ok).toBe(true);
    expect((await storage.get('public', ready.value.variants[0]!.path)).ok).toBe(false);
    expect((await storage.get('private', ticket.path)).ok).toBe(false);
  });
});

describe('outside editors', () => {
  it('may upload within their link, never gated media or files, and are rate limited', async () => {
    const morgan = outsideActor(EVENT, h.auth.organizationId);
    const gated = await createUploadUrl(h.store, morgan, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'a.jpg',
      gated: true,
    });
    expect(!gated.ok && gated.error.code).toBe('forbidden');
    const file = await createUploadUrl(h.store, morgan, EVENT, {
      kind: 'file',
      contentType: 'application/pdf',
      bytes: 10,
      name: 'a.pdf',
    });
    expect(!file.ok && file.error.code).toBe('forbidden');

    for (let i = 0; i < GRANT_UPLOADS_PER_HOUR; i++) {
      const t = await createUploadUrl(h.store, morgan, EVENT, {
        kind: 'image',
        contentType: 'image/jpeg',
        bytes: 10,
        name: `${i}.jpg`,
      });
      expect(t.ok).toBe(true);
    }
    const over = await createUploadUrl(h.store, morgan, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'more.jpg',
    });
    expect(!over.ok && over.error.code).toBe('rate_limited');
  });

  it('cannot reach another event, upload with a viewer link, or upload while paused', async () => {
    const elsewhere = outsideActor(DEMO_EVENT_IDS.annualMeeting, h.auth.organizationId);
    const r = await createUploadUrl(h.store, elsewhere, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'a.jpg',
    });
    expect(!r.ok && r.error.code).toBe('not_found');
    const viewer = outsideActor(EVENT, h.auth.organizationId, { role: 'viewer' });
    const v = await createUploadUrl(h.store, viewer, EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'a.jpg',
    });
    expect(!v.ok && v.error.code).toBe('forbidden');
    await h.store.update('events', h.auth.organizationId, EVENT, { editing_paused: true });
    const p = await createUploadUrl(h.store, outsideActor(EVENT, h.auth.organizationId), EVENT, {
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 10,
      name: 'a.jpg',
    });
    expect(!p.ok && p.error.code).toBe('forbidden');
    // And they never delete.
    const del = await deleteMedia(
      h.store,
      outsideActor(EVENT, h.auth.organizationId),
      EVENT,
      EVENT,
    );
    expect(!del.ok && del.error.code).toBe('forbidden');
  });
});
