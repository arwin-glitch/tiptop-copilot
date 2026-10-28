import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 0.5.0 renames the desktop app from TipTop Copilot to TipTop Kraken. The
 * Windows installer removes the old copy through an NSIS hook, and the app's
 * data, sign-in and alerts token must survive that: they live under the
 * identifier, which never changes.
 */
const SRC_TAURI = join(process.cwd(), 'desktop/src-tauri');
const conf = JSON.parse(readFileSync(join(SRC_TAURI, 'tauri.conf.json'), 'utf8')) as {
  productName: string;
  version: string;
  identifier: string;
  bundle: { shortDescription: string; windows: { nsis: { installerHooks?: string } } };
  plugins: { updater: { endpoints: string[]; pubkey: string } };
};
const hooksPath = conf.bundle.windows.nsis.installerHooks ?? '';
const hooks = existsSync(join(SRC_TAURI, hooksPath))
  ? readFileSync(join(SRC_TAURI, hooksPath), 'utf8')
  : '';
/** The hook file without its comments: what NSIS actually runs. */
const code = hooks
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith(';'))
  .join('\n');
const workflow = readFileSync(join(process.cwd(), '.github/workflows/desktop.yml'), 'utf8');

describe('desktop app name', () => {
  it('is TipTop Kraken, with the identifier and updater kept', () => {
    expect(conf.productName).toBe('TipTop Kraken');
    expect(conf.bundle.shortDescription).toBe('TipTop Kraken');
    expect(conf.identifier).toBe('vc.tiptop.copilot');
    expect(conf.plugins.updater.endpoints).toEqual([
      'https://copilot.tiptop.vc/api/desktop/update/{{target}}/{{arch}}/{{current_version}}',
    ]);
  });

  it('has the same version in tauri.conf.json, Cargo.toml and Cargo.lock', () => {
    const toml = readFileSync(join(SRC_TAURI, 'Cargo.toml'), 'utf8');
    const lock = readFileSync(join(SRC_TAURI, 'Cargo.lock'), 'utf8');
    expect(toml).toMatch(new RegExp(`^version = "${conf.version}"$`, 'm'));
    expect(lock).toContain(`name = "tiptop-copilot-desktop"\nversion = "${conf.version}"`);
  });

  it('finds the built Mac update under the new bundle name', () => {
    expect(workflow).toContain('tarball="$bundle/macos/$product.app.tar.gz"');
    expect(workflow).toContain("require('./desktop/src-tauri/tauri.conf.json').productName");
    expect(workflow).not.toContain('macos/TipTop Copilot.app');
  });

  it('builds every desktop icon from the Kraken crest', () => {
    expect(workflow).toContain('icon ../public/brand/kraken-logo.png --output src-tauri/icons');
    expect(existsSync(join(process.cwd(), 'public/brand/kraken-logo.png'))).toBe(true);
  });
});

