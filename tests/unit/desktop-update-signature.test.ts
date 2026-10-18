import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyUpdateSignature } from '../../desktop/scripts/verify-update-signature.mjs';

/**
 * The check CI runs on every update file before a release
 * (desktop/scripts/verify-update-signature.mjs), the same one the installed
 * app makes. The key pair and signature are the throwaway test vector
 * published with tauri-plugin-updater 2.14.0: the payload `test`, signed
 * with `tauri signer sign --app-version 2.0.0`. Nothing here is a real key.
 */

const b64 = (text: string) => Buffer.from(text).toString('base64');

const PUBKEY = b64(
  'untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe',
);
const SIG_LINE =
  'RUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=';
const GLOBAL_LINE =
  'DDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==';
const signatureWith = (comment: string) =>
  b64(
    `untrusted comment: signature from tauri secret key\n${SIG_LINE}\ntrusted comment: ${comment}\n${GLOBAL_LINE}`,
  );
const SIGNATURE = signatureWith('timestamp:1791649051\tfile:payload\tversion:2.0.0');
const DATA = Buffer.from('test');

describe('verifyUpdateSignature', () => {
  it('passes a good signature for its version', () => {
    expect(
      verifyUpdateSignature({ data: DATA, signature: SIGNATURE, pubkey: PUBKEY, version: '2.0.0' }),
    ).toBeNull();
  });

  it('accepts the .sig file text with a trailing newline', () => {
    expect(
      verifyUpdateSignature({
        data: DATA,
        signature: `${SIGNATURE}\n`,
        pubkey: PUBKEY,
        version: '2.0.0',
      }),
    ).toBeNull();
  });

  it('rejects another version, a changed file and a changed trusted comment', () => {
    expect(
      verifyUpdateSignature({ data: DATA, signature: SIGNATURE, pubkey: PUBKEY, version: '2.0.1' }),
    ).toMatch(/signed for version 2\.0\.0/);
    expect(
      verifyUpdateSignature({
        data: Buffer.from('Test'),
        signature: SIGNATURE,
        pubkey: PUBKEY,
        version: '2.0.0',
      }),
    ).toMatch(/does not match the file/);
    expect(
      verifyUpdateSignature({
        data: DATA,
        signature: signatureWith('timestamp:1791649051\tfile:payload\tversion:9.0.0'),
        pubkey: PUBKEY,
        version: '9.0.0',
      }),
    ).toMatch(/trusted comment is not signed/);
  });

  it('rejects a signature by any key but the one the app trusts', () => {
    const conf = path.resolve(import.meta.dirname, '../../desktop/src-tauri/tauri.conf.json');
    const ours = (
      JSON.parse(readFileSync(conf, 'utf8')) as { plugins: { updater: { pubkey: string } } }
    ).plugins.updater.pubkey;
    expect(
      verifyUpdateSignature({ data: DATA, signature: SIGNATURE, pubkey: ours, version: '2.0.0' }),
    ).toMatch(/different key/);
  });

  it('rejects malformed input instead of passing it', () => {
    expect(
      verifyUpdateSignature({
        data: DATA,
        signature: b64('nonsense'),
        pubkey: PUBKEY,
        version: '2.0.0',
      }),
    ).not.toBeNull();
    expect(
      verifyUpdateSignature({
        data: DATA,
        signature: SIGNATURE,
        pubkey: b64('nonsense'),
        version: '2.0.0',
      }),
    ).not.toBeNull();
  });
});
