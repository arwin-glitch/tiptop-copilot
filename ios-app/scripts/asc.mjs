// Talks to Apple for the iOS workflow (.github/workflows/ios.yml): the App
// Store Connect API for the app's bundle ID, its capabilities and its App
// Store provisioning profile, and APNs for a one-off check of the push key.
// Node's own modules only; nothing is installed.
//
//   node scripts/asc.mjs check                    the API key works; the app record exists
//   node scripts/asc.mjs prepare                  bundle ID and push capability, made if missing
//   node scripts/asc.mjs profile --cert <pem|der> --out <file>
//                                                 the App Store profile for that certificate
//   node scripts/asc.mjs apns-check               the push key, against a made-up device
//
// Reads ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 (the .p8 file's text) for
// the API, and APNS_KEY_ID, APNS_KEY_P8 and APPLE_TEAM_ID for APNs. It never
// prints a key, and the workflow masks the IDs in its logs.
//
// Endpoints, filters and values are those of Apple's App Store Connect
// OpenAPI specification (4.5.1): GET/POST /v1/bundleIds, GET
// /v1/bundleIds/{id}/bundleIdCapabilities, POST /v1/bundleIdCapabilities,
// GET /v1/certificates, GET/POST /v1/profiles and GET /v1/apps.

import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { pathToFileURL } from 'node:url';

// ASC_API_BASE points the script at a stand-in server in its own test.
const API = process.env.ASC_API_BASE || 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'vc.tiptop.copilot';
const APP_NAME = 'TipTop Copilot';

// ---------------------------------------------------------------------------
// Signed tokens

/** A .p8 key as PEM, whether it was pasted with or without its header lines. */
export function p8ToPem(text) {
  const body = String(text ?? '')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('empty key');
  const lines = body.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

/** An ES256 JSON Web Token, signed the way Apple's APIs require (raw r||s). */
export function es256Token(header, payload, p8) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'ES256', ...header })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(p8ToPem(p8)),
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

/** App Store Connect: a team key's token, good for 15 of Apple's 20 minutes. */
function apiToken() {
  const keyId = need('ASC_KEY_ID');
  const issuer = need('ASC_ISSUER_ID');
  const p8 = need('ASC_KEY_P8');
  const now = Math.floor(Date.now() / 1000);
  return es256Token(
    { kid: keyId, typ: 'JWT' },
    { iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' },
    p8,
  );
}

function need(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) fail(`${name} is not set.`);
  return value;
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App Store Connect API

let token = null;

async function api(method, path, body) {
  token ??= apiToken();
  const response = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Left null; the status says what happened.
  }
  if (!response.ok) {
    const detail = (json?.errors ?? [])
      .map((e) => [e.title, e.detail].filter(Boolean).join(': '))
      .join(' | ');
    const hint =
      response.status === 401
        ? ' The key was refused: check ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 belong to one team key.'
        : response.status === 403
          ? ' Not allowed: the key needs Admin access, or an agreement is waiting for the Account Holder in App Store Connect.'
          : '';
    const error = new Error(
      `${method} ${path.split('?')[0]} answered ${response.status}.${hint} ${detail}`.trim(),
    );
    error.status = response.status;
    throw error;
  }
  return json;
}

/** Every item of a list endpoint, following Apple's next links. */
async function list(path) {
  const items = [];
  const included = [];
  let next = path;
  while (next) {
    const page = await api('GET', next);
    items.push(...(page.data ?? []));
    included.push(...(page.included ?? []));
    next = page.links?.next ?? null;
  }
  return { items, included };
}

/**
 * The bundle ID, whatever platform Apple lists it for. The API knows IOS,
 * MAC_OS and UNIVERSAL, and one registered in the developer portal (whose
 * form covers every platform) may be listed as UNIVERSAL; an identifier can
 * be registered only once, so a filter on IOS would miss it, and `prepare`
 * would then fail trying to register it again.
 */
async function findBundleId() {
  const query = new URLSearchParams({ 'filter[identifier]': BUNDLE_ID, limit: '200' });
  const { items } = await list(`/v1/bundleIds?${query}`);
  // The filter also matches longer identifiers that start the same way.
  const exact = items.filter((b) => b.attributes?.identifier === BUNDLE_ID);
  const forIphone = (b) => ['IOS', 'UNIVERSAL'].includes(b.attributes?.platform);
  const bundle = exact.find(forIphone) ?? exact[0] ?? null;
  if (bundle)
    console.log(`The bundle ID is listed for ${bundle.attributes?.platform ?? 'no platform'}.`);
  return bundle;
}

