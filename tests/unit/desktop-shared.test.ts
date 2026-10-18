import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  desktopFrame,
  formatInstallerSize,
  framelessShell,
  isDesktopFrame,
  isInstallerPlatform,
  MATCH_ALPHABET,
  MATCH_CODE_RE,
  normalizeMatchCode,
  parseDesktopVersion,
  updatesItself,
  whereToCheckForUpdates,
} from '@/lib/desktop/shared';

/**
 * What the page and the desktop shell agree on. The shell's version arrives
 * through a global and a cookie anyone can set, so parsing it is strict.
 */

describe('parseDesktopVersion', () => {
  it('accepts a plain x.y.z version', () => {
    expect(parseDesktopVersion('0.1.0')).toBe('0.1.0');
    expect(parseDesktopVersion(' 12.30.4 ')).toBe('12.30.4');
  });

  it('refuses anything else', () => {
    for (const value of [
      undefined,
      null,
      1,
      '',
      '1',
      '1.2',
      'v1.2.3',
      '1.2.3-beta',
      '1.2.3.4',
      '<script>',
      '99999.1.1',
    ]) {
      expect(parseDesktopVersion(value)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders numerically, part by part', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
  });
});

describe('updatesItself', () => {
  it('is true from 0.2.0, the first version with its own updater', () => {
    expect(updatesItself('0.1.0')).toBe(false);
    expect(updatesItself('0.1.99')).toBe(false);
    expect(updatesItself('0.2.0')).toBe(true);
    expect(updatesItself('0.10.0')).toBe(true);
    expect(updatesItself('1.0.0')).toBe(true);
  });

  it('is false outside the desktop app', () => {
    expect(updatesItself(null)).toBe(false);
  });
});

describe('the frameless window (0.3.0)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is from 0.3.0, the first version whose page draws the title bar', () => {
    expect(framelessShell('0.2.9')).toBe(false);
    expect(framelessShell('0.2.1')).toBe(false);
    expect(framelessShell('0.3.0')).toBe(true);
    expect(framelessShell('0.10.0')).toBe(true);
    expect(framelessShell('1.0.0')).toBe(true);
    expect(framelessShell(null)).toBe(false);
  });

  it('knows the two frames and nothing else', () => {
    expect(isDesktopFrame('windows')).toBe(true);
    expect(isDesktopFrame('mac')).toBe(true);
    for (const value of ['Windows', 'linux', '', null, undefined, 1, {}]) {
      expect(isDesktopFrame(value)).toBe(false);
    }
  });

  it('needs both globals, and a 0.3.0 or newer version, to draw the bar', () => {
    const cases: [unknown, unknown, ReturnType<typeof desktopFrame>][] = [
      ['windows', '0.3.0', 'windows'],
      ['mac', '0.3.0', 'mac'],
      ['windows', '0.4.2', 'windows'],
      ['mac', '1.0.0', 'mac'],
      // An older app never sets the frame global; if one somehow did, still no bar.
      ['windows', '0.2.1', null],
      ['mac', '0.1.0', null],
      // A 0.3.0 second window (attachments, the briefing) has no frame global.
      [undefined, '0.3.0', null],
      ['linux', '0.3.0', null],
      ['windows', undefined, null],
      ['windows', 'v0.3.0', null],
    ];
    for (const [frame, version, expected] of cases) {
      vi.stubGlobal('window', { __TIPTOP_DESKTOP_FRAME__: frame, __TIPTOP_DESKTOP__: version });
      expect(desktopFrame(), `${String(frame)} ${String(version)}`).toBe(expected);
    }
  });

  it('is null on the server', () => {
    expect(desktopFrame()).toBeNull();
  });

  it('says where Check for Updates… is for each version', () => {
    expect(whereToCheckForUpdates(null)).toBe(
      'in the File menu on Windows or the TipTop Copilot menu on a Mac',
    );
    expect(whereToCheckForUpdates('0.2.1')).toBe(
      'in the File menu on Windows or the TipTop Copilot menu on a Mac',
    );
    expect(whereToCheckForUpdates('0.3.0')).toBe(
      'in the menu at the top left on Windows (under File) or the TipTop Copilot menu on a Mac',
    );
  });
});

describe('sign-in codes', () => {
  it('uses an alphabet without look-alike characters', () => {
    expect(MATCH_ALPHABET).toHaveLength(31);
    for (const ch of '01ILO') expect(MATCH_ALPHABET).not.toContain(ch);
    for (const ch of MATCH_ALPHABET) expect(MATCH_CODE_RE.test(ch.repeat(4))).toBe(true);
  });

  it('reads what a person typed as a code', () => {
    expect(normalizeMatchCode(' k7pq ')).toBe('K7PQ');
    expect(normalizeMatchCode('k7-pq')).toBe('K7PQ');
    expect(normalizeMatchCode('K 7 P Q')).toBe('K7PQ');
    expect(MATCH_CODE_RE.test(normalizeMatchCode('k7o0'))).toBe(false);
  });
});

describe('installers', () => {
  it('knows the two platforms and nothing else', () => {
    expect(isInstallerPlatform('mac')).toBe(true);
    expect(isInstallerPlatform('windows')).toBe(true);
    expect(isInstallerPlatform('linux')).toBe(false);
    expect(isInstallerPlatform(undefined)).toBe(false);
  });

  it('formats a size the way the download page shows it', () => {
    expect(formatInstallerSize(12 * 1_048_576 + 300_000)).toBe('12 MB');
    expect(formatInstallerSize(500_000)).toBe('488 KB');
    expect(formatInstallerSize(0)).toBe('');
  });
});