describe('Windows installer hooks', () => {
  it('are wired into tauri.conf.json and exist', () => {
    expect(hooksPath).toBe('windows/installer-hooks.nsh');
    expect(hooks).not.toBe('');
    for (const macro of [
      'NSIS_HOOK_PREINSTALL',
      'NSIS_HOOK_POSTINSTALL',
      'NSIS_HOOK_PREUNINSTALL',
      'NSIS_HOOK_POSTUNINSTALL',
    ]) {
      expect(code).toMatch(new RegExp(`^!macro ${macro}$`, 'm'));
    }
  });

  it('never deletes the app data kept under the identifier', () => {
    expect(code).not.toMatch(/vc\.tiptop\.copilot/i);
    expect(code).not.toContain('${BUNDLEID}');
    expect(code).not.toContain('${IDENTIFIER}');
    // Every recursive delete is of the validated old install folder only.
    const recursive = code.match(/RMDir \/r .*/g) ?? [];
    expect(recursive.length).toBeGreaterThan(0);
    for (const line of recursive) expect(line.trim()).toBe('RMDir /r "$R0"');
    // Nothing anywhere under %APPDATA% or %LOCALAPPDATA% but the old install
    // folder itself and the old taskbar pin (which is rewritten, not deleted).
    for (const line of code.split('\n').filter((l) => /\$(LOCAL)?APPDATA/.test(l))) {
      expect(line).toMatch(
        /StrCpy \$R0 "\$LOCALAPPDATA\\\$\{KRAKEN_OLD_NAME\}"|User Pinned\\TaskBar\\TipTop Copilot\.lnk/,
      );
    }
  });

  it('never runs the old uninstaller, which can delete app data', () => {
    expect(code).not.toMatch(/Exec(Wait)?\s+[^\n]*uninstall/i);
    expect(code).not.toMatch(/nsExec::\w+\s+[^\n]*uninstall/i);
  });

  it('deletes the old folder only after checking it is the old install', () => {
    const at = (s: string) => code.indexOf(s);
    const remove = at('RMDir /r "$R0"');
    expect(at('StrCmp $R1 "${KRAKEN_OLD_NAME}" 0 kraken_keep')).toBeGreaterThan(-1);
    expect(at('StrCmp $R1 "${KRAKEN_OLD_NAME}" 0 kraken_keep')).toBeLessThan(remove);
    expect(at('StrCmp $R0 $INSTDIR kraken_keep')).toBeLessThan(remove);
    expect(at('IfFileExists "$R0\\uninstall.exe" 0 kraken_keep')).toBeLessThan(remove);
    expect(code).toContain('!define KRAKEN_OLD_NAME "TipTop Copilot"');
    // "TipTop Copilot" is the 14 characters the folder name check compares.
    expect('TipTop Copilot').toHaveLength(14);
    expect(code).toContain('StrCpy $R1 $R0 "" -14');
  });

  it('removes the old shortcuts and Add or Remove Programs entry', () => {
    expect(code).toContain('Delete "$SMPROGRAMS\\${KRAKEN_OLD_NAME}.lnk"');
    expect(code).toContain('Delete "$DESKTOP\\${KRAKEN_OLD_NAME}.lnk"');
    expect(code).toContain(
      '!define KRAKEN_OLD_UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TipTop Copilot"',
    );
    expect(code).toContain('DeleteRegKey HKCU "${KRAKEN_OLD_UNINSTKEY}"');
    expect(code).toContain('DeleteRegKey HKCU "${KRAKEN_OLD_PRODUCTKEY}"');
    // Only keys named for the old product.
    for (const line of code.match(/DeleteRegKey .*/g) ?? []) {
      expect(line).toMatch(/KRAKEN_OLD_(UNINSTKEY|PRODUCTKEY)/);
    }
  });

  it('makes the new Start menu shortcut itself, since update mode does not', () => {
    // 0.4.2's updater runs the installer with /UPDATE, where Tauri's template
    // only refreshes an existing "${PRODUCTNAME}.lnk". Without this, updated
    // users would have no Start menu entry and no toasts.
    const create = code.indexOf(
      'CreateShortcut "$SMPROGRAMS\\${PRODUCTNAME}.lnk" "$INSTDIR\\${MAINBINARYNAME}.exe"',
    );
    expect(create).toBeGreaterThan(-1);
    expect(code.indexOf('kraken_old_dir_gone:')).toBeLessThan(create);
    expect(code).toContain('!insertmacro SetLnkAppUserModelId "$SMPROGRAMS\\${PRODUCTNAME}.lnk"');
    // Only when an old Start menu shortcut was there, and never over a new one.
    expect(code).toContain('StrCmp $R2 1 0 kraken_sm_done');
    expect(code).toContain('IfFileExists "$SMPROGRAMS\\${PRODUCTNAME}.lnk" kraken_sm_done 0');
  });

  it('fails the build if the AppUserModelID macro is missing', () => {
    // A guarded call would silently make shortcuts toasts cannot use.
    expect(code).not.toContain('!ifmacrodef');
    expect((code.match(/!insertmacro SetLnkAppUserModelId/g) ?? []).length).toBe(3);
  });

  it('uses no relative jump over a plugin call', () => {
    // A plugin call compiles to several instructions, so "+2" would land
    // inside it.
    const lines = code.split('\n').map((l) => l.trim());
    lines.forEach((line, i) => {
      if (/\+\d\s*$/.test(line)) expect(lines[i + 1]).not.toMatch(/::/);
    });
  });
});
