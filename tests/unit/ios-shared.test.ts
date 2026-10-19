import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_BOOT_SCRIPT } from '@/lib/desktop/frame-boot';
import { compareVersions } from '@/lib/desktop/shared';
import {
  FIRST_IOS_DOWNLOADS_VERSION,
  iosAppVersion,
  iosAppVersionFromUserAgent,
  iosBuiltDayFromUserAgent,
  iosDownloadsShell,
  iosPushShell,
  iosSignInReturnUrl,
  isApnsToken,
  isIosDeviceKey,
  isIphoneUserAgent,
  parseIosSignInReturn,
} from '@/lib/ios/shared';
import { subscriptionPlatform } from '@/lib/services/push-alerts';

/**
 * What the page and the server agree on about the iPhone app: its user
 * agent token, the pre-paint flag that follows it, the sign-in return link
 * and the shapes of its push token and id. All of it must stay off for
 * Safari and the home-screen web app.
 */

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const IN_APP =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TipTopCopilotiOS/1.0.0';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

describe('the user agent token', () => {
  it('reads the version only as a whole TipTopCopilotiOS/x.y.z word', () => {
    expect(iosAppVersionFromUserAgent(IN_APP)).toBe('1.0.0');
    expect(iosAppVersionFromUserAgent(`${IN_APP} TipTopBuilt/2026-10-19`)).toBe('1.0.0');
    expect(iosAppVersionFromUserAgent('TipTopCopilotiOS/12.3.45')).toBe('12.3.45');
    for (const ua of [
      IPHONE_SAFARI,
      MAC_SAFARI,
      '',
      null,
      undefined,
      `${IPHONE_SAFARI} TipTopCopilotiOS/1.0`,
      `${IPHONE_SAFARI} TipTopCopilotiOS/1.0.0-beta`,
      `${IPHONE_SAFARI} XTipTopCopilotiOS/1.0.0`,
      `${IPHONE_SAFARI} TipTopCopilotiOS/v1.0.0`,
    ]) {
      expect(iosAppVersionFromUserAgent(ua), String(ua)).toBeNull();
    }
  });

  it('reads an optional build day, and only a real date', () => {
    expect(iosBuiltDayFromUserAgent(`${IN_APP} TipTopBuilt/2026-10-19`)).toBe('2026-10-19');
    expect(iosBuiltDayFromUserAgent(IN_APP)).toBeNull();
    expect(iosBuiltDayFromUserAgent(`${IN_APP} TipTopBuilt/2026-02-30`)).toBeNull();
    expect(iosBuiltDayFromUserAgent(`${IN_APP} TipTopBuilt/20261019`)).toBeNull();
  });

  it('tells an iPhone apart, including Safari and the home-screen app', () => {
    expect(isIphoneUserAgent(IN_APP)).toBe(true);
    expect(isIphoneUserAgent(IPHONE_SAFARI)).toBe(true);
    expect(isIphoneUserAgent(MAC_SAFARI)).toBe(false);
    expect(isIphoneUserAgent(null)).toBe(false);
  });

  it('is null on the server and in a browser', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_SAFARI });
    expect(iosAppVersion()).toBeNull();
    vi.stubGlobal('navigator', { userAgent: IN_APP });
    expect(iosAppVersion()).toBe('1.0.0');
    vi.unstubAllGlobals();
  });

  it('gates push from 1.0.0, and downloads on a version named later', () => {
    expect(iosPushShell('1.0.0')).toBe(true);
    expect(iosPushShell('0.9.9')).toBe(false);
    expect(iosPushShell(null)).toBe(false);
    expect(iosDownloadsShell('1.0.0')).toBe(
      FIRST_IOS_DOWNLOADS_VERSION !== null &&
        compareVersions('1.0.0', FIRST_IOS_DOWNLOADS_VERSION) >= 0,
    );
    expect(iosDownloadsShell(null)).toBe(false);
  });

  it('records a web subscription as an iPhone only from an iPhone', () => {
    expect(subscriptionPlatform(IPHONE_SAFARI)).toBe('ios');
    expect(subscriptionPlatform(MAC_SAFARI)).toBe('mac');
    expect(subscriptionPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other');
    expect(subscriptionPlatform(null)).toBe('other');
  });
});

