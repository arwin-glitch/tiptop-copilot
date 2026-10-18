import 'server-only';
import { compareVersions, parseDesktopVersion, type InstallerPlatform } from './shared';

/**
 * The desktop app's own updater (desktop/src-tauri/src/updates.rs) asks
 * /api/desktop/update/<os>/<arch>/<version> whether a newer version exists.
 * The answer comes from the latest.json each release carries, and the file
 * itself from /api/desktop/update-file/<platform>/<version>, which streams it
 * from that release. The app checks every file's signature against the key
 * built into it before installing, so nothing here is relied on for safety:
 * a wrong answer can only fail to update.
 */

/** Always our own domain: the same host as the endpoint built into the app. */
export const UPDATE_FILE_BASE = 'https://copilot.tiptop.vc/api/desktop/update-file';

/** {{target}}-{{arch}} as the updater sends them, and the file for each. The Mac app is universal. */
export const UPDATE_TARGETS = {
  'darwin-aarch64': 'mac',
  'darwin-x86_64': 'mac',
  'windows-x86_64': 'windows',
} as const satisfies Record<string, InstallerPlatform>;
export type UpdateTarget = keyof typeof UPDATE_TARGETS;

const OSES = new Set(['darwin', 'windows']);
const ARCHES = new Set(['aarch64', 'x86_64']);

/** target null: well formed, but no build exists for it (Windows on Arm). */
export type UpdateQuery =
  { ok: true; target: UpdateTarget | null; current: string } | { ok: false };

export function parseUpdateQuery(os: string, arch: string, current: string): UpdateQuery {
  const version = parseDesktopVersion(current);
  if (!OSES.has(os) || !ARCHES.has(arch) || !version) return { ok: false };
  const key = `${os}-${arch}`;
  return {
    ok: true,
    target: key in UPDATE_TARGETS ? (key as UpdateTarget) : null,
    current: version,
  };
}

export interface UpdateManifest {
  version: string;
  pubDate: string | null;
  signatures: Partial<Record<UpdateTarget, string>>;
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const BASE64 = /^[A-Za-z0-9+/]{100,4000}={0,2}$/;
const TRUSTED = 'trusted comment: ';

/** A minisign signature made for `version`: its shape only, since the app does the cryptography. */
function signedFor(signature: unknown, version: string): signature is string {
  if (typeof signature !== 'string' || !BASE64.test(signature)) return false;
  const lines = Buffer.from(signature, 'base64').toString('utf8').split('\n');
  return (
    lines[0]?.startsWith('untrusted comment:') === true &&
    lines[2]?.startsWith(TRUSTED) === true &&
    lines[2].slice(TRUSTED.length).split('\t').includes(`version:${version}`)
  );
}

/**
 * latest.json, checked: its version must be the release's own (when known)
 * and each platform's signature must be made for that version. Platforms that
 * fail are dropped; null when none is left. The file's URLs and notes are
 * ignored, so an answer only ever carries what was checked here.
 */
export function parseUpdateManifest(
  raw: unknown,
  tagVersion: string | null,
): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  const version = parseDesktopVersion(
    typeof file.version === 'string' ? file.version.replace(/^v/, '') : null,
  );
  if (!version || (tagVersion !== null && version !== tagVersion)) return null;
  const platforms =
    file.platforms && typeof file.platforms === 'object'
      ? (file.platforms as Record<string, { signature?: unknown } | null | undefined>)
      : {};
  const signatures: Partial<Record<UpdateTarget, string>> = {};
  for (const target of Object.keys(UPDATE_TARGETS) as UpdateTarget[]) {
    const signature = platforms[target]?.signature;
    if (signedFor(signature, version)) signatures[target] = signature;
  }
  if (Object.keys(signatures).length === 0) return null;
  return {
    version,
    pubDate:
      typeof file.pub_date === 'string' && RFC3339_UTC.test(file.pub_date) ? file.pub_date : null,
    signatures,
  };
}

/** tauri-plugin-updater's answer for one platform (its "dynamic" format). */
export interface UpdateAnswer {
  version: string;
  pub_date?: string;
  url: string;
  signature: string;
}

/**
 * What to tell an app on `current`; null means nothing newer (204). The file's
 * URL names the version, so the download is refused rather than mixed up if a
 * new release lands between the check and the download.
 */
export function updateAnswer(
  manifest: UpdateManifest,
  target: UpdateTarget,
  current: string,
): UpdateAnswer | null {
  if (compareVersions(manifest.version, current) <= 0) return null;
  const signature = manifest.signatures[target];
  if (!signature) return null;
  return {
    version: manifest.version,
    ...(manifest.pubDate ? { pub_date: manifest.pubDate } : {}),
    url: `${UPDATE_FILE_BASE}/${UPDATE_TARGETS[target]}/${manifest.version}`,
    signature,
  };
}

/** Whether the manifest offers anything for `platform` (either Mac slice counts for the Mac). */
export function offersPlatform(manifest: UpdateManifest, platform: InstallerPlatform): boolean {
  return (Object.keys(manifest.signatures) as UpdateTarget[]).some(
    (target) => UPDATE_TARGETS[target] === platform,
  );
}
