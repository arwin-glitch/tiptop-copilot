import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as check } from '@/app/api/desktop/update/[target]/[arch]/[current]/route';
import { GET as updateFile } from '@/app/api/desktop/update-file/[platform]/[version]/route';
import { resetEnvCache } from '@/lib/config/env';
import { resetDesktopReleaseCache } from '@/lib/desktop/releases';
import { resetLimiters } from '@/lib/security/limits';
import { proxy } from '@/proxy';
import { fakeManifest, fakeSignature, UPDATE_ASSETS } from '../helpers/desktop-updates';

/**
 * The desktop app's update routes end to end, with the release host faked
 * through a stubbed fetch. They are public, so every request here is made
 * without a session or any cookie, as the app's updater makes them. The
 * repository, the files and the signatures are invented.
 */

const SAVED = { ...process.env };
const ORIGIN = 'https://copilot.example';
const LIST_URL = 'https://api.github.com/repos/example-owner/example-app/releases?per_page=20';
/** Bytes that any re-encoding on the way would change. */
const MAC_BYTES = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256);

type Host = {
  releases?: unknown[];
  list?: () => Response;
  manifest?: () => Response;
  macFile?: () => Response;
};

/** An invented release host: the list, the asset API's redirects and the signed files. */
function stubHost(host: Host = {}) {
  const releases = host.releases ?? [releaseWith('0.2.1', UPDATE_ASSETS)];
  const files: Record<string, () => Response> = {
    'latest.json': host.manifest ?? (() => Response.json(fakeManifest('0.2.1'))),
    'TipTop-Copilot-mac.app.tar.gz':
      host.macFile ??
      (() =>
        new Response(MAC_BYTES, {
          headers: { 'content-length': String(MAC_BYTES.byteLength) },
        })),
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === LIST_URL) return host.list ? host.list() : Response.json(releases);
    if (url.endsWith('/releases/latest')) return new Response(null, { status: 404 });
    const assetId = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
    if (assetId) {
      const name = UPDATE_ASSETS[Number(assetId) - 100] ?? 'missing';
      return new Response(null, {
        status: 302,
        headers: { location: `https://release-assets.githubusercontent.com/signed/${name}` },
      });
    }
    const name = url.split('/').at(-1) ?? '';
    const file = files[name];
    return file ? file() : new Response('Not Found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function releaseWith(version: string, names: string[]) {
  return {
    tag_name: `desktop-v${version}`,
    draft: false,
    prerelease: false,
    assets: names.map((name, i) => ({ id: 100 + i, name, size: 1000 + i, state: 'uploaded' })),
  };
}

function get(path: string, ip: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    headers: { 'x-forwarded-for': ip, 'user-agent': 'tauri-plugin-updater/2.14.0' },
  });
}

function askForUpdate(target: string, arch: string, current: string, ip = '203.0.113.7') {
  return check(get(`/api/desktop/update/${target}/${arch}/${current}`, ip), {
    params: Promise.resolve({ target, arch, current }),
  });
}

function download(platform: string, version: string, ip = '203.0.113.7') {
  return updateFile(get(`/api/desktop/update-file/${platform}/${version}`, ip), {
    params: Promise.resolve({ platform, version }),
  });
}

/** Everything a caller can see of a response, to search for the release host's name. */
async function visible(response: Response): Promise<string> {
  const headers = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('octet-stream') ? '' : await response.clone().text();
  return `${headers}\n${body}`;
}

beforeEach(() => {
  process.env.DEMO_MODE = 'false';
  process.env.DESKTOP_RELEASE_REPO = 'example-owner/example-app';
  delete process.env.DESKTOP_RELEASE_TOKEN;
  resetEnvCache();
  resetDesktopReleaseCache();
  resetLimiters();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetDesktopReleaseCache();
  resetLimiters();
});

