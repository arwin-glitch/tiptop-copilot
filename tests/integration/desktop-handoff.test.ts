import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import {
  claimHandoff,
  createHandoff,
  findByPollSecret,
  isSameOrigin,
  mintHandoffSecrets,
  mintMatchCode,
  platformFromUserAgent,
  pollView,
  receiveCode,
  rejectHandoff,
  supersede,
  sweep,
  verifyHandoffCode,
} from '@/lib/auth/desktop-handoff';
import type { DataStore } from '@/lib/db/store';
import { MATCH_CODE_RE } from '@/lib/desktop/shared';
import type { DesktopHandoff } from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';

/**
 * The desktop sign-in hand-off (lib/auth/desktop-handoff.ts), against the
 * demo store. The short code is minted in the browser's leg, never at the
 * start, and a right code claims the hand-off exactly once.
 */

let harness: Harness;
const AUTH_CODE = 'f1e2d3c4-0000-4000-8000-00000000c0de';

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function begin(now = new Date()) {
  const secrets = mintHandoffSecrets();
  const created = await createHandoff(harness.store, {
    secrets,
    flowId: 'flow-0001',
    platform: 'mac',
    now,
  });
  if (!created.ok) throw new Error(created.error.message);
  return { secrets, row: created.value };
}

async function rows(): Promise<DesktopHandoff[]> {
  return harness.store.list('desktop_handoffs', '');
}

async function codeShown(handoffId: string, now = new Date()): Promise<string> {
  const view = await receiveCode(harness.store, {
    handoffId,
    code: AUTH_CODE,
    providerError: false,
    now,
  });
  if (!view.ok || view.value.kind !== 'show') throw new Error('no code shown');
  return view.value.matchCode;
}

function otherCode(code: string): string {
  return code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
}

describe('secrets and codes', () => {
  it('mints 256-bit secrets and well-formed codes', () => {
    const a = mintHandoffSecrets();
    const b = mintHandoffSecrets();
    expect(a.handoffId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.handoffId, a.pollSecret, b.handoffId, b.pollSecret]).size).toBe(4);
    for (let i = 0; i < 200; i++) expect(mintMatchCode()).toMatch(MATCH_CODE_RE);
  });

  it('stores hashes, never the secrets, and no code at the start', async () => {
    const { secrets, row } = await begin();
    expect(row.handoff_hash).toBe(sha256(secrets.handoffId));
    expect(row.poll_secret_hash).toBe(sha256(secrets.pollSecret));
    expect(row.match_code).toBeNull();
    const stored = JSON.stringify(await rows());
    expect(stored).not.toContain(secrets.handoffId);
    expect(stored).not.toContain(secrets.pollSecret);
  });

  it('tells platforms apart for the audit trail', () => {
    expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
    expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformFromUserAgent('curl/8.0')).toBe('other');
    expect(platformFromUserAgent(null)).toBe('other');
    // An iPhone says "like Mac OS X"; the column has no iPhone value.
    expect(
      platformFromUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TipTopCopilotiOS/1.0.0',
      ),
    ).toBe('other');
    expect(
      platformFromUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('other');
  });
});

describe('the browser leg', () => {
  it('seals Google’s code and only then mints the code it shows', async () => {
    const { secrets } = await begin();
    expect(pollView(await findByPollSecret(harness.store, secrets.pollSecret))).toEqual({
      status: 'waiting',
    });

    const code = await codeShown(secrets.handoffId);
    expect(code).toMatch(MATCH_CODE_RE);
    const [row] = await rows();
    expect(row?.status).toBe('code_received');
    expect(row?.match_code).toBe(code);
    expect(row?.auth_code_sealed).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(AUTH_CODE);
    expect(pollView(row ?? null)).toEqual({ status: 'enter_code', attemptsLeft: 3 });
  });

  it('shows the code again only to a reload carrying the same Google code', async () => {
    const { secrets } = await begin();
    const code = await codeShown(secrets.handoffId);
    expect(await codeShown(secrets.handoffId)).toBe(code);
    // Someone with only the hand-off id (it is in the sign-in URL) does not see it.
    for (const other of [null, 'some-other-code']) {
      const view = await receiveCode(harness.store, {
        handoffId: secrets.handoffId,
        code: other,
        providerError: false,
      });
      expect(view.ok && view.value.kind).toBe('shown');
    }
  });

  it('treats unknown, malformed and expired links alike', async () => {
    for (const handoffId of [null, 'bogus', mintHandoffSecrets().handoffId]) {
      const view = await receiveCode(harness.store, {
        handoffId,
        code: AUTH_CODE,
        providerError: false,
      });
      expect(view.ok && view.value.kind).toBe('expired');
    }
    const { secrets } = await begin(new Date(Date.now() - 11 * 60_000));
    const late = await receiveCode(harness.store, {
      handoffId: secrets.handoffId,
      code: AUTH_CODE,
      providerError: false,
    });
    expect(late.ok && late.value.kind).toBe('expired');
  });

  it('ends the hand-off when Google says the person cancelled, or sent no code', async () => {
    const cancelled = await begin();
    const view = await receiveCode(harness.store, {
      handoffId: cancelled.secrets.handoffId,
      code: null,
      providerError: true,
    });
    expect(view.ok && view.value.kind).toBe('cancelled');
    expect(pollView(await findByPollSecret(harness.store, cancelled.secrets.pollSecret))).toEqual({
      status: 'failed',
      reason: 'cancelled',
    });

    const empty = await begin();
    const stopped = await receiveCode(harness.store, {
      handoffId: empty.secrets.handoffId,
      code: 'not a code!',
      providerError: false,
    });
    expect(stopped.ok && stopped.value.kind).toBe('stopped');
  });
});

