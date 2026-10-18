// Checks a Tauri updater signature (.sig) the way the installed app will
// before it installs an update (tauri-plugin-updater 2.14, minisign):
// Ed25519 over the file (prehashed with BLAKE2b-512 when the algorithm is
// "ED"), the key id, the global signature over the trusted comment, and the
// version recorded in that comment (plugins.updater.requireSignedVersion).
//
//   node desktop/scripts/verify-update-signature.mjs <file> <file.sig> <version>
//
// The public key is read from desktop/src-tauri/tauri.conf.json. The desktop
// workflow's sign job runs this on every update file before a release and
// requires the exact "signature verified" line it prints, so a run that
// prints nothing fails too.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const TRUSTED = 'trusted comment: ';

const decodeLines = (base64) => Buffer.from(base64.trim(), 'base64').toString('utf8').split('\n');

/**
 * Null when `signature` (the .sig file's base64 text) is a valid signature of
 * `data` for `version` by `pubkey` (plugins.updater.pubkey); else the reason.
 */
export function verifyUpdateSignature({ data, signature, pubkey, version }) {
  const pk = Buffer.from(decodeLines(pubkey)[1] ?? '', 'base64');
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== 'Ed') {
    return 'the public key is not a minisign key';
  }
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, pk.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const [, sigLine = '', comment = '', globalLine = ''] = decodeLines(signature);
  const sig = Buffer.from(sigLine, 'base64');
  if (sig.length !== 74) return 'the signature is malformed';
  const algorithm = sig.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') return `unknown algorithm ${algorithm}`;
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) {
    return 'signed with a different key than the one the app trusts';
  }
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10))) return 'the signature does not match the file';
  if (!comment.startsWith(TRUSTED)) return 'the signature has no trusted comment';
  const trusted = comment.slice(TRUSTED.length);
  const signedComment = Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]);
  if (!verify(null, signedComment, key, Buffer.from(globalLine, 'base64'))) {
    return 'the trusted comment is not signed';
  }
  const signed = trusted
    .split('\t')
    .find((field) => field.startsWith('version:'))
    ?.slice('version:'.length);
  return signed === version ? null : `signed for version ${signed ?? '(none)'}, not ${version}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, sigFile, version] = process.argv.slice(2);
  if (!file || !sigFile || !version) {
    console.error('usage: verify-update-signature.mjs <file> <file.sig> <version>');
    process.exit(2);
  }
  const conf = new URL('../src-tauri/tauri.conf.json', import.meta.url);
  const pubkey = JSON.parse(readFileSync(conf, 'utf8')).plugins?.updater?.pubkey ?? '';
  const problem = verifyUpdateSignature({
    data: readFileSync(file),
    signature: readFileSync(sigFile, 'utf8'),
    pubkey,
    version,
  });
  if (problem) {
    console.log(`::error::${file}: ${problem}`);
    process.exit(1);
  }
  console.log(`${file}: signature verified for ${version}`);
}