async function capabilitiesOf(bundle) {
  const { items } = await list(`/v1/bundleIds/${bundle.id}/bundleIdCapabilities?limit=200`);
  return items.map((c) => c.attributes?.capabilityType).filter(Boolean);
}

async function addCapability(bundle, capabilityType) {
  await api('POST', '/v1/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } },
    },
  });
}

// ---------------------------------------------------------------------------
// Commands

async function check() {
  const query = new URLSearchParams({ 'filter[bundleId]': BUNDLE_ID, limit: '200' });
  const { items } = await list(`/v1/apps?${query}`);
  const app = items.find((a) => a.attributes?.bundleId === BUNDLE_ID);
  console.log('The App Store Connect key works.');
  if (app) {
    console.log(`The app record for ${BUNDLE_ID} exists.`);
  } else {
    console.log(
      `::warning::There is no app record for ${BUNDLE_ID} yet. Make it in App Store Connect (Apps, +, New App) before the first upload; the API cannot.`,
    );
  }
  output('app_record', app ? 'yes' : 'no');
}

async function prepare() {
  let bundle = await findBundleId();
  if (!bundle) {
    const made = await api('POST', '/v1/bundleIds', {
      data: {
        type: 'bundleIds',
        attributes: { identifier: BUNDLE_ID, name: APP_NAME, platform: 'IOS' },
      },
    });
    bundle = made.data;
    console.log(`Registered the bundle ID ${BUNDLE_ID}.`);
  } else {
    console.log(`The bundle ID ${BUNDLE_ID} is registered.`);
  }

  let capabilities = await capabilitiesOf(bundle);
  if (!capabilities.includes('PUSH_NOTIFICATIONS')) {
    await addCapability(bundle, 'PUSH_NOTIFICATIONS');
    console.log('Turned on Push Notifications.');
  }
  // Time Sensitive Notifications, so 5-minute meeting alerts get through a
  // Focus. Apple's API documents no value for it; this is the one Apple's own
  // portal uses (as fastlane does). If it is refused, the app ships without
  // the entitlement and sends meeting alerts as ordinary ones, and the
  // Account Holder can tick it under Identifiers instead.
  if (!capabilities.includes('USERNOTIFICATIONS_TIMESENSITIVE')) {
    try {
      await addCapability(bundle, 'USERNOTIFICATIONS_TIMESENSITIVE');
      console.log('Turned on Time Sensitive Notifications.');
    } catch (error) {
      console.log(
        `::notice::Time Sensitive Notifications could not be turned on through the API (${error.status ?? 'error'}). Meeting alerts still arrive, as ordinary alerts. To add it: developer.apple.com, Identifiers, ${BUNDLE_ID}, tick Time Sensitive Notifications.`,
      );
    }
  }

  capabilities = await capabilitiesOf(bundle);
  console.log(`Capabilities now: ${capabilities.sort().join(', ') || 'none'}.`);
  if (!capabilities.includes('PUSH_NOTIFICATIONS')) {
    fail('Push Notifications is still off for the bundle ID.');
  }
  output('time_sensitive', capabilities.includes('USERNOTIFICATIONS_TIMESENSITIVE') ? 'yes' : 'no');
}

/** A certificate file's DER bytes, from PEM or DER. */
function readCertificate(path) {
  const raw = readFileSync(path);
  const text = raw.toString('latin1');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const body = text.split('-----BEGIN CERTIFICATE-----')[1].split('-----END CERTIFICATE-----')[0];
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  return raw;
}

