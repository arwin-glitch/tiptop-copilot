import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import {
  findUpdateFile,
  latestDesktopRelease,
  latestUpdateManifest,
  openInstaller,
  openUpdateFile,
  pickDesktopRelease,
  resetDesktopReleaseCache,
  type ReleaseOptions,
} from '@/lib/desktop/releases';
import type { InstallerPlatform } from '@/lib/desktop/shared';
import { fakeManifest, UPDATE_ASSETS } from '../helpers/desktop-updates';

/**
 * Finding and streaming the desktop installers and the app's update files
 * (lib/desktop/releases.ts), with the network injected. The repository and
 * every response are invented.
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
const STABLE = ['TipTop-Kraken-mac.dmg', 'TipTop-Kraken-windows-setup.exe'];

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
      // Windows updates with its installer; without latest.json nothing is offered.
      updateFiles: { windows: { assetId: 101, bytes: 12_000_001 } },
      updateManifest: null,
    });
  });

  it('captures the update files and latest.json of a self-updating release', () => {
    const picked = pickDesktopRelease([release('desktop-v0.2.1', {}, UPDATE_ASSETS)]);
    expect(picked).toEqual({
      state: 'ready',
      version: '0.2.1',
      installers: {
        mac: { assetId: 100, bytes: 12_000_000 },
        windows: { assetId: 101, bytes: 12_000_001 },
      },
      updateFiles: {
        mac: { assetId: 102, bytes: 12_000_002 },
        windows: { assetId: 101, bytes: 12_000_001 },
      },
      updateManifest: { assetId: 105, bytes: 12_000_005 },
    });
  });

  it('skips an update file that is still uploading', () => {
    const picked = pickDesktopRelease([
      {
        ...release('desktop-v0.2.1', {}, UPDATE_ASSETS),
        assets: UPDATE_ASSETS.map((name, i) => ({
          id: 100 + i,
          name,
          size: 1000,
          state: name === 'latest.json' ? 'starter' : 'uploaded',
        })),
      },
    ]);
    expect(picked.state === 'ready' && picked.updateManifest).toBeNull();
  });

  it('says there is none when nothing qualifies', () => {
    expect(pickDesktopRelease([])).toEqual({ state: 'none' });
    expect(pickDesktopRelease({ message: 'Not Found' })).toEqual({ state: 'none' });
  });

  it('offers what a half-published release has', () => {
    const picked = pickDesktopRelease([release('desktop-v0.1.0', {}, ['TipTop-Kraken-mac.dmg'])]);
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
      'https://github.com/example-owner/example-app/releases/latest/download/TipTop-Kraken-windows-setup.exe',
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

/* -------------------------------------------------------------- updates */

const LIST_URL = 'https://api.github.com/repos/example-owner/example-app/releases?per_page=20';
const STABLE_LINK = 'https://github.com/example-owner/example-app/releases/latest/download/';
const SIGNED_HOST = 'https://release-assets.githubusercontent.com/signed/';

/**
 * An invented release host: the list, the asset API (a redirect to a signed
 * URL per asset), the signed URLs and the stable "latest" links.
 */
function releaseHost(
  options: {
    releases?: unknown[];
    files?: Record<string, () => Response>;
    list?: () => Response;
  } = {},
) {
  const releases = options.releases ?? [release('desktop-v0.2.1', {}, UPDATE_ASSETS)];
  const files: Record<string, () => Response> = {
    'latest.json': () => jsonResponse(fakeManifest('0.2.1')),
    'TipTop-Kraken-mac.app.tar.gz': () =>
      new Response('mac update bytes', { headers: { 'content-length': '16' } }),
    'TipTop-Kraken-windows-setup.exe': () => new Response('windows update bytes'),
    ...options.files,
  };
  return vi.fn(async (url: string) => {
    if (url === LIST_URL) return options.list ? options.list() : jsonResponse(releases);
    if (url.endsWith('/releases/latest')) return new Response(null, { status: 404 });
    const assetId = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
    if (assetId) {
      const name = UPDATE_ASSETS[Number(assetId) - 100] ?? 'missing';
      return new Response(null, { status: 302, headers: { location: `${SIGNED_HOST}${name}` } });
    }
    const name = url.startsWith(SIGNED_HOST)
      ? url.slice(SIGNED_HOST.length)
      : url.startsWith(STABLE_LINK)
        ? url.slice(STABLE_LINK.length)
        : null;
    const file = name ? files[name] : undefined;
    return file ? file() : new Response('Not Found', { status: 404 });
  });
}

