import type { DesktopHandoffFailure } from '@/lib/types/domain';

/**
 * The desktop app (desktop/ in this repository) is a window onto this site.
 * What the page and the server need to agree on about it lives here, and is
 * safe to import from a client component.
 *
 * The shell marks its window with a read-only global and a cookie, both
 * holding its version. Both are layout hints only: anyone can set them, so
 * nothing is ever granted because of them.
 */

export const DESKTOP_GLOBAL = '__TIPTOP_DESKTOP__';
export const DESKTOP_COOKIE = 'tiptop_desktop';

export const INSTALLER_PLATFORMS = ['mac', 'windows'] as const;
export type InstallerPlatform = (typeof INSTALLER_PLATFORMS)[number];

/** The stable asset names every desktop release carries (.github/workflows/desktop.yml). */
export const DESKTOP_INSTALLERS: Record<InstallerPlatform, string> = {
  mac: 'TipTop-Copilot-mac.dmg',
  windows: 'TipTop-Copilot-windows-setup.exe',
};

export interface InstallerAsset {
  assetId: number;
  bytes: number | null;
}

/** What lib/desktop/releases.ts found about the newest desktop release. */
export type DesktopRelease =
  | {
      state: 'ready';
      version: string;
      installers: Partial<Record<InstallerPlatform, InstallerAsset>>;
    }
  /** The repository answered, and has no desktop release yet. */
  | { state: 'none' }
  /** No answer from the API; the version if the "latest" redirect gave it away. */
  | { state: 'unknown'; version: string | null };

export function isInstallerPlatform(value: unknown): value is InstallerPlatform {
  return value === 'mac' || value === 'windows';
}

/** A shell version such as `0.1.0`, or null for anything else. */
export function parseDesktopVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{1,4}\.\d{1,5}\.\d{1,6}$/.test(trimmed) ? trimmed : null;
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const right = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The desktop app's version when this page is open inside it; null elsewhere and on the server. */
export function desktopAppVersion(): string | null {
  if (typeof window === 'undefined') return null;
  return parseDesktopVersion((window as unknown as Record<string, unknown>)[DESKTOP_GLOBAL]);
}

/** Characters a sign-in code is made of: no 0/O, 1/I/L, so it reads back unambiguously. */
export const MATCH_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const MATCH_CODE_RE = /^[2-9A-HJKMNP-Z]{4}$/;
/** Wrong codes allowed before a sign-in is stopped. */
export const MAX_CODE_ATTEMPTS = 3;

/** What a person typed, as a code: upper case, without spaces or dashes. */
export function normalizeMatchCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '');
}

/** Where a desktop sign-in stands, as the app's poll sees it. */
export type DesktopFlowStatus =
  | { status: 'waiting' }
  | { status: 'enter_code'; attemptsLeft: number }
  | { status: 'signed_in' }
  | { status: 'expired' }
  | { status: 'failed'; reason: DesktopHandoffFailure };

/** What typing a code answers: a flow state, or a miss with tries left. */
export type DesktopVerifyStatus =
  DesktopFlowStatus | { status: 'wrong_code'; attemptsLeft: number };

/** "12 MB", for an installer's size. */
export function formatInstallerSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}
