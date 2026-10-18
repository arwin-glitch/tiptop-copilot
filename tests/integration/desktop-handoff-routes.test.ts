import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { POLL_COOKIE, receiveCode } from '@/lib/auth/desktop-handoff';
import { resetEnvCache } from '@/lib/config/env';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { DesktopHandoff } from '@/lib/types/domain';

/**
 * The desktop sign-in routes end to end, with Supabase's auth client faked.
 * The browser's leg (the callback page) is driven through receiveCode, which
 * is all that page does.
 */

let harness: Harness;
const SAVED = { ...process.env };

const fake = vi.hoisted(() => ({
  auth: {
    signInWithOAuth: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    signOut: vi.fn(),
  },
}));
const demoSession = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  supabaseServerClient: async () => fake,
  startDemoSession: demoSession,
}));

const { POST: start } = await import('@/app/api/auth/desktop/start/route');
const { POST: poll } = await import('@/app/api/auth/desktop/poll/route');
const { POST: verify } = await import('@/app/api/auth/desktop/verify/route');

const ORIGIN = 'https://copilot.example';
const AUTH_CODE = 'a1b2c3d4-0000-4000-8000-00000000c0de';

function post(
  path: string,
  options: { cookie?: string; origin?: string; body?: unknown; ip?: string } = {},
) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: options.origin ?? ORIGIN,
      'content-type': 'application/json',
      'x-forwarded-for': options.ip ?? '203.0.113.7',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response) {
  return (await response.json()) as { ok: boolean; value?: Record<string, unknown> };
}

/** Start a sign-in as the app would: the poll cookie, h, and what came back. */
async function begin() {
  const response = await start(post('/api/auth/desktop/start'));
  expect(response.status).toBe(200);
  const body = await json(response);
  const secret = response.cookies.get(POLL_COOKIE)?.value as string;
  const redirectTo = fake.auth.signInWithOAuth.mock.calls.at(-1)?.[0]?.options?.redirectTo as
    string | undefined;
  const url = String(body.value?.url ?? '');
  const handoffId =
    new URL(redirectTo ?? new URL(url, ORIGIN).toString()).searchParams.get('h') ?? '';
  return { response, body, cookie: `${POLL_COOKIE}=${secret}`, handoffId };
}

async function browserSignsIn(handoffId: string): Promise<string> {
  const view = await receiveCode(harness.store, {
    handoffId,
    code: AUTH_CODE,
    providerError: false,
    demo: process.env.DEMO_MODE === 'true',
  });
  if (!view.ok || view.value.kind !== 'show') throw new Error('the browser was shown no code');
  return view.value.matchCode;
}

beforeEach(async () => {
  process.env.DEMO_MODE = 'false';
  process.env.APP_URL = ORIGIN;
  process.env.AUTH_ALLOWED_EMAIL_DOMAINS = 'copilot.example';
  harness = await createHarness();
  fake.auth.signInWithOAuth.mockReset().mockImplementation(async () => ({
    data: {
      provider: 'google',
      url: 'https://abcdefgh.supabase.co/auth/v1/authorize?provider=google',
      flowId: 'flow-0001',
    },
    error: null,
  }));
  fake.auth.exchangeCodeForSession.mockReset().mockImplementation(async () => ({
    data: { user: { id: DEMO_IDS.user, email: 'person@copilot.example' }, session: {} },
    error: null,
  }));
  fake.auth.signOut.mockReset().mockResolvedValue({ error: null });
  demoSession.mockClear();
});

