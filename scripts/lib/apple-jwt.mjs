/**
 * ES256 JSON Web Tokens for Apple's APIs, with no dependencies.
 *
 * The phone-alert sender (scripts/push-alerts.mjs) signs its APNs provider
 * token with this: header `{alg: "ES256", kid: <APNs key id>}`, claims
 * `{iss: <team id>, iat}` (Apple, "Establishing a token-based connection to
 * APNs"). The same shape, with `aud` and `exp` added, is App Store Connect's.
 *
 * Apple's keys are P-256 private keys in PKCS#8, downloaded once as an
 * `AuthKey_<key id>.p8` text file. A JWS signature is the raw 64-byte r||s,
 * not DER, which is what node:crypto's `dsaEncoding: 'ieee-p1363'` gives.
 *
 * The sender's workflow copies this file next to the script
 * (.github/workflows/push-alerts.yml); a test runs the copy the way the
 * workflow does (tests/integration/push-sender.test.ts).
 */
import { createPrivateKey, sign } from 'node:crypto';

/** base64url without padding, for a Buffer or a string. */
export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * The private key from a .p8 as it was pasted into a secret: the file's
 * text (PEM), the same with its line breaks written as `\n`, or the file
 * base64-encoded. Throws when it is none of those or not a P-256 key; the
 * message never contains the key.
 */
export function loadP8(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('The key is empty.');
  const attempts = [];
  const pem = raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (pem.includes('-----BEGIN')) attempts.push(() => createPrivateKey(pem));
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
    const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
    const asText = decoded.toString('utf8');
    if (asText.includes('-----BEGIN')) attempts.push(() => createPrivateKey(asText));
    else attempts.push(() => createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' }));
  }
  for (const attempt of attempts) {
    let key;
    try {
      key = attempt();
    } catch {
      continue;
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('The key is not a P-256 (ES256) key.');
    }
    return key;
  }
  throw new Error('The key is not a .p8 private key.');
}

/**
 * A signed ES256 token. `header` adds to `{alg: "ES256"}` (Apple wants `kid`
 * there); `claims` is the payload as given.
 */
export function mintAppleJwt(key, header, claims) {
  const head = base64url(JSON.stringify({ alg: 'ES256', ...header }));
  const body = base64url(JSON.stringify(claims));
  const input = `${head}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

/** The APNs provider token: kid = the APNs key's id, iss = the team id, iat = now, in seconds. */
export function apnsProviderToken(key, { keyId, teamId, now = Date.now() }) {
  return mintAppleJwt(key, { kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) });
}
