import 'server-only';
import { env, isDemoMode } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import {
  DESKTOP_INSTALLERS,
  DESKTOP_UPDATE_FILES,
  DESKTOP_UPDATE_MANIFEST,
  INSTALLER_PLATFORMS,
  type DesktopRelease,
  type InstallerAsset,
  type InstallerPlatform,
} from './shared';
import {
  offersPlatform,
  parseUpdateManifest,
  UPDATE_TARGETS,
  type UpdateManifest,
  type UpdateTarget,
} from './updates';

export type { DesktopRelease, InstallerAsset } from './shared';

/**
 * The desktop app's installers, as published by .github/workflows/desktop.yml:
 * a release tagged `desktop-vX.Y.Z` carrying two stable asset names. From
 * 0.2.0 each release also carries the app's own update files and latest.json,
 * which names the version and each file's signature (lib/desktop/updates.ts).
 *
 * Pages never link to where they are hosted. /download shows what this finds,
 * and /api/desktop/download/<platform> streams the file through this server,
 * so a person only ever sees Kraken's own address. The app's updater is
 * served the same way, by /api/desktop/update and /api/desktop/update-file.
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
/** latest.json is a few hundred bytes; anything past this is not one. */
const MANIFEST_MAX_BYTES = 65_536;
const MANIFEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseOptions {
  fetchImpl?: FetchLike;
  now?: number;
}

const cache = processWide('desktop-release', () => ({
  value: null as DesktopRelease | null,
  until: 0,
}));

/** latest.json as read from `release`, which must be the release lookup's current answer. */
const manifestCache = processWide('desktop-update-manifest', () => ({
  release: null as DesktopRelease | null,
  value: null as UpdateLookup | null,
  until: 0,
}));

