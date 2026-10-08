import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readAnswers,
  readEmailSession,
  recordAnswer,
  sessionSummary,
} from '@/lib/services/email-session';
import { resetFollowUpsCache } from '@/lib/services/follow-ups';
import { createHarness, type Harness } from '../helpers/harness';

/** The email session end to end against the demo store: answers persist and move the queue. */

let harness: Harness;

beforeEach(async () => {
  resetFollowUpsCache();
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe('email session', () => {
  it('starts with the most urgent email and the Arwin pile split off', async () => {
    const s = await readEmailSession(harness.store, harness.auth.organizationId);
    expect(s.state).toBe('ok');
    expect(s.items[0]?.group).toBe('today');
    const summary = sessionSummary(s);
    expect(summary.forNick).toBeGreaterThan(0);
    expect(summary.forArwin).toBe(1);
  });

  it('records answers, newest wins, and keeps a note word for word', async () => {
    const { store, auth } = harness;
    const user = { id: auth.userId, name: 'Nick' };
    const first = (await readEmailSession(store, auth.organizationId)).items[0]!;
    await recordAnswer(store, auth.organizationId, user, { id: first.id, answer: 'later' });
    await new Promise((r) => setTimeout(r, 5));
    await recordAnswer(store, auth.organizationId, user, {
      id: first.id,
      answer: 'note',
      note: 'Say yes <b>tonight</b> works',
    });
    const answers = await readAnswers(store, auth.organizationId, new Date());
    expect(answers.get(first.id)?.answer).toBe('note');
    expect(answers.get(first.id)?.note).toBe('Say yes <b>tonight</b> works');
    expect(answers.get(first.id)?.by).toBe('Nick');

    const after = await readEmailSession(store, auth.organizationId);
    expect(sessionSummary(after).answered).toBe(1);
  });

  it('"I\'ll handle it" moves an email from Arwin\'s pile to Nick', async () => {
    const { store, auth } = harness;
    const pile = (await readEmailSession(store, auth.organizationId)).items.find(
      (i) => !i.needsNick,
    )!;
    await recordAnswer(
      store,
      auth.organizationId,
      { id: auth.userId, name: 'Nick' },
      {
        id: pile.id,
        answer: 'stop',
      },
    );
    const after = await readEmailSession(store, auth.organizationId);
    expect(after.items.find((i) => i.id === pile.id)?.needsNick).toBe(true);
  });
});