async function profile(args) {
  const certPath = arg(args, '--cert');
  const outPath = arg(args, '--out');
  const der = readCertificate(certPath);

  // The team's distribution certificates, matched on their content, so the
  // profile is always the one that holds the certificate this build signs
  // with: after a renewal the old profile no longer matches.
  const certQuery = new URLSearchParams({
    'filter[certificateType]': 'DISTRIBUTION',
    limit: '200',
  });
  const { items: certificates } = await list(`/v1/certificates?${certQuery}`);
  const certificate = certificates.find(
    (c) =>
      c.attributes?.certificateContent &&
      Buffer.from(c.attributes.certificateContent, 'base64').equals(der),
  );
  if (!certificate) {
    fail(
      'The certificate in IOS_DIST_P12 is not one of the team\'s Apple Distribution certificates (it was revoked, or belongs to another team). Make a new one: see "Renewing the certificate" in ios-app/README.md.',
    );
  }

  const bundle = await findBundleId();
  if (!bundle)
    fail(`The bundle ID ${BUNDLE_ID} is not registered yet: run the workflow's "setup" task.`);

  const profileQuery = new URLSearchParams({
    'filter[profileType]': 'IOS_APP_STORE',
    'filter[profileState]': 'ACTIVE',
    include: 'bundleId,certificates',
    'limit[certificates]': '50',
    limit: '200',
  });
  const { items: profiles } = await list(`/v1/profiles?${profileQuery}`);
  const soon = Date.now() + 14 * 24 * 3600 * 1000;
  let chosen = profiles.find(
    (p) =>
      p.relationships?.bundleId?.data?.id === bundle.id &&
      (p.relationships?.certificates?.data ?? []).some((c) => c.id === certificate.id) &&
      Date.parse(p.attributes?.expirationDate ?? 0) > soon,
  );

  if (chosen) {
    console.log('Using the App Store profile that holds this certificate.');
  } else {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const made = await api('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: { name: `${APP_NAME} App Store ${stamp}`, profileType: 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: certificate.id }] },
        },
      },
    });
    chosen = made.data;
    console.log('Made a new App Store profile for this certificate.');
  }

  const content = chosen.attributes?.profileContent;
  const uuid = chosen.attributes?.uuid;
  if (!content || !uuid) fail('Apple returned a profile without its content or UUID.');
  writeFileSync(outPath, Buffer.from(content, 'base64'));
  output('profile_uuid', uuid);
  output('profile_expires', chosen.attributes?.expirationDate ?? '');
  output('certificate_expires', certificate.attributes?.expirationDate ?? '');
  console.log(`Profile valid until ${chosen.attributes?.expirationDate ?? 'an unknown date'}.`);
}

/**
 * Sends one alert to a made-up device token. APNs checks the key before the
 * token, so "BadDeviceToken" means the key, Key ID and Team ID are right.
 */
async function apnsCheck() {
  const keyId = need('APNS_KEY_ID');
  const teamId = need('APPLE_TEAM_ID');
  const p8 = need('APNS_KEY_P8');
  const jwt = es256Token({ kid: keyId }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, p8);
  const { status, reason } = await new Promise((resolve, reject) => {
    const client = http2.connect('https://api.push.apple.com');
    client.on('error', reject);
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${'0'.repeat(64)}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    });
    let statusCode = 0;
    let data = '';
    request.setEncoding('utf8');
    request.on('response', (headers) => (statusCode = Number(headers[':status'])));
    request.on('data', (chunk) => (data += chunk));
    request.on('end', () => {
      client.close();
      let parsed = '';
      try {
        parsed = JSON.parse(data).reason ?? '';
      } catch {
        // No body.
      }
      resolve({ status: statusCode, reason: parsed });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ aps: { alert: { title: 'Check', body: 'Check' } } }));
  });
  if (status === 400 && reason === 'BadDeviceToken') {
    console.log('The APNs key works: Apple accepted the key and refused only the made-up device.');
    return;
  }
  const hints = {
    InvalidProviderToken: 'APNS_KEY_ID, APNS_KEY_P8 and APPLE_TEAM_ID do not belong together.',
    ExpiredProviderToken: 'the runner clock is off, or the token was refused as old.',
    BadEnvironmentKeyIdInToken:
      'the key is for one environment only; make it "Sandbox & Production".',
    TopicDisallowed: `the key's team cannot send to ${BUNDLE_ID}.`,
    DeviceTokenNotForTopic: `the key's team cannot send to ${BUNDLE_ID}.`,
  };
  fail(
    `APNs answered ${status} ${reason || '(no reason)'}: ${hints[reason] ?? "see Apple's APNs error table."}`,
  );
}

// ---------------------------------------------------------------------------

function arg(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) fail(`Pass ${name} <path>.`);
  return value;
}

/** A step output for the workflow, when run there. */
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const commands = { check, prepare, profile, 'apns-check': apnsCheck };
// Run as a script, not when imported (by a test of the token code).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  const run = commands[command];
  if (!run)
    fail(`Unknown command "${command ?? ''}". Use one of: ${Object.keys(commands).join(', ')}.`);
  run(rest).catch((error) => fail(error.message));
}