/** Test hook. */
export function resetDesktopReleaseCache(): void {
  cache.value = null;
  cache.until = 0;
  manifestCache.release = null;
  manifestCache.value = null;
  manifestCache.until = 0;
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
    // A finished upload with this exact name; one still uploading is not there yet.
    const find = (name: string): InstallerAsset | undefined => {
      const asset = assets.find(
        (a) =>
          a?.name === name &&
          typeof a.id === 'number' &&
          (a.state === undefined || a.state === 'uploaded'),
      );
      if (!asset) return undefined;
      return {
        assetId: asset.id as number,
        bytes: typeof asset.size === 'number' && asset.size > 0 ? asset.size : null,
      };
    };
    const installers: Partial<Record<InstallerPlatform, InstallerAsset>> = {};
    const updateFiles: Partial<Record<InstallerPlatform, InstallerAsset>> = {};
    for (const platform of INSTALLER_PLATFORMS) {
      const installer = find(DESKTOP_INSTALLERS[platform]);
      if (installer) installers[platform] = installer;
      const update = find(DESKTOP_UPDATE_FILES[platform]);
      if (update) updateFiles[platform] = update;
    }
    if (Object.keys(installers).length > 0) {
      return {
        state: 'ready',
        version: tag[1] as string,
        installers,
        updateFiles,
        updateManifest: find(DESKTOP_UPDATE_MANIFEST) ?? null,
      };
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
 * Open the release file `name` as a stream to pass straight through. The
 * asset API first when the release is known; otherwise, or when that fails (a
 * stale cached asset id after a re-upload, an exhausted quota), the stable
 * "latest" link. Only a 404 there means there is no such file. The messages
 * are our own and never name where the file came from.
 */
async function openReleaseAsset(
  fetchImpl: FetchLike,
  name: string,
  asset: InstallerAsset | undefined,
  signal: AbortSignal,
  what: 'installer' | 'update',
): Promise<Result<InstallerStream>> {
  if (asset) {
    const stream = await viaApi(fetchImpl, asset, signal);
    if (stream) return ok(stream);
  }

  try {
    const response = await fetchWithHeaderDeadline(
      fetchImpl,
      `${SITE}/${env().desktopReleaseRepo}/releases/latest/download/${name}`,
      { redirect: 'follow', cache: 'no-store', headers: { 'User-Agent': 'tiptop-copilot' } },
      signal,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return err('not_found', `That ${what} is not published yet.`);
    }
    const stream = toStream(response, asset?.bytes ?? null);
    if (!stream) {
      await response.body?.cancel().catch(() => undefined);
      return err('provider_unavailable', `The ${what} could not be fetched just now.`);
    }
    return ok(stream);
  } catch {
    return err('provider_unavailable', `The ${what} could not be fetched just now.`);
  }
}

/** Open the installer for `platform` (see openReleaseAsset). */
export async function openInstaller(
  platform: InstallerPlatform,
  signal: AbortSignal,
  options: ReleaseOptions = {},
): Promise<Result<InstallerStream>> {
  const release = await latestDesktopRelease(options);
  const asset = release.state === 'ready' ? release.installers[platform] : undefined;
  return openReleaseAsset(
    options.fetchImpl ?? fetch,
    DESKTOP_INSTALLERS[platform],
    asset,
    signal,
    'installer',
  );
}

/* -------------------------------------------------------------- updates */

/**
 * The newest release's update manifest. `none`: there is nothing to update to
 * (no release, a release from before the app updated itself, or a manifest
 * that failed its checks). `unknown`: it could not be read just now, which an
 * update check must not report as "up to date".
 */
export type UpdateLookup =
  { state: 'ready'; manifest: UpdateManifest } | { state: 'none' } | { state: 'unknown' };

/** The body as text, or null past `max` bytes, in which case the rest is never read. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readManifest(fetchImpl: FetchLike, release: DesktopRelease): Promise<UpdateLookup> {
  if (release.state === 'none') return { state: 'none' };
  // Releases from before the app updated itself carry no manifest: no fetch.
  if (release.state === 'ready' && !release.updateManifest) return { state: 'none' };
  const opened = await openReleaseAsset(
    fetchImpl,
    DESKTOP_UPDATE_MANIFEST,
    release.state === 'ready' ? (release.updateManifest ?? undefined) : undefined,
    AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    'update',
  );
  if (!opened.ok) {
    return opened.error.code === 'not_found' ? { state: 'none' } : { state: 'unknown' };
  }

  let text: string | null;
  try {
    text = await readCapped(opened.value.body, MANIFEST_MAX_BYTES);
  } catch {
    // The body broke off or timed out: unread, not wrong.
    return { state: 'unknown' };
  }
  let raw: unknown = null;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    // Not JSON: rejected below, like any other malformed file.
  }
  const manifest = parseUpdateManifest(raw, release.version);
  if (manifest && release.state === 'ready') {
    // Never offer a file the release does not hold.
    for (const target of Object.keys(manifest.signatures) as UpdateTarget[]) {
      if (!release.updateFiles[UPDATE_TARGETS[target]]) delete manifest.signatures[target];
    }
  }
  if (!manifest || Object.keys(manifest.signatures).length === 0) {
    log.warn('Desktop update manifest rejected', { release: release.version });
    return { state: 'none' };
  }
  return { state: 'ready', manifest };
}

/**
 * The newest release and its manifest, read together: the manifest is cached
 * only for as long as the release lookup gives the same answer, so the two
 * never describe different releases. 10 minutes; a minute when unknown.
 */
async function currentUpdate(
  options: ReleaseOptions,
): Promise<{ release: DesktopRelease; lookup: UpdateLookup }> {
  const release = await latestDesktopRelease(options);
  const now = options.now ?? Date.now();
  if (manifestCache.value && manifestCache.release === release && manifestCache.until > now) {
    return { release, lookup: manifestCache.value };
  }
  const lookup = await readManifest(options.fetchImpl ?? fetch, release);
  manifestCache.release = release;
  manifestCache.value = lookup;
  manifestCache.until = now + (lookup.state === 'unknown' ? UNKNOWN_TTL_MS : READY_TTL_MS);
  return { release, lookup };
}

/** What the update check answers from. The demo never looks: it has no releases. */
export async function latestUpdateManifest(options: ReleaseOptions = {}): Promise<UpdateLookup> {
  if (isDemoMode()) return { state: 'none' };
  return (await currentUpdate(options)).lookup;
}

/** An update file the check offers right now, found by findUpdateFile. */
export interface OfferedUpdateFile {
  platform: InstallerPlatform;
  asset: InstallerAsset | undefined;
}

/**
 * The update file for `platform` at `version`, which must be the version the
 * update check offers right now. Anything else is not found: an app that
 * checked just before a new release landed is refused, and checks again,
 * rather than given a file its signature does not match. It answers from the
 * cached manifest, so a version not on offer never reaches the release host.
 */
export async function findUpdateFile(
  platform: InstallerPlatform,
  version: string,
  options: ReleaseOptions = {},
): Promise<Result<OfferedUpdateFile>> {
  const gone = err('not_found', 'That update is not available.');
  if (isDemoMode()) return gone;
  const { release, lookup } = await currentUpdate(options);
  if (lookup.state === 'unknown') {
    return err('provider_unavailable', 'The update could not be fetched just now.');
  }
  if (
    lookup.state === 'none' ||
    lookup.manifest.version !== version ||
    !offersPlatform(lookup.manifest, platform)
  ) {
    return gone;
  }
  return ok({
    platform,
    asset: release.state === 'ready' ? release.updateFiles[platform] : undefined,
  });
}

/** Open an update file findUpdateFile found (see openReleaseAsset). */
export async function openUpdateFile(
  file: OfferedUpdateFile,
  signal: AbortSignal,
  options: ReleaseOptions = {},
): Promise<Result<InstallerStream>> {
  return openReleaseAsset(
    options.fetchImpl ?? fetch,
    DESKTOP_UPDATE_FILES[file.platform],
    file.asset,
    signal,
    'update',
  );
}
