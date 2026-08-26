import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { POST as webhook } from '@/app/api/integrations/granola/webhook/route';
import { POST as backfill } from '@/app/api/integrations/granola/backfill/route';

/**
 * Which credential opens which door.
 *
 * Two tokens reach these routes and they are deliberately not equal.
 * `GRANOLA_WEBHOOK_SECRET` posts a note *and* starts a backfill, which spends
 * Granola API quota and can walk years of history. `GRANOLA_BRIDGE_TOKEN` only
 * posts a note.
 *
 * The split exists because of where the weaker token has to live. A cloud
 * routine carries its credential inside its own prompt, and the routines API
 * returns that prompt in full on `get`, on `run`, and in run logs — so the
 * value lands in a transcript every time anyone touches the routine. It was
 * assumed leaked the day it was created, which is exactly why it must not be
 * able to do anything but file a note.
 *
 * The load-bearing assertion in this file is the negative one: the bridge
 * token is refused by `/backfill`. If someone ever "simplifies" the two
 * credentials back into one, that test fails and says why.
 */

const WEBHOOK_SECRET = 'webhook-secret-for-tests-0000000000';
const BRIDGE_TOKEN = 'bridge-token-for-tests-1111111111';

let harness: Harness;
const SAVED = { ...process.env };

beforeEach(async () => {
  harness = await createHarness();
  process.env.GRANOLA_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GRANOLA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.GRANOLA_API_KEY = 'grn_not_called_in_these_tests';
  resetEnvCache();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

/** A minimal note in the shape `GRANOLA_NOTE_SCHEMA` accepts. */
function note(externalId: string) {
  return {
    external_id: externalId,
    title: 'Friday Wrap-Up – Weekly Review',
    occurred_at: '2026-08-21T15:00:00.000Z',
    attendee_emails: ['nick@tiptop.vc', 'arwin@tiptop.vc'],
    attendee_names: ['Nick Tippmann', 'Arwin Reyes'],
    content: 'A private note, the kind Granola will not serve to a workspace key.',
  };
}

function postTo(path: string, token: string, body?: unknown) {
  return new NextRequest(
    `https://tiptop-copilot.onrender.com/api/integrations/granola/${path}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe('posting a note', () => {
  it('accepts the ingest-only bridge token', async () => {
    const response = await webhook(postTo('webhook', BRIDGE_TOKEN, note('bridge-note-1')));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: true });
  });

  it('still accepts the original webhook secret', async () => {
    // The bridge token is an addition, not a replacement: Granola's own signed
    // deliveries and the existing senders must keep working untouched.
    const response = await webhook(postTo('webhook', WEBHOOK_SECRET, note('secret-note-1')));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: true });
  });

  it('refuses a token that is neither', async () => {
    const response = await webhook(postTo('webhook', 'not-either-of-them', note('nope')));
    expect(response.status).toBe(401);
  });

  it('refuses a token that is a prefix of a real one', async () => {
    // Length is checked before the constant-time compare; a truncated token
    // must not pass on the strength of the bytes it does share.
    const response = await webhook(postTo('webhook', WEBHOOK_SECRET.slice(0, 10), note('nope')));
    expect(response.status).toBe(401);
  });
});

describe('starting a backfill', () => {
  it('REFUSES the bridge token', async () => {
    // The whole point of the split. A leaked ingest token must not be able to
    // spend Granola API quota or walk the history.
    const response = await backfill(postTo('backfill', BRIDGE_TOKEN));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
  });

  it('accepts the webhook secret, which is the credential that owns it', async () => {
    // Authorisation is what is under test, so this stops at the first thing
    // past the token check rather than calling Granola: with no unambiguous
    // organization the route answers 409, which is proof enough that the
    // caller got through the door.
    await harness.store.removeWhere('organizations', harness.auth.organizationId, {});
    const response = await backfill(postTo('backfill', WEBHOOK_SECRET));
    expect(response.status).not.toBe(401);
  });
});

describe('when neither credential is configured', () => {
  it('says so rather than refusing as if the token were wrong', async () => {
    delete process.env.GRANOLA_WEBHOOK_SECRET;
    delete process.env.GRANOLA_BRIDGE_TOKEN;
    resetEnvCache();

    const response = await webhook(postTo('webhook', 'anything', note('nope')));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_configured' },
    });
  });
});
