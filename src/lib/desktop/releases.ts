import 'server-only';
import { env, isDemoMode } from '@/lib/config/env';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import {
  DESKTOP_INSTALLERS,
  INSTALLER_PLATFORMS,
  type DesktopRelease,
  type InstallerAsset,
  type InstallerPlatform,
} from './shared';

export type { DesktopRelease, InstallerAsset } from './shared';

/**
 * The desktop app's installers, as published by .github/workflows/desktop.yml:
 * a release tagged `desktop-vX.Y.Z` carrying two stable asset names.
 *
 * Pages never link to where they are hosted. /download shows what this finds,
 * and /api/desktop/download/<platform> streams the file through this server,
 * so a person only ever sees Copilot's own address.
 *
 * Finding the newest release uses the releases API, which allows 60
 * anonymous requests an hour per address, and Render shares its outbound
 * addresses between services, so it is often refused. DESKTOP_RELEASE_TOKEN
 * gives the server its own quota. Without an answer the state is `unknown`:
 * both downloads stay offered (they go by the stable "latest" link instead),
 * and the version is read from where the "latest release" page redirects.
 */

const API = 'https://api.github.com';
const SITE = 'https://github.com';
const TAG_RE = /^desktop-v(\d+\.\d+\.\d+)$/;
const READY_TTL_MS = 600_000;
const UNKNOWN_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 4_000;
/** An installer download must start (headers) within this; the body then takes as long as it takes. */
const HEADERS_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseOptions {
  fetchImpl?: FetchLike;
  now?: number;
}

const cache = processWide('desktop-release', () => ({
  value: null as DesktopRelease | null,
  until: 0,
}));

/** Test hook. */
export function resetDesktopReleaseCache(): void {
  cache.value = null;
  cache.until = 0;
}

function headers(accept: string): Record<string, string> {
  const token = env().desktopReleaseToken;
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tiptop-copilot',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface ApiAsset {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  state?: unknown;
}

interface ApiRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

/**
 * The newest published desktop release that carries at least one stable
 * installer, from the API's list (newest first). Drafts, prereleases and
 * other tags are skipped. Exported for tests.
 */
export function pickDesktopRelease(releases: unknown): DesktopRelease {
  if (!Array.isArray(releases)) return { state: 'none' };
  for (const release of releases as ApiRelease[]) {
    if (!release || release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === 'string' ? TAG_RE.exec(release.tag_name) : null;
    if (!tag) continue;
    const assets = Array.isArray(release.assets) ? (release.assets as ApiAsset[]) : [];
    const installers: Partial<Record<InstallerPlatform, InstallerAsset>> = {};
    for (const platform of INSTALLER_PLATFORMS) {
      const asset = assets.find(
        (a) =>
          a?.name === DESKTOP_INSTALLERS[platform] &&
          typeof a.id === 'number' &&
          (a.state === undefined || a.state === 'uploaded'),
      );
      if (asset) {
        installers[platform] = {
          assetId: asset.id as number,
          bytes: typeof asset.size === 'number' && asset.size > 0 ? asset.size : null,
        };
      }
    }
    if (Object.keys(installers).length > 0) {
      return { state: 'ready', version: tag[1] as string, installers };
    }
  }
  return { state: 'none' };
}

/** `desktop-vX.Y.Z` from where the "latest release" page redirects, without API quota. */
async function versionFromRedirect(fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await fetchImpl(`${SITE}/${env().desktopReleaseRepo}/releases/latest`, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'User-Agent': 'tiptop-copilot' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location) return null;
    const tag = new URL(location, SITE).pathname.split('/releases/tag/')[1];
    const match = tag ? TAG_RE.exec(decodeURIComponent(tag)) : null;
    return match ? (match[1] as string) : null;
  } catch {
    return null;
  }
}

