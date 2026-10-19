// Tests for scripts/asc.mjs against a stand-in for the App Store Connect API.
// Run with: node --test ios-app/tests/asc.test.mjs   (the iOS workflow does).
// The key is made for the test; the IDs and certificate bytes are made up.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'asc.mjs');
const key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const certBytes = Buffer.from('made-up certificate bytes for the test');
const otherCertBytes = Buffer.from('a different made-up certificate');

/** A stand-in API: `routes` maps "METHOD /path" to a handler. */
async function standIn(routes) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost');
      const call = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: body ? JSON.parse(body) : null,
        auth: request.headers.authorization ?? '',
      };
      calls.push(call);
      const handler = routes[`${call.method} ${call.path}`];
      const [status, json] = handler ? handler(call) : [404, { errors: [{ title: 'not found' }] }];
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

function run(base, args) {
  const dir = mkdtempSync(join(tmpdir(), 'asc-test-'));
  const outputs = join(dir, 'outputs');
  writeFileSync(outputs, '');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          ...process.env,
          ASC_API_BASE: base,
          ASC_KEY_ID: 'TESTKEY123',
          ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
          ASC_KEY_P8: key,
          GITHUB_OUTPUT: outputs,
        },
      },
      (error, stdout) => {
        const values = Object.fromEntries(
          readFileSync(outputs, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        );
        resolve({ code: error ? error.code : 0, stdout, outputs: values, dir });
      },
    );
  });
}

const bundle = {
  type: 'bundleIds',
  id: 'B1',
  attributes: { identifier: 'vc.tiptop.copilot', platform: 'IOS' },
};

test('prepare registers the bundle ID and turns on push', async () => {
  const capabilities = [];
  const api = await standIn({
    'GET /v1/bundleIds': (call) =>
      call.query.cursor
        ? [200, { data: [] }]
        : [
            200,
            {
              // A longer identifier the filter also matches, and a next page.
              data: [
                {
                  type: 'bundleIds',
                  id: 'B0',
                  attributes: { identifier: 'vc.tiptop.copilot.other' },
                },
              ],
              links: { next: `${api.base}/v1/bundleIds?cursor=2` },
            },
          ],
    'POST /v1/bundleIds': () => [201, { data: bundle }],
    'GET /v1/bundleIds/B1/bundleIdCapabilities': () => [
      200,
      { data: capabilities.map((type) => ({ attributes: { capabilityType: type } })) },
    ],
    'POST /v1/bundleIdCapabilities': (call) => {
      const type = call.body.data.attributes.capabilityType;
      if (type === 'USERNOTIFICATIONS_TIMESENSITIVE')
        return [409, { errors: [{ title: 'refused' }] }];
      capabilities.push(type);
      return [201, { data: {} }];
    },
  });
  try {
    const result = await run(api.base, ['prepare']);
    assert.equal(result.code, 0, result.stdout);
    const made = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/bundleIds');
    assert.deepEqual(made.body, {
      data: {
        type: 'bundleIds',
        attributes: { identifier: 'vc.tiptop.copilot', name: 'TipTop Copilot', platform: 'IOS' },
      },
    });
    const push = api.calls.find(
      (c) =>
        c.path === '/v1/bundleIdCapabilities' &&
        c.body.data.attributes.capabilityType === 'PUSH_NOTIFICATIONS',
    );
    assert.deepEqual(push.body.data.relationships, {
      bundleId: { data: { type: 'bundleIds', id: 'B1' } },
    });
    assert.match(result.stdout, /Time Sensitive Notifications could not be turned on/);
    assert.equal(result.outputs.time_sensitive, 'no');
    // Every request carries an ES256 token for this key, for App Store Connect.
    for (const call of api.calls) {
      const [header, payload] = call.auth.replace('Bearer ', '').split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
        alg: 'ES256',
        kid: 'TESTKEY123',
        typ: 'JWT',
      });
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.aud, 'appstoreconnect-v1');
      assert.ok(claims.exp - claims.iat <= 20 * 60);
    }
  } finally {
    await api.close();
  }
});

