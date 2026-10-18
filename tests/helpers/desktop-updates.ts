/**
 * Invented desktop update fixtures. A "signature" here has the shape of a
 * minisign signature file (what the server checks) and nothing more: it is
 * not a real signature by any key.
 */

export const UPDATE_ASSETS = [
  'TipTop-Copilot-mac.dmg',
  'TipTop-Copilot-windows-setup.exe',
  'TipTop-Copilot-mac.app.tar.gz',
  'TipTop-Copilot-mac.app.tar.gz.sig',
  'TipTop-Copilot-windows-setup.exe.sig',
  'latest.json',
];

/** Base64 of a fake signature file whose trusted comment names `version`. */
export function fakeSignature(version: string, file = 'TipTop-Copilot-mac.app.tar.gz'): string {
  return Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      `RUQ${'A'.repeat(140)}`,
      `trusted comment: timestamp:1767225600\tfile:${file}\tversion:${version}`,
      'B'.repeat(88),
    ].join('\n'),
  ).toString('base64');
}

/** latest.json as the release workflow writes it, with invented URLs the server must ignore. */
export function fakeManifest(version: string, extra: Record<string, unknown> = {}) {
  const mac = { signature: fakeSignature(version), url: 'https://files.example/mac' };
  return {
    version,
    notes: `TipTop Copilot ${version}`,
    pub_date: '2026-11-02T10:00:00Z',
    platforms: {
      'darwin-aarch64': mac,
      'darwin-x86_64': mac,
      'windows-x86_64': {
        signature: fakeSignature(version, 'TipTop-Copilot-windows-setup.exe'),
        url: 'https://files.example/windows',
      },
    },
    ...extra,
  };
}
