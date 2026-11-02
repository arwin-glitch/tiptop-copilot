import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Mac app is signed with Developer ID and notarised when the secrets are
 * there, and still builds ad-hoc signed without them. The identity carries
 * the Account Holder's legal name, which public workflow logs must never show.
 */
const workflow = readFileSync(join(process.cwd(), '.github/workflows/desktop.yml'), 'utf8');

/** One step's text, from its `- name:` line to the next step. */
function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  expect(start, `step "${name}"`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('desktop Mac signing', () => {
  const signing = step('Developer ID signing');

  it('runs on the Mac build only and reads the Developer ID and App Store Connect keys', () => {
    expect(signing).toContain("if: matrix.platform == 'mac'");
    expect(signing).toContain('MAC_DEVID_P12: ${{ secrets.MAC_DEVID_P12 }}');
    expect(signing).toContain('MAC_DEVID_P12_PASSWORD: ${{ secrets.MAC_DEVID_P12_PASSWORD }}');
    expect(signing).toContain('ASC_KEY_P8: ${{ secrets.ASC_KEY_P8 }}');
    expect(signing).toContain('ASC_KEY_ID: ${{ vars.ASC_KEY_ID }}');
    expect(signing).toContain('ASC_ISSUER_ID: ${{ vars.ASC_ISSUER_ID }}');
  });

  it('falls back to the ad-hoc build, without failing, when a secret is missing', () => {
    const notice = signing.indexOf('::notice::Mac app ad-hoc signed and not notarised');
    expect(notice).toBeGreaterThan(-1);
    expect(signing.slice(notice, notice + 200)).toMatch(/\n\s*exit 0\n/);
    // The config keeps "-" (ad-hoc); only the step's environment overrides it.
    const conf = JSON.parse(
      readFileSync(join(process.cwd(), 'desktop/src-tauri/tauri.conf.json'), 'utf8'),
    ) as { bundle: { macOS: { signingIdentity: string } } };
    expect(conf.bundle.macOS.signingIdentity).toBe('-');
  });

  it('masks the identity, the legal name and the team ID before anything uses them', () => {
    const masks = ['$APPLE_TEAM_ID', '$identity', '$name', '$team'].map((v) =>
      signing.indexOf(`echo "::add-mask::${v}"`),
    );
    for (const at of masks) expect(at).toBeGreaterThan(-1);
    const handedOn = signing.indexOf('APPLE_SIGNING_IDENTITY=$identity');
    expect(handedOn).toBeGreaterThan(Math.max(...masks));
    // find-identity's output goes straight into sed, never to the log.
    expect(signing).toMatch(/find-identity -v -p codesigning "\$keychain" \\\n\s*\| sed -n/);
    // The only lines naming $identity: the mask, the name and team
    // derivations, and the hand-over to the next steps.
    const naming = signing
      .split('\n')
      .filter((line) => line.includes('$identity') || line.includes('${identity'));
    for (const line of naming) {
      expect(line.trim()).toMatch(
        /^(if \[ -z "\$identity" \]; then|echo "::add-mask::\$identity"|name=\$\{identity#|team=\$\{identity##|echo "APPLE_SIGNING_IDENTITY=\$identity")/,
      );
    }
  });

  it('hands Tauri v2 the identity and the notarisation key through its own variables', () => {
    for (const name of [
      'APPLE_SIGNING_IDENTITY',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      'APPLE_API_KEY_PATH',
    ]) {
      expect(signing).toContain(`echo "${name}=`);
    }
    expect(signing).toContain('>> "$GITHUB_ENV"');
  });

  it('checks the notarised result and cleans the keychain up', () => {
    const check = step('Check the Developer ID signature, notarise the disk image');
    expect(check).toContain("env.APPLE_SIGNING_IDENTITY != ''");
    expect(check).toContain('xcrun stapler validate "$app"');
    expect(check).toContain('xcrun notarytool submit');
    expect(check).toContain('xcrun stapler staple');
    const cleanup = step('Remove the signing keychain');
    expect(cleanup).toContain('if: always()');
    expect(cleanup).toContain('security delete-keychain');
  });

  it('keeps the update signing and the published file names as they were', () => {
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ runner.temp }}/throwaway.key');
    expect(workflow).toContain('cp "${dmg[0]}" out/TipTop-Copilot-mac.dmg');
    expect(workflow).toContain('cp "$tarball" out/TipTop-Copilot-mac.app.tar.gz');
    // The signing step comes before the build, so Tauri sees its variables.
    expect(workflow.indexOf('- name: Developer ID signing')).toBeLessThan(
      workflow.indexOf('- name: Build\n'),
    );
  });
});
