import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  latestDesktopRelease,
  openInstaller,
  pickDesktopRelease,
  resetDesktopReleaseCache,
} from '@/lib/desktop/releases';

/**
 * Finding and streaming the desktop installers (lib/desktop/releases.ts),
 * with the network injected. The repository and every response are invented.
 */

const SAVED = { ...process.env };

function release(tag: string, extra: Record<string, unknown> = {}, names = STABLE) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: names.map((name, i) => ({
      id: 100 + i,
      name,
      size: 12_000_000 + i,
      state: 'uploaded',
    })),
    ...extra,
  };
}
const STABLE = ['TipTop-Copilot-mac.dmg', 'TipTop-Copilot-windows-setup.exe'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

beforeEach(() => {
  process.env.DEMO_MODE = 'false';
  process.env.DESKTOP_RELEASE_REPO = 'example-owner/example-app';
  delete process.env.DESKTOP_RELEASE_TOKEN;
  resetEnvCache();
  resetDesktopReleaseCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetDesktopReleaseCache();
});

describe('pickDesktopRelease', () => {
  it('takes the newest published desktop release that carries an installer', () => {
    const picked = pickDesktopRelease([
      release('desktop-v0.4.0', { draft: true }),
      release('desktop-v0.3.0', { prerelease: true }),
      release('v9.9.9'),
      release('desktop-v0.2.5', {}, ['notes.txt']),
      release('desktop-v0.2.0'),
      release('desktop-v0.1.0'),
    ]);
    expect(picked).toEqual({
      state: 'ready',
      version: '0.2.0',
      installers: {
        mac: { assetId: 100, bytes: 12_000_000 },
        windows: { assetId: 101, bytes: 12_000_001 },
      },
    });
  });

  it('says there is none when nothing qualifies', () => {
    expect(pickDesktopRelease([])).toEqual({ state: 'none' });
    expect(pickDesktopRelease({ message: 'Not Found' })).toEqual({ state: 'none' });
  });

  it('offers what a half-published release has', () => {
    const picked = pickDesktopRelease([release('desktop-v0.1.0', {}, ['TipTop-Copilot-mac.dmg'])]);
    expect(picked.state === 'ready' && Object.keys(picked.installers)).toEqual(['mac']);
  });
});

describe('latestDesktopRelease', () => {
  it('asks the releases API, anonymously unless a token is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([release('desktop-v0.1.0')]));
    const found = await latestDesktopRelease({ fetchImpl });
    expect(found.state).toBe('ready');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/example-owner/example-app/releases?per_page=20');
    expect(headerOf(init, 'Authorization')).toBeUndefined();

    process.env.DESKTOP_RELEASE_TOKEN = 'example-token-not-real';
    resetEnvCache();
    resetDesktopReleaseCache();
    await latestDesktopRelease({ fetchImpl });
    const [, withToken] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(headerOf(withToken, 'Authorization')).toBe('Bearer example-token-not-real');
  });

  it('falls back to the "latest" redirect for the version when the API refuses', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith('https://api.github.com')
        ? jsonResponse({ message: 'API rate limit exceeded' }, 403)
        : new Response(null, {
            status: 302,
            headers: {
              location: 'https://github.com/example-owner/example-app/releases/tag/desktop-v0.3.1',
            },
          }),
    );
    expect(await latestDesktopRelease({ fetchImpl })).toEqual({
      state: 'unknown',
      version: '0.3.1',
    });
    const [probeUrl, probeInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(probeUrl).toBe('https://github.com/example-owner/example-app/releases/latest');
    expect(probeInit.redirect).toBe('manual');
  });

  it('caches an answer for 10 minutes, an unknown one for a minute', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const now = 5_000_000;
    await latestDesktopRelease({ fetchImpl, now });
    await latestDesktopRelease({ fetchImpl, now: now + 9 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await latestDesktopRelease({ fetchImpl, now: now + 11 * 60_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resetDesktopReleaseCache();
    const refusing = vi.fn(async () => {
      throw new Error('offline');
    });
    await latestDesktopRelease({ fetchImpl: refusing, now });
    const calls = refusing.mock.calls.length;
    await latestDesktopRelease({ fetchImpl: refusing, now: now + 30_000 });
    expect(refusing.mock.calls.length).toBe(calls);
    await latestDesktopRelease({ fetchImpl: refusing, now: now + 61_000 });
    expect(refusing.mock.calls.length).toBeGreaterThan(calls);
  });

  it('never looks in the demo', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const fetchImpl = vi.fn();
    expect(await latestDesktopRelease({ fetchImpl })).toEqual({ state: 'unknown', version: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('openInstaller', () => {
  const signal = new AbortController().signal;

  it('follows the asset API to the signed URL, which is fetched without the token', async () => {
    process.env.DESKTOP_RELEASE_TOKEN = 'example-token-not-real';
    resetEnvCache();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/releases?per_page=20')) return jsonResponse([release('desktop-v0.1.0')]);
      if (url.includes('/releases/assets/100')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/signed/abc' },
        });
      }
      return new Response('installer bytes', { status: 200 });
    });
    const opened = await openInstaller('mac', signal, { fetchImpl });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await new Response(opened.value.body).text()).toBe('installer bytes');
    expect(opened.value.bytes).toBe(12_000_000);

    const [, apiInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(headerOf(apiInit, 'Authorization')).toBe('Bearer example-token-not-real');
    expect(apiInit.redirect).toBe('manual');
    const [assetUrl, assetInit] = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect(assetUrl).toBe('https://release-assets.githubusercontent.com/signed/abc');
    expect(headerOf(assetInit, 'Authorization')).toBeUndefined();
  });

  it('uses the stable "latest" link when the asset API sends it somewhere unexpected', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/releases?per_page=20')) return jsonResponse([release('desktop-v0.1.0')]);
      if (url.includes('/releases/assets/')) {
        return new Response(null, { status: 302, headers: { location: 'http://evil.example/x' } });
      }
      return new Response('from latest', { status: 200, headers: { 'content-length': '11' } });
    });
    const opened = await openInstaller('windows', signal, { fetchImpl });
    expect(opened.ok && opened.value.bytes).toBe(11);
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain('http://evil.example/x');
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe(
      'https://github.com/example-owner/example-app/releases/latest/download/TipTop-Copilot-windows-setup.exe',
    );
  });

  it('goes by the stable link when the release is unknown, and 404 there means not found', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.github.com')) return jsonResponse({}, 403);
      if (url.endsWith('/releases/latest')) return new Response(null, { status: 404 });
      return new Response('Not Found', { status: 404 });
    });
    const opened = await openInstaller('mac', signal, { fetchImpl });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('not_found');
  });

  it('reports an upstream failure as unavailable, not missing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith('https://api.github.com')
        ? jsonResponse([])
        : new Response('bad gateway', { status: 502 }),
    );
    const opened = await openInstaller('mac', signal, { fetchImpl });
    expect(!opened.ok && opened.error.code).toBe('provider_unavailable');
  });
});
