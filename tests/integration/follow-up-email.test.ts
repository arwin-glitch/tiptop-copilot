import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { readEmailSession } from '@/lib/services/email-session';
import { readFollowUps, resetFollowUpsCache } from '@/lib/services/follow-ups';
import { resetFollowUpEmailCache } from '@/lib/services/follow-up-email';
import { err, ok } from '@/lib/util/result';

/**
 * GET /api/follow-ups/email against the demo store: signed in only, plain
 * text, never cached by the browser, and a fictional email for every id the
 * Follow-ups list and the email session show.
 */

let harness: Harness;
let signedIn = true;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (signedIn ? ok(harness.auth) : err('unauthenticated', 'Sign in.')),
}));

const { GET } = await import('@/app/api/follow-ups/email/route');

const call = (id: string) =>
  GET(new NextRequest(`http://localhost/api/follow-ups/email?id=${encodeURIComponent(id)}`));

beforeEach(async () => {
  signedIn = true;
  resetFollowUpsCache();
  resetFollowUpEmailCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('GET /api/follow-ups/email', () => {
  it('answers the email behind a session item, as plain text, not cached by the browser', async () => {
    const res = await call('0f0000000000c101');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as {
      ok: boolean;
      email: { focus: { fromName: string; text: string }; earlier: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.email.focus.fromName).toBe('Dana Whitfield');
    expect(body.email.earlier).toHaveLength(2);
    expect(body.email.focus.text).toContain('https://events.whitfieldhouse.demo/dinner');
  });

  it('says an unknown email is gone and a malformed id is bad', async () => {
    const gone = await call('0f00000000009999');
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: { message: string } }).error.message).toBe(
      'This email is no longer in Gmail.',
    );
    expect((await call('zz')).status).toBe(400);
  });

  it('is closed to anyone signed out', async () => {
    signedIn = false;
    expect((await call('0f0000000000c101')).status).toBe(401);
  });

  it('has an email for every item in the demo list and session', async () => {
    const { store, auth } = harness;
    const { snapshot } = await readFollowUps(store, auth.organizationId);
    const session = await readEmailSession(store, auth.organizationId);
    const ids = new Set([
      ...session.items.map((i) => i.id),
      ...(snapshot.waiting?.items ?? []).map((w) => w.thread_id),
      ...snapshot.scheduling.map((s) => s.thread_id),
      ...(snapshot.relationships?.waiting ?? []).flatMap((w) => (w.thread_id ? [w.thread_id] : [])),
    ]);
    expect(ids.size).toBeGreaterThan(10);
    for (const id of ids) expect((await call(id)).status, id).toBe(200);
  });
});
