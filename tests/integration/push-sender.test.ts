import { spawn } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The phone-alert sender (scripts/push-alerts.mjs), run the way the
 * push-alerts workflow runs it: from a scratch folder holding only the files
 * the workflow's "Install the sender" step copies there, so an import the
 * workflow does not copy fails here instead of on GitHub, where it would stop
 * Web Push too. Against a stand-in for Copilot and a stand-in for Apple's
 * push service (HTTP/2 without TLS), with a throwaway key made here.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'push-alerts.yml');

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC = createPublicKey(privateKey);
const KEY_ID = 'TESTKEY123';
const TEAM_ID = 'TESTTEAM12';

let senderDir = '';
let scratch = '';

/** Copies what the workflow's "Install the sender" step copies, where it copies it. */
async function installLikeTheWorkflow(into: string): Promise<string[]> {
  const workflow = await readFile(WORKFLOW, 'utf8');
  const start = workflow.indexOf('- name: Install the sender');
  const end = workflow.indexOf('- name:', start + 1);
  const step = workflow.slice(start, end);
  const copied: string[] = [];
  for (const line of step.split('\n')) {
    const mk = /^\s*mkdir -p "\$\{RUNNER_TEMP\}\/([^"]+)"\s*$/.exec(line);
    if (mk) await mkdir(path.join(into, mk[1]!), { recursive: true });
    const cp = /^\s*cp (\S+) "\$\{RUNNER_TEMP\}\/([^"]*)"\s*$/.exec(line);
    if (cp) {
      const [, from, to] = cp as unknown as [string, string, string];
      const target = to.endsWith('/')
        ? path.join(into, to, path.basename(from))
        : path.join(into, to);
      await copyFile(path.join(ROOT, from), target);
      copied.push(from);
    }
  }
  return copied;
}

interface Run {
  code: number | null;
  out: string;
}

function runSender(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(senderDir, 'push-alerts.mjs')], {
      cwd: senderDir,
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`sender timed out:\n${out}`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/* ------------------------------------------------------------ stand-ins */

const T1 = 'a1'.repeat(32);
const T2 = 'b2'.repeat(32);
const T3 = 'c3'.repeat(32);
const K1 = '1'.repeat(40);
const K2 = '2'.repeat(40);
const K3 = '3'.repeat(40);

const MEETING = {
  keys: ['meeting:evt-fictional'],
  title: 'Fictional sync in 5 min',
  body: 'Tap to join',
  url: '/go/meeting?id=evt-fictional',
  tag: 'meeting-evt-fictional',
};
const MONEY = {
  keys: ['money:fictional-invoice'],
  title: 'Money or legal going stale',
  body: 'Fictional invoice day 30',
  url: '/today',
  tag: 'money',
};

interface AppStandIn {
  url: string;
  queries: string[];
  reports: unknown[];
  close: () => Promise<void>;
}

function startApp(outbox: unknown[]): Promise<AppStandIn> {
  const queries: string[] = [];
  const reports: unknown[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-cron-secret') {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/cron/push')) {
      queries.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, publicKey: 'unused', outbox }));
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      reports.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        queries,
        reports,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

interface ApnsRequest {
  headers: http2.IncomingHttpHeaders;
  body: string;
  session: number;
}

interface ApnsStandIn {
  origin: string;
  requests: ApnsRequest[];
  close: () => Promise<void>;
}

/** The made-up device the sender checks its key against before the first pass. */
const CHECK = '0'.repeat(64);
const isCheck = (r: ApnsRequest) => r.headers[':path'] === `/3/device/${CHECK}`;
const sendsOf = (apns: ApnsStandIn) => apns.requests.filter((r) => !isCheck(r));

type Answer = { status: number; body?: object } | 'reset';

/**
 * Answers each request with `answer(token, attempt)`: a status and an
 * optional JSON body, or 'reset' to drop the request unanswered. The key
 * check gets Apple's answer for a working key (400 BadDeviceToken) unless
 * `answer` says otherwise for it.
 */