/** Bundle IDs as Apple filters them: by platform only when asked (a comma-separated list). */
function listedBundles(call, bundles) {
  const platforms = call.query['filter[platform]']?.split(',');
  return platforms ? bundles.filter((b) => platforms.includes(b.attributes.platform)) : bundles;
}

// As Apple may list an ID registered in the developer portal.
const universalBundle = {
  type: 'bundleIds',
  id: 'B1',
  attributes: { identifier: 'vc.tiptop.copilot', platform: 'UNIVERSAL' },
};

test('prepare finds a bundle ID Apple lists as UNIVERSAL, and registers nothing', async () => {
  const api = await standIn({
    'GET /v1/bundleIds': (call) => [200, { data: listedBundles(call, [universalBundle]) }],
    'GET /v1/bundleIds/B1/bundleIdCapabilities': () => [
      200,
      {
        data: ['PUSH_NOTIFICATIONS', 'USERNOTIFICATIONS_TIMESENSITIVE'].map((type) => ({
          attributes: { capabilityType: type },
        })),
      },
    ],
  });
  try {
    const result = await run(api.base, ['prepare']);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!api.calls.some((c) => c.method === 'POST'), 'nothing is registered');
    const listed = api.calls.find((c) => c.path === '/v1/bundleIds');
    assert.equal(listed.query['filter[identifier]'], 'vc.tiptop.copilot');
    assert.equal(listed.query['filter[platform]'], undefined);
    assert.match(result.stdout, /The bundle ID vc\.tiptop\.copilot is registered\./);
    assert.equal(result.outputs.time_sensitive, 'yes');
  } finally {
    await api.close();
  }
});

function profileRoutes({ profiles, certificates, bundles = [bundle] }) {
  return {
    'GET /v1/certificates': () => [200, { data: certificates }],
    'GET /v1/bundleIds': (call) => [200, { data: listedBundles(call, bundles) }],
    'GET /v1/profiles': () => [200, { data: profiles }],
    'POST /v1/profiles': (call) => [
      201,
      {
        data: {
          id: 'P-new',
          attributes: {
            name: call.body.data.attributes.name,
            uuid: 'NEW-UUID',
            profileContent: Buffer.from('new profile').toString('base64'),
            expirationDate: '2027-10-01T00:00:00.000+0000',
          },
        },
      },
    ],
  };
}

const ourCertificate = {
  id: 'C1',
  attributes: {
    certificateContent: certBytes.toString('base64'),
    expirationDate: '2027-10-01T00:00:00.000+0000',
  },
};
const otherCertificate = {
  id: 'C2',
  attributes: { certificateContent: otherCertBytes.toString('base64') },
};

test('profile makes an App Store profile for the certificate when none holds it', async () => {
  const api = await standIn(
    profileRoutes({
      certificates: [otherCertificate, ourCertificate],
      profiles: [
        // Holds only the other certificate.
        {
          id: 'P-old',
          attributes: {
            uuid: 'OLD',
            profileContent: 'b2xk',
            expirationDate: '2099-01-01T00:00:00.000+0000',
          },
          relationships: {
            bundleId: { data: { id: 'B1' } },
            certificates: { data: [{ id: 'C2' }] },
          },
        },
      ],
    }),
  );
  try {
    const dir = mkdtempSync(join(tmpdir(), 'asc-cert-'));
    const pem = `-----BEGIN CERTIFICATE-----\n${certBytes.toString('base64')}\n-----END CERTIFICATE-----\n`;
    writeFileSync(join(dir, 'cert.pem'), pem);
    const out = join(dir, 'profile.mobileprovision');
    const result = await run(api.base, ['profile', '--cert', join(dir, 'cert.pem'), '--out', out]);
    assert.equal(result.code, 0, result.stdout);
    const made = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles');
    assert.equal(made.body.data.attributes.profileType, 'IOS_APP_STORE');
    assert.match(made.body.data.attributes.name, /^TipTop Copilot App Store \d{8}-\d{4}$/);
    assert.deepEqual(made.body.data.relationships, {
      bundleId: { data: { type: 'bundleIds', id: 'B1' } },
      certificates: { data: [{ type: 'certificates', id: 'C1' }] },
    });
    const listed = api.calls.find((c) => c.method === 'GET' && c.path === '/v1/profiles');
    assert.equal(listed.query['filter[profileType]'], 'IOS_APP_STORE');
    assert.equal(listed.query['filter[profileState]'], 'ACTIVE');
    assert.equal(readFileSync(out, 'utf8'), 'new profile');
    assert.equal(result.outputs.profile_uuid, 'NEW-UUID');
  } finally {
    await api.close();
  }
});

