import { describe, expect, it } from 'vitest';
import {
  offersPlatform,
  parseUpdateManifest,
  parseUpdateQuery,
  UPDATE_FILE_BASE,
  updateAnswer,
} from '@/lib/desktop/updates';
import { fakeManifest, fakeSignature } from '../helpers/desktop-updates';

/**
 * What the desktop app's updater is told (lib/desktop/updates.ts). The
 * signatures are invented and checked for shape only: the app itself does
 * the cryptography, against the key built into it.
 */

describe('parseUpdateQuery', () => {
  it('accepts the platforms there are builds for', () => {
    expect(parseUpdateQuery('darwin', 'aarch64', '0.2.0')).toEqual({
      ok: true,
      target: 'darwin-aarch64',
      current: '0.2.0',
    });
    expect(parseUpdateQuery('darwin', 'x86_64', '0.2.0')).toMatchObject({
      target: 'darwin-x86_64',
    });
    expect(parseUpdateQuery('windows', 'x86_64', '0.10.3')).toMatchObject({
      target: 'windows-x86_64',
    });
  });

  it('knows Windows on Arm, which has no build, so it is told nothing is newer', () => {
    expect(parseUpdateQuery('windows', 'aarch64', '0.2.0')).toEqual({
      ok: true,
      target: null,
      current: '0.2.0',
    });
  });

  it('refuses anything else', () => {
    for (const [os, arch, version] of [
      ['linux', 'x86_64', '0.2.0'],
      ['darwin', 'i686', '0.2.0'],
      ['Darwin', 'aarch64', '0.2.0'],
      ['darwin', 'aarch64', '0.2'],
      ['darwin', 'aarch64', '1.0.0-beta'],
      ['darwin', 'aarch64', 'v0.2.0'],
      ['darwin', 'aarch64', '<script>'],
    ] as const) {
      expect(parseUpdateQuery(os, arch, version)).toEqual({ ok: false });
    }
  });
});

describe('parseUpdateManifest', () => {
  it('keeps the version, the date and each signature, and nothing from its URLs or notes', () => {
    const manifest = parseUpdateManifest(fakeManifest('0.2.1'), '0.2.1');
    expect(manifest).toEqual({
      version: '0.2.1',
      pubDate: '2026-11-02T10:00:00Z',
      signatures: {
        'darwin-aarch64': fakeSignature('0.2.1'),
        'darwin-x86_64': fakeSignature('0.2.1'),
        'windows-x86_64': fakeSignature('0.2.1', 'TipTop-Copilot-windows-setup.exe'),
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/files\.example|notes/);
  });

  it('accepts a leading v, and any version when the tag is not known', () => {
    expect(
      parseUpdateManifest(fakeManifest('0.2.1', { version: 'v0.2.1' }), '0.2.1')?.version,
    ).toBe('0.2.1');
    expect(parseUpdateManifest(fakeManifest('0.2.1'), null)?.version).toBe('0.2.1');
  });

  it('rejects a file whose version is not the release tag', () => {
    expect(parseUpdateManifest(fakeManifest('0.2.2'), '0.2.1')).toBeNull();
  });

  it('drops a platform whose signature is malformed or made for another version', () => {
    const file = fakeManifest('0.2.1');
    file.platforms['darwin-x86_64'] = { signature: 'not base64 at all!', url: '' };
    file.platforms['windows-x86_64'] = { signature: fakeSignature('0.2.0'), url: '' };
    expect(Object.keys(parseUpdateManifest(file, '0.2.1')?.signatures ?? {})).toEqual([
      'darwin-aarch64',
    ]);
  });

  it('ignores platforms it does not know, and gives up when none is usable', () => {
    const file = fakeManifest('0.2.1', {
      platforms: { 'linux-x86_64': { signature: fakeSignature('0.2.1') } },
    });
    expect(parseUpdateManifest(file, '0.2.1')).toBeNull();
    for (const raw of [null, 'text', [], {}, { version: '0.2.1' }, { version: 3 }]) {
      expect(parseUpdateManifest(raw, null)).toBeNull();
    }
  });

  it('leaves out a date that is not RFC 3339', () => {
    for (const date of ['2 November 2026', '2026-11-02', '2026-11-02T10:00:00+01:00', 7]) {
      expect(parseUpdateManifest(fakeManifest('0.2.1', { pub_date: date }), null)?.pubDate).toBe(
        null,
      );
    }
  });
});

describe('updateAnswer', () => {
  const manifest = parseUpdateManifest(fakeManifest('0.2.1'), '0.2.1')!;

  it('offers a newer version, downloaded from this domain with the version in the URL', () => {
    expect(updateAnswer(manifest, 'darwin-aarch64', '0.2.0')).toEqual({
      version: '0.2.1',
      pub_date: '2026-11-02T10:00:00Z',
      url: 'https://copilot.tiptop.vc/api/desktop/update-file/mac/0.2.1',
      signature: fakeSignature('0.2.1'),
    });
    expect(updateAnswer(manifest, 'darwin-x86_64', '0.1.0')?.url).toBe(
      `${UPDATE_FILE_BASE}/mac/0.2.1`,
    );
    expect(updateAnswer(manifest, 'windows-x86_64', '0.2.0')?.url).toBe(
      `${UPDATE_FILE_BASE}/windows/0.2.1`,
    );
  });

  it('offers nothing to the same or a newer version, or to a platform with no signature', () => {
    expect(updateAnswer(manifest, 'darwin-aarch64', '0.2.1')).toBeNull();
    expect(updateAnswer(manifest, 'darwin-aarch64', '0.10.0')).toBeNull();
    const macOnly = { ...manifest, signatures: { 'darwin-aarch64': fakeSignature('0.2.1') } };
    expect(updateAnswer(macOnly, 'windows-x86_64', '0.2.0')).toBeNull();
  });

  it('omits the date when there is none', () => {
    expect(
      updateAnswer({ ...manifest, pubDate: null }, 'darwin-aarch64', '0.2.0'),
    ).not.toHaveProperty('pub_date');
  });
});

describe('offersPlatform', () => {
  it('counts either Mac slice for the Mac', () => {
    const intelOnly = {
      version: '0.2.1',
      pubDate: null,
      signatures: { 'darwin-x86_64': fakeSignature('0.2.1') },
    };
    expect(offersPlatform(intelOnly, 'mac')).toBe(true);
    expect(offersPlatform(intelOnly, 'windows')).toBe(false);
  });
});