afterEach(async () => {
  await harness.dispose();
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe('POST /api/auth/desktop/start', () => {
  it('answers the sign-in URL only, with an httpOnly cookie scoped to the hand-off routes', async () => {
    const { response, body, handoffId } = await begin();
    expect(body.value?.url).toBe('https://abcdefgh.supabase.co/auth/v1/authorize?provider=google');
    expect(Object.keys(body.value ?? {}).sort()).toEqual(['expiresAt', 'url']);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${POLL_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/auth\/desktop/);
    expect(setCookie).toMatch(/SameSite=strict/i);

    const options = fake.auth.signInWithOAuth.mock.calls[0]?.[0];
    expect(options.provider).toBe('google');
    expect(options.options.skipBrowserRedirect).toBeUndefined();
    expect(options.options.queryParams).toMatchObject({
      prompt: 'select_account',
      hd: 'copilot.example',
    });
    expect(new URL(options.options.redirectTo).pathname).toBe('/desktop/callback');
    expect(handoffId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // No code exists yet, so none can leak from here.
    const [row] = await harness.store.list('desktop_handoffs', '');
    expect(row?.match_code).toBeNull();
    expect(row?.flow_id).toBe('flow-0001');
    expect(row?.platform).toBe('mac');
  });

  it('refuses a request from another site', async () => {
    const response = await start(
      post('/api/auth/desktop/start', { origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
    expect(fake.auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('lets no single address use up the shared ceiling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) {
      statuses.push((await start(post('/api/auth/desktop/start', { ip: '198.51.100.9' }))).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(110);
    // Everyone else can still sign in.
    const other = await start(post('/api/auth/desktop/start', { ip: '192.0.2.44' }));
    expect(other.status).toBe(200);
  });
});

describe('poll and verify', () => {
  it('waits for the browser, then asks for the code', async () => {
    const { cookie, handoffId } = await begin();
    expect((await json(await poll(post('/api/auth/desktop/poll', { cookie })))).value).toEqual({
      status: 'waiting',
    });
    await browserSignsIn(handoffId);
    expect((await json(await poll(post('/api/auth/desktop/poll', { cookie })))).value).toEqual({
      status: 'enter_code',
      attemptsLeft: 3,
    });
  });

  it('signs in once with the right code, exchanging with the flow id exactly once', async () => {
    const { cookie, handoffId } = await begin();
    const code = await browserSignsIn(handoffId);

    const [a, b] = await Promise.all([
      verify(post('/api/auth/desktop/verify', { cookie, body: { code: code.toLowerCase() } })),
      verify(post('/api/auth/desktop/verify', { cookie, body: { code } })),
    ]);
    const answers = [(await json(a)).value, (await json(b)).value];
    expect(answers).toContainEqual({ status: 'signed_in' });
    expect(answers).toContainEqual({ status: 'waiting' });
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith(AUTH_CODE, {
      flowId: 'flow-0001',
    });

    const winner = answers[0]?.status === 'signed_in' ? a : b;
    expect(winner.headers.get('set-cookie')).toMatch(
      new RegExp(`${POLL_COOKIE}=;.*Max-Age=0`, 'i'),
    );
    expect((await json(await poll(post('/api/auth/desktop/poll', { cookie })))).value).toEqual({
      status: 'signed_in',
    });

    const audit = await harness.store.list('audit_events', DEMO_IDS.org, {
      eq: { action: 'auth.desktop_signed_in' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toEqual({ platform: 'mac' });
  });

  it('signs an account outside the allowed domains straight back out', async () => {
    fake.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: { id: DEMO_IDS.user, email: 'person@elsewhere.example' }, session: {} },
      error: null,
    });
    const { cookie, handoffId } = await begin();
    const code = await browserSignsIn(handoffId);
    const answer = await json(
      await verify(post('/api/auth/desktop/verify', { cookie, body: { code } })),
    );
    expect(answer.value).toEqual({ status: 'failed', reason: 'domain' });
    expect(fake.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('reports an exchange Supabase refused, and never tries it twice', async () => {
    fake.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'invalid flow state' },
    });
    const { cookie, handoffId } = await begin();
    const code = await browserSignsIn(handoffId);
    const first = await json(
      await verify(post('/api/auth/desktop/verify', { cookie, body: { code } })),
    );
    expect(first.value).toEqual({ status: 'failed', reason: 'exchange' });
    await verify(post('/api/auth/desktop/verify', { cookie, body: { code } }));
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it('burns the hand-off after three wrong codes', async () => {
    const { cookie, handoffId } = await begin();
    const code = await browserSignsIn(handoffId);
    const wrong = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push(
        (
          await json(
            await verify(post('/api/auth/desktop/verify', { cookie, body: { code: wrong } })),
          )
        ).value,
      );
    }
    expect(answers.at(-1)).toEqual({ status: 'failed', reason: 'wrong_code' });
    const late = await json(
      await verify(post('/api/auth/desktop/verify', { cookie, body: { code } })),
    );
    expect(late.value?.status).toBe('failed');
    expect(fake.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('refuses a malformed code without counting it', async () => {
    const { cookie, handoffId } = await begin();
    await browserSignsIn(handoffId);
    const response = await verify(
      post('/api/auth/desktop/verify', { cookie, body: { code: 'K7' } }),
    );
    expect(response.status).toBe(400);
    const [row] = await harness.store.list('desktop_handoffs', '');
    expect(row?.attempts).toBe(0);
  });

  it('says expired once the hand-off has run out, and clears the cookie', async () => {
    const { cookie } = await begin();
    const [row] = await harness.store.list('desktop_handoffs', '');
    await harness.store.updateWhere(
      'desktop_handoffs',
      '',
      { eq: { id: (row as DesktopHandoff).id } },
      { expires_at: new Date(Date.now() - 1_000).toISOString() },
    );
    const response = await poll(post('/api/auth/desktop/poll', { cookie }));
    expect((await json(response)).value).toEqual({ status: 'expired' });
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('says expired with no poll cookie, and refuses another site', async () => {
    expect((await json(await poll(post('/api/auth/desktop/poll')))).value).toEqual({
      status: 'expired',
    });
    const foreign = await poll(post('/api/auth/desktop/poll', { origin: 'https://evil.example' }));
    expect(foreign.status).toBe(403);
    const verifyForeign = await verify(
      post('/api/auth/desktop/verify', { origin: 'https://evil.example', body: { code: 'K7PQ' } }),
    );
    expect(verifyForeign.status).toBe(403);
  });
});

describe('the demo', () => {
  it('signs in to the demo workspace and never touches Supabase', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const { cookie, body, handoffId } = await begin();
    expect(String(body.value?.url)).toMatch(/^\/desktop\/callback\?h=[A-Za-z0-9_-]{43}&code=demo$/);
    const code = await browserSignsIn(handoffId);
    const answer = await json(
      await verify(post('/api/auth/desktop/verify', { cookie, body: { code } })),
    );
    expect(answer.value).toEqual({ status: 'signed_in' });
    expect(demoSession).toHaveBeenCalledTimes(1);
    expect(fake.auth.signInWithOAuth).not.toHaveBeenCalled();
    expect(fake.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