/** Runs the pre-paint script against a fake document and the given user agent. */
function boot(userAgent: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      style: { setProperty: () => {} },
    },
  };
  const window = { navigator: userAgent === undefined ? undefined : { userAgent } };
  const storage = { getItem: () => null };
  new Function('window', 'document', 'localStorage', FRAME_BOOT_SCRIPT)(window, document, storage);
  return attrs;
}

describe('the pre-paint flag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks <html> exactly when iosAppVersion() sees the app', () => {
    const agents = [
      IN_APP,
      `${IN_APP} TipTopBuilt/2026-10-19`,
      'TipTopCopilotiOS/2.10.300',
      'TipTopCopilotiOS/0.9.9',
      'TipTopCopilotiOS/0.10.0',
      'TipTopCopilotiOS/1.0.1',
      IPHONE_SAFARI,
      MAC_SAFARI,
      `${IPHONE_SAFARI} TipTopCopilotiOS/1.0`,
      `${IPHONE_SAFARI} TipTopCopilotiOS/1.0.0x`,
      `${IPHONE_SAFARI}TipTopCopilotiOS/1.0.0`,
      '',
    ];
    for (const ua of agents) {
      vi.stubGlobal('navigator', { userAgent: ua });
      const expected = iosAppVersion() !== null;
      const attrs = boot(ua);
      expect('data-ios-app' in attrs, ua).toBe(expected);
      // An app that cannot save a download hides the controls for one.
      expect('data-ios-no-downloads' in attrs, ua).toBe(
        expected && !iosDownloadsShell(iosAppVersion()),
      );
      expect('data-desktop-frame' in attrs).toBe(false);
    }
    expect(boot(undefined)).toEqual({});
  });
});

describe('the sign-in return link', () => {
  it('round-trips a code through the app scheme', () => {
    const url = iosSignInReturnUrl('AB2C');
    expect(url).toBe('vc.tiptop.copilot://signin?code=AB2C');
    expect(parseIosSignInReturn(url)).toBe('AB2C');
  });

  it('takes nothing but a well-formed code on its own scheme', () => {
    for (const url of [
      'vc.tiptop.copilot://signin?code=AB1C',
      'vc.tiptop.copilot://signin?code=ab2c',
      'vc.tiptop.copilot://signin?code=AB2CD',
      'vc.tiptop.copilot://other?code=AB2C',
      'https://copilot.tiptop.vc/signin?code=AB2C',
      'evil://signin?code=AB2C',
      'vc.tiptop.copilot://signin',
      'not a url',
      42,
      null,
      `vc.tiptop.copilot://signin?code=AB2C&x=${'y'.repeat(300)}`,
    ]) {
      expect(parseIosSignInReturn(url), String(url)).toBeNull();
    }
  });
});

describe('push token shapes', () => {
  it('takes hex tokens of 64 characters and longer, never assuming 64', () => {
    expect(isApnsToken('a'.repeat(64))).toBe(true);
    expect(isApnsToken('AB'.repeat(50))).toBe(true);
    expect(isApnsToken('a'.repeat(200))).toBe(true);
    expect(isApnsToken('a'.repeat(63))).toBe(false);
    expect(isApnsToken('a'.repeat(201))).toBe(false);
    expect(isApnsToken(`${'a'.repeat(63)}g`)).toBe(false);
    expect(isApnsToken(null)).toBe(false);
    expect(isIosDeviceKey('0'.repeat(40))).toBe(true);
    expect(isIosDeviceKey('0'.repeat(39))).toBe(false);
    expect(isIosDeviceKey('A'.repeat(40))).toBe(false);
  });
});
