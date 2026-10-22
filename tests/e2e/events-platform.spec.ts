import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * Events platform services (D-075, WS1), driven through the real API on the
 * demo server: create, edit by ops, upload a photo through the signed URL and
 * process it, publish what was reviewed, version history and restore,
 * duplicate and delete, and the lifecycle. Demo storage stands in for both
 * buckets at /api/event-media. Fictional data only; nothing sends email.
 */

const SIGNED_IN = path.resolve('test-results', 'events-platform-state.json');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

interface Answer {
  status: number;
  /** Loosely typed API bodies. */
  body: any;
}

/**
 * A same-origin fetch from inside the signed-in page: the session cookie is
 * Secure, which Playwright's own request client will not send over http.
 */
async function call(page: Page, method: string, url: string, data?: unknown): Promise<Answer> {
  return page.evaluate(
    async ({ method, url, data }) => {
      const res = await fetch(url, {
        method,
        headers: data === undefined ? {} : { 'content-type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    { method, url, data },
  );
}

function json(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(400);
  expect(answer.body.ok).toBe(true);
  return answer.body;
}

test.describe('signed in', () => {
  test.use({ storageState: SIGNED_IN });

  test('create → edit → upload → publish → history → restore → duplicate → lifecycle', async ({
    page,
  }) => {
    await page.goto('/today');
    const api = {
      get: (url: string) => call(page, 'GET', url),
      post: (url: string, o?: { data?: unknown }) => call(page, 'POST', url, o?.data),
      patch: (url: string, o?: { data?: unknown }) => call(page, 'PATCH', url, o?.data),
      delete: (url: string) => call(page, 'DELETE', url),
    };

    // Create a draft.
    const created = await json(
      await api.post('/api/events', {
        data: {
          title: 'Lakeside Founders Supper',
          startsAt: '2031-05-01T23:00:00.000Z',
          endsAt: '2031-05-02T02:00:00.000Z',
          venue: { name: 'The Boathouse', address: '1 Example Pier' },
        },
      }),
    );
    const id: string = created.id;
    expect(created.slug).toBe('lakeside-founders-supper');

    // Edit the hero by ops.
    const draft = await json(await api.get(`/api/events/${id}/draft`));
    const hero = draft.doc.sections.find((s: { type: string }) => s.type === 'hero');
    const edited = await json(
      await api.post(`/api/events/${id}/draft/ops`, {
        data: {
          baseVersion: draft.version,
          ops: [
            {
              kind: 'section.update',
              opId: 'headline',
              id: hero.id,
              baseRev: hero.rev,
              set: { 'props.headline': 'Supper by the lake' },
            },
          ],
        },
      }),
    );
    expect(edited.version).toBe(1);
    expect(edited.applied).toEqual(['headline']);

    // Upload a photo straight to the signed URL, then process it.
    const photo = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#2B6D56' },
    })
      .jpeg()
      .toBuffer();
    const ticket = await json(
      await api.post(`/api/events/${id}/media/upload-url`, {
        data: { kind: 'image', contentType: 'image/jpeg', bytes: photo.length, name: 'lake.jpg' },
      }),
    );
    expect(ticket.uploadUrl).toMatch(/^\/api\/event-media\/upload\?token=/);
    // The signed upload URL needs no session, like Supabase's.
    const put = await page.request.put(ticket.uploadUrl, {
      data: photo,
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(put.status()).toBe(200);
    const processed = await json(
      await api.post(`/api/events/${id}/media/${ticket.mediaId}/process`),
    );
    expect(processed.media).toMatchObject({ status: 'ready', width: 900, height: 600 });
    expect(processed.media.src).toMatch(/\.640\.webp$/);
    // The public bucket's URL needs no session either.
    const image = await page.request.get(processed.media.src);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/webp');

    // Put it on the page: publishing is blocked until it has alt text.
    const d1 = await json(await api.get(`/api/events/${id}/draft`));
    const hero1 = d1.doc.sections.find((s: { type: string }) => s.type === 'hero');
    await json(
      await api.post(`/api/events/${id}/draft/ops`, {
        data: {
          baseVersion: d1.version,
          ops: [
            {
              kind: 'section.update',
              opId: 'photo',
              id: hero1.id,
              baseRev: hero1.rev,
              set: { 'props.media': { mediaId: ticket.mediaId } },
            },
          ],
        },
      }),
    );
    let preview = await json(await api.get(`/api/events/${id}/publish`));
    expect(preview.canPublish).toBe(false);
    expect(preview.checklist.find((c: { id: string }) => c.id === 'alt_text').ok).toBe(false);
    await json(
      await api.patch(`/api/events/${id}/media/${ticket.mediaId}`, {
        data: { alt: 'Tables set on a jetty at dusk' },
      }),
    );
    preview = await json(await api.get(`/api/events/${id}/publish`));
    expect(preview.canPublish).toBe(true);
    expect(preview.neverPublished).toBe(true);
    expect(preview.lines.map((l: { text: string }) => l.text)).toContain('Hero – added');

    // A stale review is refused; the reviewed one publishes.
    const stale = await api.post(`/api/events/${id}/publish`, {
      data: { expectedDraftVersion: preview.draftVersion - 1 },
    });
    expect(stale.status).toBe(409);
    const published = await json(
      await api.post(`/api/events/${id}/publish`, {
        data: { expectedDraftVersion: preview.draftVersion },
      }),
    );
    expect(published).toMatchObject({ publishedVersion: 1, path: '/e/lakeside-founders-supper' });

    // History: the published version, a named one, then restore.
    await json(await api.post(`/api/events/${id}/versions`, { data: { name: 'As published' } }));
    const d2 = await json(await api.get(`/api/events/${id}/draft`));
    const hero2 = d2.doc.sections.find((s: { type: string }) => s.type === 'hero');
    await json(
      await api.post(`/api/events/${id}/draft/ops`, {
        data: {
          baseVersion: d2.version,
          ops: [
            {
              kind: 'section.update',
              opId: 'oops',
              id: hero2.id,
              baseRev: hero2.rev,
              set: { 'props.headline': 'A mistake' },
            },
          ],
        },
      }),
    );
    const versions = await json(await api.get(`/api/events/${id}/versions`));
    const kinds = versions.versions.map((v: { kind: string }) => v.kind);
    expect(kinds).toEqual(expect.arrayContaining(['published', 'named']));
    const named = versions.versions.find((v: { kind: string }) => v.kind === 'named');
    const one = await json(await api.get(`/api/events/${id}/versions/${named.id}`));
    expect(one.doc.sections.find((s: { type: string }) => s.type === 'hero').props.headline).toBe(
      'Supper by the lake',
    );
    const restored = await json(await api.post(`/api/events/${id}/versions/${named.id}/restore`));
    expect(restored.draftVersion).toBe(d2.version + 2);
    const d3 = await json(await api.get(`/api/events/${id}/draft`));
    expect(d3.doc.sections.find((s: { type: string }) => s.type === 'hero').props.headline).toBe(
      'Supper by the lake',
    );
    const activity = await json(await api.get(`/api/events/${id}/activity?section=${hero.id}`));
    expect(activity.activity.length).toBeGreaterThan(0);

    // Settings: a slug rename after publishing keeps the old one reserved.
    const renamed = await json(
      await api.patch(`/api/events/${id}`, { data: { slug: 'lakeside-supper-2031' } }),
    );
    expect(renamed.event.slug).toBe('lakeside-supper-2031');
    const other = await json(await api.post('/api/events', { data: { title: 'Other night' } }));
    const clash = await api.patch(`/api/events/${other.id}`, {
      data: { slug: 'lakeside-founders-supper' },
    });
    expect(clash.status).toBe(409);

    // Duplicate as next year, then delete the never-published copy.
    const copy = await json(
      await api.post(`/api/events/${id}/duplicate`, { data: { shiftDays: 364 } }),
    );
    expect(copy.slug).toBe('lakeside-founders-supper-copy');
    const copied = await json(await api.get(`/api/events/${copy.id}`));
    expect(copied.event.status).toBe('draft');
    expect(Date.parse(copied.event.starts_at)).toBeGreaterThan(Date.parse('2032-04-28T00:00:00Z'));
    await json(await api.delete(`/api/events/${copy.id}`));
    expect((await api.get(`/api/events/${copy.id}`)).status).toBe(404);
    // A published event cannot be deleted, only archived.
    expect((await api.delete(`/api/events/${id}`)).status).toBe(400);

    // Lifecycle: unpublish, cancel (page stays live with a notice), archive.
    expect((await json(await api.post(`/api/events/${id}/unpublish`))).event.status).toBe('draft');
    const cancelled = await json(
      await api.post(`/api/events/${id}/cancel`, { data: { message: 'Moved to the autumn.' } }),
    );
    expect(cancelled.event.status).toBe('cancelled');
    expect((await json(await api.post(`/api/events/${id}/archive`))).event.status).toBe('archived');
    const library = await json(await api.get('/api/events?tab=past&q=lakeside'));
    expect(library.events.map((e: { id: string }) => e.id)).toContain(id);
  });
});

test.describe('without a session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the events API answers nobody; the demo upload URL needs its token', async ({
    request,
  }) => {
    expect((await request.get('/api/events')).status()).toBe(401);
    expect(
      (
        await request.post('/api/events/00000000-0000-4000-8000-000000000000/publish', { data: {} })
      ).status(),
    ).toBe(401);
    const forged = await request.put('/api/event-media/upload?token=forged', {
      data: Buffer.from([1, 2, 3]),
    });
    expect(forged.status()).toBe(403);
    expect((await request.get('/api/event-media/signed?token=forged')).status()).toBe(404);
    expect((await request.get('/api/event-media/nope/original.jpg')).status()).toBe(404);
  });
});