describe('typing the code into the app', () => {
  it('claims the hand-off once with the right code, and hands back Google’s code', async () => {
    const { secrets } = await begin();
    const code = await codeShown(secrets.handoffId);

    const first = await verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code });
    expect(first.ok && first.value.kind).toBe('claimed');
    if (!first.ok || first.value.kind !== 'claimed') return;
    expect(first.value.authCode).toBe(AUTH_CODE);
    expect(first.value.row.flow_id).toBe('flow-0001');

    const [row] = await rows();
    expect(row?.status).toBe('claimed');
    expect(row?.auth_code_sealed).toBeNull();
    expect(row?.match_code).toBeNull();

    const again = await verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code });
    expect(again.ok && again.value.kind === 'status' && again.value.status).toEqual({
      status: 'waiting',
    });
  });

  it('lets only one of two simultaneous right codes claim it', async () => {
    const { secrets } = await begin();
    const code = await codeShown(secrets.handoffId);
    const results = await Promise.all([
      verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code }),
      verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code }),
    ]);
    const claimed = results.filter((r) => r.ok && r.value.kind === 'claimed');
    expect(claimed).toHaveLength(1);
  });

  it('stops after three wrong codes, and the right one no longer works', async () => {
    const { secrets } = await begin();
    const code = await codeShown(secrets.handoffId);
    const wrong = otherCode(code);
    const answers = [];
    for (let i = 0; i < 3; i++) {
      const result = await verifyHandoffCode(harness.store, {
        pollSecret: secrets.pollSecret,
        code: wrong,
      });
      answers.push(result.ok && result.value.kind === 'status' ? result.value.status : null);
    }
    expect(answers).toEqual([
      { status: 'wrong_code', attemptsLeft: 2 },
      { status: 'wrong_code', attemptsLeft: 1 },
      { status: 'failed', reason: 'wrong_code' },
    ]);

    const late = await verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code });
    expect(late.ok && late.value.kind === 'status' && late.value.status).toEqual({
      status: 'failed',
      reason: 'wrong_code',
    });
    const [row] = await rows();
    expect(row?.auth_code_sealed).toBeNull();
  });

  it('counts guesses sent all at once one by one', async () => {
    const { secrets } = await begin();
    const code = await codeShown(secrets.handoffId);
    const guesses = ['2222', '3333', '4444', '5555', '6666', '7777'].filter((g) => g !== code);
    await Promise.all(
      guesses.map((guess) =>
        verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code: guess }),
      ),
    );
    const [row] = await rows();
    expect(row?.attempts).toBe(3);
    expect(row?.status).toBe('failed');
  });

  it('never compares more than three codes, however many arrive with the right one', async () => {
    for (const rightAt of ['last', 'first'] as const) {
      const { secrets } = await begin();
      const code = await codeShown(secrets.handoffId);
      const wrong = ['2222', '3333', '4444', '5555', '6666', '7777'].filter((g) => g !== code);
      const guesses = rightAt === 'last' ? [...wrong, code] : [code, ...wrong];
      const results = await Promise.all(
        guesses.map((guess) =>
          verifyHandoffCode(harness.store, { pollSecret: secrets.pollSecret, code: guess }),
        ),
      );

      const claimed = results.filter((r) => r.ok && r.value.kind === 'claimed');
      const missed = results.filter(
        (r) => r.ok && r.value.kind === 'status' && r.value.status.status === 'wrong_code',
      );
      const row = (await findByPollSecret(harness.store, secrets.pollSecret)) as DesktopHandoff;
      // Only a code that took one of the three tries was compared.
      expect(row.attempts).toBeLessThanOrEqual(3);
      expect(claimed.length + missed.length).toBeLessThanOrEqual(3);
      if (rightAt === 'last') {
        // Three wrong codes took every try before the right one could.
        expect(claimed).toHaveLength(0);
        expect(row.status).toBe('failed');
        expect(row.failure_reason).toBe('wrong_code');
      } else {
        expect(claimed).toHaveLength(1);
        expect(row.status).toBe('claimed');
      }
      // The rest were told to slow down, not whether they were right.
      for (const result of results) {
        if (!result.ok) expect(result.error.code).toBe('rate_limited');
      }
    }
  });

  it('refuses a code after the hand-off expires', async () => {
    const started = new Date(Date.now() - 9 * 60_000);
    const { secrets, row } = await begin(started);
    const code = await codeShown(secrets.handoffId, started);
    const later = new Date(Date.now() + 2 * 60_000);
    const result = await verifyHandoffCode(harness.store, {
      pollSecret: secrets.pollSecret,
      code,
      now: later,
    });
    expect(result.ok && result.value.kind === 'status' && result.value.status).toEqual({
      status: 'expired',
    });
    const fresh = (await findByPollSecret(harness.store, secrets.pollSecret)) as DesktopHandoff;
    expect(await claimHandoff(harness.store, fresh, later)).toBeNull();
    expect(row.id).toBe(fresh.id);
  });
});