function calledUrls(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map(([url]) => String(url));
}

describe('latestUpdateManifest', () => {
  it('reads latest.json through the asset API, never sending the token to the signed URL', async () => {
    process.env.DESKTOP_RELEASE_TOKEN = 'example-token-not-real';
    resetEnvCache();
    const fetchImpl = releaseHost();
    const found = await latestUpdateManifest({ fetchImpl });
    expect(found.state).toBe('ready');
    if (found.state !== 'ready') return;
    expect(found.manifest.version).toBe('0.2.1');
    expect(found.manifest.pubDate).toBe('2026-11-02T10:00:00Z');
    expect(Object.keys(found.manifest.signatures).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'windows-x86_64',
    ]);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const api = calls.find(([url]) => url.endsWith('/releases/assets/105'));
    expect(headerOf(api?.[1], 'Authorization')).toBe('Bearer example-token-not-real');
    const signed = calls.find(([url]) => url === `${SIGNED_HOST}latest.json`);
    expect(signed).toBeDefined();
    expect(headerOf(signed?.[1], 'Authorization')).toBeUndefined();
  });

  it('goes by the stable link when the release lookup is refused', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === LIST_URL) return jsonResponse({}, 403);
      if (url.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://github.com/example-owner/example-app/releases/tag/desktop-v0.2.1',
          },
        });
      }
      if (url === `${STABLE_LINK}latest.json`) return jsonResponse(fakeManifest('0.2.1'));
      return new Response('Not Found', { status: 404 });
    });
    const found = await latestUpdateManifest({ fetchImpl });
    expect(found.state === 'ready' && found.manifest.version).toBe('0.2.1');
    expect(calledUrls(fetchImpl)).toContain(`${STABLE_LINK}latest.json`);
  });

  it('says none for a release from before the app updated itself, without fetching', async () => {
    const fetchImpl = releaseHost({ releases: [release('desktop-v0.1.0')] });
    expect(await latestUpdateManifest({ fetchImpl })).toEqual({ state: 'none' });
    expect(calledUrls(fetchImpl)).toEqual([LIST_URL]);
  });

  it('says none when the file is missing, unknown (for a minute) when the host fails', async () => {
    const missing = vi.fn(async (url: string) =>
      url === LIST_URL ? jsonResponse({}, 403) : new Response('Not Found', { status: 404 }),
    );
    expect(await latestUpdateManifest({ fetchImpl: missing })).toEqual({ state: 'none' });

    resetDesktopReleaseCache();
    const now = 7_000_000;
    const failing = vi.fn(async (url: string) =>
      url === LIST_URL
        ? jsonResponse([release('desktop-v0.2.1', {}, UPDATE_ASSETS)])
        : new Response('bad gateway', { status: 502 }),
    );
    expect(await latestUpdateManifest({ fetchImpl: failing, now })).toEqual({ state: 'unknown' });
    const calls = failing.mock.calls.length;
    await latestUpdateManifest({ fetchImpl: failing, now: now + 30_000 });
    expect(failing.mock.calls.length).toBe(calls);
    await latestUpdateManifest({ fetchImpl: failing, now: now + 61_000 });
    expect(failing.mock.calls.length).toBeGreaterThan(calls);
  });

  it('caches a manifest for as long as the release lookup gives the same answer', async () => {
    const fetchImpl = releaseHost();
    const now = 9_000_000;
    await latestUpdateManifest({ fetchImpl, now });
    const calls = fetchImpl.mock.calls.length;
    await latestUpdateManifest({ fetchImpl, now: now + 9 * 60_000 });
    expect(fetchImpl.mock.calls.length).toBe(calls);
    await latestUpdateManifest({ fetchImpl, now: now + 11 * 60_000 });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
  });

  it('rejects a file over 64 KB, a version that is not the tag, and anything not JSON', async () => {
    const padding = 'x'.repeat(70_000);
    const cases: Array<() => Response> = [
      () => new Response(JSON.stringify({ ...fakeManifest('0.2.1'), padding })),
      () => jsonResponse(fakeManifest('0.2.2')),
      () => new Response('<html>not json</html>'),
    ];
    for (const file of cases) {
      resetDesktopReleaseCache();
      const fetchImpl = releaseHost({ files: { 'latest.json': file } });
      expect(await latestUpdateManifest({ fetchImpl })).toEqual({ state: 'none' });
    }
  });

  it('never offers a platform whose file the release does not hold', async () => {
    const fetchImpl = releaseHost({
      releases: [
        {
          ...release('desktop-v0.2.1'),
          assets: UPDATE_ASSETS.map((name, i) => ({ id: 100 + i, name, size: 1000 })).filter(
            (asset) => asset.name !== 'TipTop-Kraken-mac.app.tar.gz',
          ),
        },
      ],
    });
    const found = await latestUpdateManifest({ fetchImpl });
    expect(found.state === 'ready' && Object.keys(found.manifest.signatures)).toEqual([
      'windows-x86_64',
    ]);
  });

  it('never looks in the demo', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const fetchImpl = vi.fn();
    expect(await latestUpdateManifest({ fetchImpl })).toEqual({ state: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('findUpdateFile and openUpdateFile', () => {
  const signal = new AbortController().signal;

  /** As the update-file route does it: find the offered file, then open it. */
  async function openOffered(
    platform: InstallerPlatform,
    version: string,
    options: ReleaseOptions,
  ) {
    const found = await findUpdateFile(platform, version, options);
    return found.ok ? openUpdateFile(found.value, signal, options) : found;
  }

  it('streams the offered version from the release, without the token on the signed URL', async () => {
    process.env.DESKTOP_RELEASE_TOKEN = 'example-token-not-real';
    resetEnvCache();
    const fetchImpl = releaseHost();
    const opened = await openOffered('mac', '0.2.1', { fetchImpl });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await new Response(opened.value.body).text()).toBe('mac update bytes');
    expect(opened.value.bytes).toBe(16);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.some(([url]) => url.endsWith('/releases/assets/102'))).toBe(true);
    const signed = calls.find(([url]) => url === `${SIGNED_HOST}TipTop-Kraken-mac.app.tar.gz`);
    expect(signed).toBeDefined();
    expect(headerOf(signed?.[1], 'Authorization')).toBeUndefined();

    const windows = await openOffered('windows', '0.2.1', { fetchImpl });
    expect(windows.ok && (await new Response(windows.value.body).text())).toBe(
      'windows update bytes',
    );
  });

  it('refuses any version but the one on offer, without fetching a file', async () => {
    const fetchImpl = releaseHost();
    for (const version of ['0.2.0', '0.2.2']) {
      const opened = await openOffered('mac', version, { fetchImpl });
      expect(!opened.ok && opened.error.code).toBe('not_found');
    }
    expect(calledUrls(fetchImpl).some((url) => url.includes('tar.gz'))).toBe(false);
  });

  it('refuses a platform the manifest does not cover', async () => {
    const { 'windows-x86_64': _windows, ...macOnly } = fakeManifest('0.2.1').platforms;
    const fetchImpl = releaseHost({
      files: { 'latest.json': () => jsonResponse(fakeManifest('0.2.1', { platforms: macOnly })) },
    });
    const opened = await openOffered('windows', '0.2.1', { fetchImpl });
    expect(!opened.ok && opened.error.code).toBe('not_found');
  });

  it('is unavailable, not missing, when the manifest or the file cannot be fetched', async () => {
    const down = vi.fn(async (url: string) =>
      url === LIST_URL
        ? jsonResponse([release('desktop-v0.2.1', {}, UPDATE_ASSETS)])
        : new Response('bad gateway', { status: 502 }),
    );
    const unread = await openOffered('mac', '0.2.1', { fetchImpl: down });
    expect(!unread.ok && unread.error.code).toBe('provider_unavailable');

    resetDesktopReleaseCache();
    const fileDown = releaseHost({
      files: { 'TipTop-Kraken-mac.app.tar.gz': () => new Response('', { status: 502 }) },
    });
    const opened = await openOffered('mac', '0.2.1', { fetchImpl: fileDown });
    expect(!opened.ok && opened.error.code).toBe('provider_unavailable');
    if (!opened.ok) expect(opened.error.message).toBe('The update could not be fetched just now.');
  });

  it('serves nothing in the demo', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const fetchImpl = vi.fn();
    const opened = await openOffered('mac', '0.2.1', { fetchImpl });
    expect(!opened.ok && opened.error.code).toBe('not_found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
