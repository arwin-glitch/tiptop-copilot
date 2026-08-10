import { afterEach, describe, expect, it } from 'vitest';
import { capabilityReport, resetEnvCache } from '@/lib/config/env';

/**
 * Two misconfigurations that cost a live debugging session, both of which the
 * app had no opinion about:
 *
 *   1. NEXT_PUBLIC_SUPABASE_URL set to the RESTful endpoint rather than the
 *      project origin. The dashboard shows both. The result is a request to
 *      `https://<ref>.supabase.co/rest/v1/auth/v1/authorize`, which answers
 *      {"message":"No API key found in request"} — a message about a missing
 *      header, for a problem that is a wrong path.
 *
 *   2. APP_URL left at its localhost default on a hosted deployment. Every
 *      OAuth redirect is built from it, so sign-in sends the user to their own
 *      machine and the failure looks like the identity provider's.
 *
 * Neither is a code defect and neither can be fixed in code. What can be fixed
 * is that both were invisible: /diagnostics reported "ready" for the first and
 * had nothing to say about the second.
 */

const SAVED = { ...process.env };

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

function check(key: string) {
  return capabilityReport().find((c) => c.key === key);
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

const LIVE = {
  DEMO_MODE: 'false',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_example',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_example',
};

describe('NEXT_PUBLIC_SUPABASE_URL', () => {
  it('is ready when it is the bare project origin', () => {
    setEnv({ ...LIVE, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' });
    expect(check('supabase')?.status).toBe('ready');
  });

  it('tolerates a trailing slash', () => {
    setEnv({ ...LIVE, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co/' });
    expect(check('supabase')?.status).toBe('ready');
  });

  it('rejects the RESTful endpoint and names the path it found', () => {
    setEnv({ ...LIVE, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co/rest/v1' });
    const c = check('supabase');
    expect(c?.status).toBe('missing');
    expect(c?.detail).toContain('/rest/v1');
    expect(c?.detail).toMatch(/no path/i);
  });

  it('rejects any other path', () => {
    setEnv({ ...LIVE, NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co/auth/v1' });
    expect(check('supabase')?.status).toBe('missing');
  });

  it('reports a malformed URL as such', () => {
    setEnv({ ...LIVE, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' });
    expect(check('supabase')?.detail).toMatch(/not a valid url/i);
  });
});

describe('APP_URL', () => {
  it('is ready when it is a public origin', () => {
    setEnv({ ...LIVE, APP_URL: 'https://tiptop-copilot.onrender.com' });
    expect(check('app_url')?.status).toBe('ready');
  });

  it('flags the localhost default on a live deployment', () => {
    setEnv({ ...LIVE, APP_URL: undefined });
    const c = check('app_url');
    expect(c?.status).toBe('missing');
    expect(c?.detail).toMatch(/own machine/i);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost'])(
    'flags %s',
    (url) => {
      setEnv({ ...LIVE, APP_URL: url });
      expect(check('app_url')?.status).toBe('missing');
    },
  );

  it('does not flag a host that merely contains the word', () => {
    // `localhost-staging.example.com` is a real origin, not the default.
    setEnv({ ...LIVE, APP_URL: 'https://localhost-staging.example.com' });
    expect(check('app_url')?.status).toBe('ready');
  });

  it('says nothing in demo mode, where there is no OAuth redirect to build', () => {
    setEnv({ DEMO_MODE: 'true', APP_URL: undefined });
    expect(check('app_url')?.status).toBe('demo');
  });
});