describe('stopping and tidying', () => {
  it('stops a hand-off from the browser, and says when it is too late', async () => {
    const pending = await begin();
    const stopped = await rejectHandoff(harness.store, pending.secrets.handoffId);
    expect(stopped.ok && stopped.value).toBe('rejected');
    expect(pollView(await findByPollSecret(harness.store, pending.secrets.pollSecret))).toEqual({
      status: 'failed',
      reason: 'rejected',
    });

    const done = await begin();
    const code = await codeShown(done.secrets.handoffId);
    await verifyHandoffCode(harness.store, { pollSecret: done.secrets.pollSecret, code });
    const late = await rejectHandoff(harness.store, done.secrets.handoffId);
    expect(late.ok && late.value).toBe('finished');

    const unknown = await rejectHandoff(harness.store, 'bogus');
    expect(unknown.ok && unknown.value).toBe('expired');
  });

  it('lets a newer sign-in replace the one an app was waiting on', async () => {
    const old = await begin();
    await codeShown(old.secrets.handoffId);
    await supersede(harness.store, old.secrets.pollSecret);
    expect(pollView(await findByPollSecret(harness.store, old.secrets.pollSecret))).toEqual({
      status: 'failed',
      reason: 'superseded',
    });
    const view = await receiveCode(harness.store, {
      handoffId: old.secrets.handoffId,
      code: AUTH_CODE,
      providerError: false,
    });
    expect(view.ok && view.value.kind).toBe('superseded');
  });

  it('deletes hand-offs a day after they expire', async () => {
    const now = new Date();
    await begin(new Date(now.getTime() - 26 * 3_600_000));
    await begin(new Date(now.getTime() - 3_600_000));
    await sweep(harness.store, now);
    expect(await rows()).toHaveLength(1);
  });

  it('says it is not set up when the table does not exist yet', async () => {
    const missing = new Proxy(harness.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return async () => {
          throw Object.assign(new Error('Could not find the table public.desktop_handoffs'), {
            code: 'PGRST205',
          });
        };
      },
    }) as DataStore;
    const created = await createHandoff(missing, {
      secrets: mintHandoffSecrets(),
      flowId: null,
      platform: 'other',
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe('not_configured');
      expect(created.error.message).toContain('20261017000000_desktop_handoffs.sql');
    }
    const view = await receiveCode(missing, {
      handoffId: mintHandoffSecrets().handoffId,
      code: AUTH_CODE,
      providerError: false,
    });
    expect(view.ok).toBe(false);
  });
});

describe('isSameOrigin', () => {
  const request = (headers: Record<string, string>) =>
    new Request('https://copilot.example/api/auth/desktop/start', { method: 'POST', headers });

  it('accepts this site and refuses others', () => {
    expect(isSameOrigin(request({ origin: 'https://copilot.example' }))).toBe(true);
    expect(
      isSameOrigin(
        request({
          origin: 'https://copilot.example',
          host: 'internal:10000',
          'x-forwarded-host': 'copilot.example, proxy.example',
        }),
      ),
    ).toBe(true);
    expect(isSameOrigin(request({ origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(request({ origin: 'null' }))).toBe(false);
    expect(isSameOrigin(request({}))).toBe(false);
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });
});