test('profile reuses an active profile that holds the certificate', async () => {
  const api = await standIn(
    profileRoutes({
      certificates: [ourCertificate],
      profiles: [
        {
          id: 'P1',
          attributes: {
            uuid: 'KEEP-UUID',
            profileContent: Buffer.from('kept profile').toString('base64'),
            expirationDate: '2099-01-01T00:00:00.000+0000',
          },
          relationships: {
            bundleId: { data: { id: 'B1' } },
            certificates: { data: [{ id: 'C1' }] },
          },
        },
      ],
    }),
  );
  try {
    const dir = mkdtempSync(join(tmpdir(), 'asc-cert-'));
    writeFileSync(join(dir, 'cert.der'), certBytes);
    const out = join(dir, 'profile.mobileprovision');
    const result = await run(api.base, ['profile', '--cert', join(dir, 'cert.der'), '--out', out]);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(!api.calls.some((c) => c.method === 'POST'));
    assert.equal(readFileSync(out, 'utf8'), 'kept profile');
    assert.equal(result.outputs.profile_uuid, 'KEEP-UUID');
  } finally {
    await api.close();
  }
});

test('profile finds a bundle ID Apple lists as UNIVERSAL', async () => {
  const api = await standIn(
    profileRoutes({ certificates: [ourCertificate], profiles: [], bundles: [universalBundle] }),
  );
  try {
    const dir = mkdtempSync(join(tmpdir(), 'asc-cert-'));
    writeFileSync(join(dir, 'cert.der'), certBytes);
    const out = join(dir, 'profile.mobileprovision');
    const result = await run(api.base, ['profile', '--cert', join(dir, 'cert.der'), '--out', out]);
    assert.equal(result.code, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /not registered yet/);
    const made = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles');
    assert.deepEqual(made.body.data.relationships.bundleId, {
      data: { type: 'bundleIds', id: 'B1' },
    });
    assert.equal(result.outputs.profile_uuid, 'NEW-UUID');
  } finally {
    await api.close();
  }
});

test("profile stops when the certificate is not the team's", async () => {
  const api = await standIn(profileRoutes({ certificates: [otherCertificate], profiles: [] }));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'asc-cert-'));
    writeFileSync(join(dir, 'cert.der'), certBytes);
    const result = await run(api.base, [
      'profile',
      '--cert',
      join(dir, 'cert.der'),
      '--out',
      join(dir, 'p'),
    ]);
    assert.equal(result.code, 1);
    assert.match(
      result.stdout,
      /::error::The certificate in IOS_DIST_P12 is not one of the team's/,
    );
  } finally {
    await api.close();
  }
});

test('check reports a refused key plainly', async () => {
  const api = await standIn({
    'GET /v1/apps': () => [
      401,
      { errors: [{ title: 'Authentication credentials are missing or invalid.' }] },
    ],
  });
  try {
    const result = await run(api.base, ['check']);
    assert.equal(result.code, 1);
    assert.match(
      result.stdout,
      /The key was refused: check ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8/,
    );
  } finally {
    await api.close();
  }
});

test('check finds the app record', async () => {
  const api = await standIn({
    'GET /v1/apps': () => [
      200,
      { data: [{ id: 'A1', attributes: { bundleId: 'vc.tiptop.copilot' } }] },
    ],
  });
  try {
    const result = await run(api.base, ['check']);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.outputs.app_record, 'yes');
  } finally {
    await api.close();
  }
});