function startApns(
  answer: (token: string, attempt: number) => Answer | undefined,
): Promise<ApnsStandIn> {
  const requests: ApnsRequest[] = [];
  const attempts = new Map<string, number>();
  let sessions = 0;
  const server = http2.createServer();
  server.on('session', (session) => {
    (session as unknown as { n: number }).n = ++sessions;
  });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => (body += d));
    stream.on('end', () => {
      const token = String(headers[':path']).replace('/3/device/', '');
      const attempt = (attempts.get(token) ?? 0) + 1;
      attempts.set(token, attempt);
      requests.push({ headers, body, session: (stream.session as unknown as { n: number }).n });
      const given =
        answer(token, attempt) ??
        (token === CHECK ? { status: 400, body: { reason: 'BadDeviceToken' } } : { status: 200 });
      if (given === 'reset') {
        // Dropped on purpose: the error it raises here is expected.
        stream.on('error', () => {});
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      const { status, body: reply } = given;
      stream.respond({
        ':status': status,
        ...(reply ? { 'content-type': 'application/json' } : {}),
      });
      stream.end(reply ? JSON.stringify(reply) : undefined);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function apnsEnv(app: AppStandIn, apns: ApnsStandIn, extra: Record<string, string> = {}) {
  return {
    APP_URL: app.url,
    CRON_SECRET: 'test-cron-secret',
    APNS_KEY_P8: P8,
    APNS_KEY_ID: KEY_ID,
    APPLE_TEAM_ID: TEAM_ID,
    APNS_ORIGIN: apns.origin,
    ...extra,
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'push-sender-'));
  const copied = await installLikeTheWorkflow(scratch);
  expect(copied).toContain('scripts/push-alerts.mjs');
  senderDir = path.join(scratch, 'sender');
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('the sender, from the workflow’s copy', () => {
  it('loads with only the copied files, and with no keys says so and stops', async () => {
    const run = await runSender({ APP_URL: 'http://127.0.0.1:9', CRON_SECRET: 'x' });
    expect(run.out).toContain('Neither VAPID_PRIVATE_KEY nor APNS_KEY_P8 is set yet');
    expect(run.code).toBe(0);
  });

  it('sends to the iPhone app: headers, token and payload as Apple wants, and reports gone tokens', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [
          { key: K1, token: T1, userId: 'u1' },
          { key: K2, token: T2, userId: 'u1' },
          { key: K3, token: T3, userId: 'u2' },
        ],
        alerts: [MEETING, MONEY],
      },
    ]);
    const apns = await startApns((token) =>
      token === T2
        ? { status: 410, body: { reason: 'Unregistered', timestamp: 1_790_000_000_000 } }
        : token === T3
          ? { status: 400, body: { reason: 'BadDeviceToken' } }
          : { status: 200 },
    );
    try {
      const before = Math.floor(Date.now() / 1000);
      const run = await runSender(apnsEnv(app, apns));
      expect(run.code, run.out).toBe(0);
      expect(app.queries).toEqual(['/api/cron/push?scope=all&apns=1']);

      // The key is checked once, against a made-up device, before anything
      // is asked for; then T1 gets both, T2 and T3 only the first, then they
      // are gone.
      expect(isCheck(apns.requests[0]!)).toBe(true);
      expect(apns.requests[0]!.headers['apns-topic']).toBe('vc.tiptop.copilot');
      expect(sendsOf(apns).map((r) => r.headers[':path'])).toEqual([
        `/3/device/${T1}`,
        `/3/device/${T2}`,
        `/3/device/${T3}`,
        `/3/device/${T1}`,
      ]);
      const [first, , , last] = sendsOf(apns);
      expect(first!.headers).toMatchObject({
        ':method': 'POST',
        'apns-topic': 'vc.tiptop.copilot',
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': 'meeting-evt-fictional',
      });
      const expiration = Number(first!.headers['apns-expiration']);
      expect(expiration - before).toBeGreaterThanOrEqual(599);
      expect(expiration - before).toBeLessThanOrEqual(640);
      expect(Number(last!.headers['apns-expiration']) - before).toBeGreaterThanOrEqual(21_599);

      // One provider token, ES256 over {alg, kid} and {iss, iat}.
      const auth = String(first!.headers.authorization);
      expect(auth).toMatch(/^bearer /);
      const [head, claims, signature] = auth.slice(7).split('.') as [string, string, string];
      expect(decode(head)).toEqual({ alg: 'ES256', kid: KEY_ID });
      expect(decode(claims)).toMatchObject({ iss: TEAM_ID });
      expect(Math.abs(Number(decode(claims).iat) - before)).toBeLessThan(60);
      expect(
        verify(
          'sha256',
          Buffer.from(`${head}.${claims}`),
          { key: PUBLIC, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
      expect(new Set(apns.requests.map((r) => r.headers.authorization)).size).toBe(1);

      expect(JSON.parse(first!.body)).toEqual({
        aps: {
          alert: { title: MEETING.title, body: MEETING.body },
          sound: 'default',
          'thread-id': 'meeting',
          // Not time-sensitive until APNS_TIME_SENSITIVE says the app may.
          'interruption-level': 'active',
        },
        url: MEETING.url,
        tag: MEETING.tag,
      });
      expect(JSON.parse(last!.body).aps['thread-id']).toBe('money');

      expect(app.reports).toEqual([
        {
          organizationId: 'org-fictional',
          sent: [...MEETING.keys, ...MONEY.keys],
          gone: [],
          goneApns: [{ key: K2, at: 1_790_000_000_000 }, { key: K3 }],
        },
      ]);
      // Never a token in the log.
      expect(run.out).not.toContain(T1);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('a stale provider token: a new one on a new connection, and one more try', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [{ key: K1, token: T1, userId: 'u1' }],
        alerts: [MONEY],
      },
    ]);
    const apns = await startApns((token, attempt) =>
      token !== T1
        ? undefined
        : attempt === 1
          ? { status: 403, body: { reason: 'ExpiredProviderToken' } }
          : { status: 200 },
    );
    try {
      const run = await runSender(apnsEnv(app, apns, { APNS_TIME_SENSITIVE: '1' }));
      expect(run.code, run.out).toBe(0);
      const sends = sendsOf(apns);
      expect(sends).toHaveLength(2);
      expect(sends[1]!.session).not.toBe(sends[0]!.session);
      expect(app.reports).toEqual([
        { organizationId: 'org-fictional', sent: MONEY.keys, gone: [], goneApns: [] },
      ]);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('a key Apple refuses at the check: the app is not asked for tokens, and it says why', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [
          { key: K1, token: T1, userId: 'u1' },
          { key: K2, token: T2, userId: 'u1' },
        ],
        alerts: [MEETING, MONEY],
      },
    ]);
    const apns = await startApns(() => ({ status: 403, body: { reason: 'InvalidProviderToken' } }));
    try {
      const run = await runSender(apnsEnv(app, apns));
      expect(run.out).toContain(
        '::error::APNs refused the key or setup at the key check (HTTP 403 InvalidProviderToken)',
      );
      // Only the check went to Apple, and the app held nobody's web push back.
      expect(apns.requests).toHaveLength(1);
      expect(isCheck(apns.requests[0]!)).toBe(true);
      expect(app.queries).toEqual(['/api/cron/push?scope=all']);
      expect(app.reports).toEqual([]);
      expect(run.code).toBe(1);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('a key Apple stops taking mid-run sets APNs aside: nothing is recorded as sent', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [
          { key: K1, token: T1, userId: 'u1' },
          { key: K2, token: T2, userId: 'u1' },
        ],
        alerts: [MEETING, MONEY],
      },
    ]);
    const apns = await startApns((token) =>
      token === CHECK ? undefined : { status: 403, body: { reason: 'InvalidProviderToken' } },
    );
    try {
      const run = await runSender(apnsEnv(app, apns));
      expect(run.out).toContain(
        '::error::APNs refused the key or setup on a send (HTTP 403 InvalidProviderToken)',
      );
      // One refusal is enough: nothing more goes to Apple this run.
      expect(sendsOf(apns)).toHaveLength(1);
      expect(app.reports).toEqual([]);
      expect(run.code).toBe(1);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('a token that is not for this app is forgotten, and the other iPhones still get the alert', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [
          // Listed first, as a row that never checks in again would be.
          { key: K3, token: T3, userId: 'u2' },
          { key: K1, token: T1, userId: 'u1' },
          { key: K2, token: T2, userId: 'u1' },
        ],
        alerts: [MEETING, MONEY],
      },
    ]);
    const apns = await startApns((token) =>
      token === T3 ? { status: 400, body: { reason: 'DeviceTokenNotForTopic' } } : undefined,
    );
    try {
      const run = await runSender(apnsEnv(app, apns));
      expect(run.code, run.out).toBe(0);
      expect(run.out).toContain("::warning::APNs: an iPhone's token is not for vc.tiptop.copilot");
      expect(run.out).not.toContain('::error::');
      // T3 is tried once; T1 and T2 get both alerts in the same pass.
      expect(sendsOf(apns).map((r) => r.headers[':path'])).toEqual([
        `/3/device/${T3}`,
        `/3/device/${T1}`,
        `/3/device/${T2}`,
        `/3/device/${T1}`,
        `/3/device/${T2}`,
      ]);
      expect(app.reports).toEqual([
        {
          organizationId: 'org-fictional',
          sent: [...MEETING.keys, ...MONEY.keys],
          gone: [],
          goneApns: [{ key: K3 }],
        },
      ]);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('Apple not answering: no more tries that pass, and the next asks with fallback=1 until Apple answers', async () => {
    const app = await startApp([
      {
        organizationId: 'org-fictional',
        subscriptions: [],
        apns: [
          { key: K1, token: T1, userId: 'u1' },
          { key: K2, token: T2, userId: 'u1' },
        ],
        alerts: [MONEY],
      },
    ]);
    // T1: Apple's side failing, then no answer at all, then delivered.
    const apns = await startApns((token, attempt) =>
      token !== T1
        ? undefined
        : attempt === 1
          ? { status: 503, body: { reason: 'ServiceUnavailable' } }
          : attempt === 2
            ? 'reset'
            : { status: 200 },
    );
    try {
      const run = await runSender(
        apnsEnv(app, apns, {
          LOOP_MAX_MINUTES: '0.07',
          PASS_EVERY_MS: '250',
          LOOP_FROM_HOUR: '0',
          LOOP_UNTIL_HOUR: '24',
        }),
      );
      expect(run.code, run.out).toBe(0);
      expect(run.out).toContain('::warning::APNs is not answering (HTTP 503 ServiceUnavailable)');
      expect(run.out).toContain('::warning::APNs is not answering (no answer)');
      expect(app.queries.length, run.out).toBeGreaterThanOrEqual(4);
      expect(app.queries.slice(0, 4)).toEqual([
        '/api/cron/push?scope=all&apns=1',
        // Still tried, but holding back nobody's web push.
        '/api/cron/push?scope=meetings&apns=1&fallback=1',
        '/api/cron/push?scope=meetings&apns=1&fallback=1',
        // Delivered on the third pass, so back to holding web push back.
        '/api/cron/push?scope=meetings&apns=1',
      ]);
      // One check for the whole run. After each failure the pass stopped, so
      // T2 was first tried on the pass where T1 got through.
      expect(apns.requests.filter(isCheck)).toHaveLength(1);
      expect(
        sendsOf(apns)
          .slice(0, 4)
          .map((r) => r.headers[':path']),
      ).toEqual([`/3/device/${T1}`, `/3/device/${T1}`, `/3/device/${T1}`, `/3/device/${T2}`]);
      expect(app.reports[0]).toEqual({
        organizationId: 'org-fictional',
        sent: MONEY.keys,
        gone: [],
        goneApns: [],
      });
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('no answer at the key check: nothing held back, and checked again next pass', async () => {
    const app = await startApp([]);
    const apns = await startApns((token) => (token === CHECK ? { status: 503 } : undefined));
    try {
      const run = await runSender(apnsEnv(app, apns));
      expect(run.code, run.out).toBe(0);
      expect(run.out).toContain('apns key check: HTTP 503; trying again next pass.');
      expect(app.queries).toEqual(['/api/cron/push?scope=all']);
    } finally {
      await app.close();
      await apns.close();
    }
  });

  it('a key with no id or team is never used, and the app is not asked for tokens', async () => {
    const app = await startApp([]);
    const apns = await startApns(() => ({ status: 200 }));
    try {
      const run = await runSender(apnsEnv(app, apns, { APNS_KEY_ID: '' }));
      expect(run.out).toContain('::error::APNS_KEY_P8 is set but APNS_KEY_ID or APPLE_TEAM_ID');
      expect(app.queries).toEqual(['/api/cron/push?scope=all']);
      expect(apns.requests).toEqual([]);
      const garbled = await runSender(apnsEnv(app, apns, { APNS_KEY_P8: 'not a key' }));
      expect(garbled.out).toContain('::error::APNS_KEY_P8 could not be read');
      expect(garbled.out).not.toContain('not a key.');
    } finally {
      await app.close();
      await apns.close();
    }
  });
});