async function lookUp(fetchImpl: FetchLike): Promise<DesktopRelease> {
  try {
    const response = await fetchImpl(
      `${API}/repos/${env().desktopReleaseRepo}/releases?per_page=20`,
      {
        headers: headers('application/vnd.github+json'),
        cache: 'no-store',
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (response.ok) return pickDesktopRelease(await response.json());
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Unreachable or timed out: the same as a refusal.
  }
  return { state: 'unknown', version: await versionFromRedirect(fetchImpl) };
}

/**
 * The newest desktop release, cached for 10 minutes (a minute when the answer
 * was `unknown`). The demo never looks: it has no installers to offer.
 */
export async function latestDesktopRelease(options: ReleaseOptions = {}): Promise<DesktopRelease> {
  if (isDemoMode()) return { state: 'unknown', version: null };
  const now = options.now ?? Date.now();
  if (cache.value && cache.until > now) return cache.value;
  const value = await lookUp(options.fetchImpl ?? fetch);
  cache.value = value;
  cache.until = now + (value.state === 'unknown' ? UNKNOWN_TTL_MS : READY_TTL_MS);
  return value;
}

/* ------------------------------------------------------------- download */

export interface InstallerStream {
  body: ReadableStream<Uint8Array>;
  bytes: number | null;
}

/**
 * Fetch with a deadline on the response headers only: a stalled upstream is
 * given up on, while a large body that is flowing is never cut off.
 */
async function fetchWithHeaderDeadline(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), HEADERS_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.any([signal, deadline.signal]) });
  } finally {
    clearTimeout(timer);
  }
}

/** Where the asset API may send us: GitHub's signed download hosts, over HTTPS. */
function isAssetHost(location: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === 'https:' && url.hostname.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function toStream(response: Response, knownBytes: number | null): InstallerStream | null {
  if (!response.ok || !response.body) return null;
  // A length only for a body passed through as sent: fetch decodes any
  // content-encoding, after which the upstream length is wrong.
  const encoding = response.headers.get('content-encoding');
  const declared = Number(response.headers.get('content-length') ?? '');
  const bytes =
    encoding && encoding !== 'identity'
      ? null
      : Number.isFinite(declared) && declared > 0
        ? declared
        : knownBytes;
  return { body: response.body, bytes };
}

/** Through the asset API: a redirect to a signed URL, fetched without our token. */
async function viaApi(
  fetchImpl: FetchLike,
  asset: InstallerAsset,
  signal: AbortSignal,
): Promise<InstallerStream | null> {
  try {
    const response = await fetchWithHeaderDeadline(
      fetchImpl,
      `${API}/repos/${env().desktopReleaseRepo}/releases/assets/${asset.assetId}`,
      { headers: headers('application/octet-stream'), redirect: 'manual', cache: 'no-store' },
      signal,
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location || !isAssetHost(location)) return null;
      const file = await fetchWithHeaderDeadline(
        fetchImpl,
        location,
        { cache: 'no-store', headers: { 'User-Agent': 'tiptop-copilot' } },
        signal,
      );
      const stream = toStream(file, asset.bytes);
      if (!stream) await file.body?.cancel().catch(() => undefined);
      return stream;
    }
    const stream = toStream(response, asset.bytes);
    if (!stream) await response.body?.cancel().catch(() => undefined);
    return stream;
  } catch {
    return null;
  }
}

/**
 * Open the installer for `platform` as a stream to pass straight through.
 * The asset API first when the release is known; otherwise, or when that
 * fails (a stale cached asset id after a re-upload, an exhausted quota), the
 * stable "latest" link. Only a 404 there means there is no such installer.
 */
export async function openInstaller(
  platform: InstallerPlatform,
  signal: AbortSignal,
  options: ReleaseOptions = {},
): Promise<Result<InstallerStream>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const release = await latestDesktopRelease(options);
  const asset = release.state === 'ready' ? release.installers[platform] : undefined;
  if (asset) {
    const stream = await viaApi(fetchImpl, asset, signal);
    if (stream) return ok(stream);
  }

  try {
    const response = await fetchWithHeaderDeadline(
      fetchImpl,
      `${SITE}/${env().desktopReleaseRepo}/releases/latest/download/${DESKTOP_INSTALLERS[platform]}`,
      { redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'tiptop-copilot' } },
      signal,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return err('not_found', 'That installer is not published yet.');
    }
    const stream = toStream(response, asset?.bytes ?? null);
    if (!stream) {
      await response.body?.cancel().catch(() => undefined);
      return err('provider_unavailable', 'The installer could not be fetched just now.');
    }
    return ok(stream);
  } catch {
    return err('provider_unavailable', 'The installer could not be fetched just now.');
  }
}