describe('GET /api/desktop/update/<os>/<arch>/<version>', () => {
  it('offers a newer version in the updater’s format, downloaded from this domain', async () => {
    stubHost();
    const response = await askForUpdate('darwin', 'aarch64', '0.2.0');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      version: '0.2.1',
      pub_date: '2026-11-02T10:00:00Z',
      url: 'https://copilot.tiptop.vc/api/desktop/update-file/mac/0.2.1',
      signature: fakeSignature('0.2.1'),
    });

    const windows = await askForUpdate('windows', 'x86_64', '0.1.0');
    expect(((await windows.json()) as { url: string }).url).toBe(
      'https://copilot.tiptop.vc/api/desktop/update-file/windows/0.2.1',
    );
  });

  it('answers 204 when nothing is newer, there is no build, or no manifest', async () => {
    stubHost();
    for (const [os, arch, current] of [
      ['darwin', 'x86_64', '0.2.1'],
      ['darwin', 'aarch64', '0.3.0'],
      ['windows', 'aarch64', '0.2.0'],
    ]) {
      const response = await askForUpdate(os!, arch!, current!);
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    }

    resetDesktopReleaseCache();
    const fetchImpl = stubHost({
      releases: [
        releaseWith('0.1.0', ['TipTop-Copilot-mac.dmg', 'TipTop-Copilot-windows-setup.exe']),
      ],
    });
    expect((await askForUpdate('darwin', 'aarch64', '0.1.0')).status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers 204 in the demo without looking anywhere', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const fetchImpl = stubHost();
    expect((await askForUpdate('darwin', 'aarch64', '0.2.0')).status).toBe(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a platform or version it does not know with 400', async () => {
    const fetchImpl = stubHost();
    for (const [os, arch, current] of [
      ['linux', 'x86_64', '0.2.0'],
      ['darwin', 'aarch64', 'latest'],
      ['windows', 'x86_64', '0.2.0-beta'],
    ]) {
      const response = await askForUpdate(os!, arch!, current!);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 503, never "up to date", when the manifest cannot be read', async () => {
    stubHost({ manifest: () => new Response('upstream detail', { status: 502 }) });
    const response = await askForUpdate('darwin', 'aarch64', '0.2.0');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
    expect(body).not.toContain('upstream detail');
  });

  it('allows 30 checks an hour from one address', async () => {
    stubHost();
    for (let i = 0; i < 30; i++) {
      expect((await askForUpdate('darwin', 'aarch64', '0.2.1')).status).toBe(204);
    }
    const limited = await askForUpdate('darwin', 'aarch64', '0.2.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Someone else is not held up.
    expect((await askForUpdate('darwin', 'aarch64', '0.2.1', '198.51.100.20')).status).toBe(204);
  });
});

describe('GET /api/desktop/update-file/<platform>/<version>', () => {
  it('streams the offered file byte for byte, with its length and name', async () => {
    stubHost();
    const response = await download('mac', '0.2.1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(MAC_BYTES.byteLength));
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="TipTop-Copilot-mac.app.tar.gz"',
    );
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MAC_BYTES);
  });

  it('refuses any version but the one on offer, and unknown platforms, with 404', async () => {
    const fetchImpl = stubHost();
    for (const [platform, version] of [
      ['mac', '0.2.0'],
      ['mac', '0.2.2'],
      ['linux', '0.2.1'],
      ['mac', 'latest'],
    ]) {
      const response = await download(platform!, version!);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
    }
    expect(fetchImpl.mock.calls.map(([url]) => String(url)).join()).not.toContain('tar.gz');
  });

  it('answers 503 with its own words when the file cannot be fetched', async () => {
    stubHost({ macFile: () => new Response('upstream detail', { status: 502 }) });
    const response = await download('mac', '0.2.1');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      ok: false,
      error: {
        code: 'provider_unavailable',
        message: 'The update could not be fetched just now.',
      },
    });
  });

  it('serves nothing in the demo', async () => {
    process.env.DEMO_MODE = 'true';
    resetEnvCache();
    const fetchImpl = stubHost();
    expect((await download('mac', '0.2.1')).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows 10 requests an hour from one address and 30 streamed files from everyone', async () => {
    stubHost();
    const streamed = async (ip: string) => {
      const response = await download('mac', '0.2.1', ip);
      await response.body?.cancel();
      return response.status;
    };
    for (let i = 0; i < 10; i++) expect((await download('mac', '0.2.0')).status).toBe(404);
    const limited = await download('mac', '0.2.0');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });

    // Versions not on offer spend only their callers' own limits.
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      for (let i = 0; i < 10; i++) expect((await download('mac', '9.9.9', ip)).status).toBe(404);
    }
    for (const ip of ['198.51.100.4', '198.51.100.5', '198.51.100.6']) {
      for (let i = 0; i < 10; i++) expect(await streamed(ip)).toBe(200);
    }
    // 30 files streamed: the ceiling now holds everyone, whatever they ask for.
    expect(await streamed('198.51.100.7')).toBe(429);
    expect((await download('mac', '9.9.9', '198.51.100.8')).status).toBe(429);
  });
});

describe('both routes', () => {
  it('never name the release host in a body, a header or an error', async () => {
    stubHost();
    const responses = [
      await askForUpdate('darwin', 'aarch64', '0.2.0'),
      await askForUpdate('darwin', 'aarch64', '0.2.1'),
      await askForUpdate('linux', 'x86_64', '0.2.0'),
      await download('mac', '0.2.1'),
      await download('mac', '0.1.0'),
    ];
    resetDesktopReleaseCache();
    stubHost({
      manifest: () => new Response('see https://github.com/example-owner', { status: 502 }),
      macFile: () => new Response('see https://github.com/example-owner', { status: 502 }),
    });
    responses.push(await askForUpdate('darwin', 'aarch64', '0.2.0'));
    responses.push(await download('mac', '0.2.1'));
    for (const response of responses) {
      expect(response.headers.get('location')).toBeNull();
      expect(await visible(response)).not.toMatch(/github/i);
    }
  });

  it('are public in the proxy, one by one, while the installer download stays signed in', async () => {
    const status = async (path: string) =>
      (await proxy(new NextRequest(`${ORIGIN}${path}`))).status;
    expect(await status('/api/desktop/update/darwin/aarch64/0.2.0')).toBe(200);
    expect(await status('/api/desktop/update-file/mac/0.2.1')).toBe(200);
    expect(await status('/api/desktop/download/mac')).toBe(401);
    expect(await status('/api/desktop/updates')).toBe(401);
    expect(await status('/api/desktop/update-files/mac/0.2.1')).toBe(401);
  });
});
