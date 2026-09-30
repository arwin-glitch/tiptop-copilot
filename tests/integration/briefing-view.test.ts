import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { resetEnvCache } from '@/lib/config/env';
import { resetBriefingHtmlCache } from '@/lib/briefing/html-relay';
import { ok } from '@/lib/util/result';

let harness: Harness;
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => ok(harness.auth),
}));

const { GET } = await import('@/app/api/briefings/[kind]/view/route');
const SAVED = { ...process.env };

const PAGE = `<!doctype html><html><head><style>.hero{color:#18c37e}</style></head>
<body><h1 class="hero">Wednesday, Sep 30</h1><script>document.body.innerHTML='pwned'</script></body></html>`;

function relayMessages(dateKey: string) {
  const b64 = gzipSync(PAGE).toString('base64');
  const pieces = b64.match(/.{1,60}/g)!;
  return pieces
    .map((gz_b64, i) => ({
      ts: `1790700000.00${i}`,
      text: `BRIEFING_HTML_V1\n\`${JSON.stringify({
        kind: 'morning',
        date_key: dateKey,
        run: 'run-1',
        part: i + 1,
        parts: pieces.length,
        gz_b64,
      })}\``,
    }))
    .reverse();
}

function call(kind: string) {
  return GET(new Request(`https://tiptop-copilot.onrender.com/api/briefings/${kind}/view`), {
    params: Promise.resolve({ kind }),
  });
}

beforeEach(async () => {
  harness = await createHarness();
  resetBriefingHtmlCache();
  process.env.ASK_RELAY_SLACK_TOKEN = 'xoxb-test';
  resetEnvCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.dispose();
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe('GET /api/briefings/[kind]/view', () => {
  it('serves the relayed page sandboxed, without its scripts, with the print bar', async () => {
    const card = await harness.store.findOne('routine_briefings', harness.auth.organizationId, {
      eq: { kind: 'morning' },
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, messages: relayMessages(card!.date_key) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await call('morning');
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^sandbox allow-scripts allow-modals/);
    expect(csp).not.toContain('allow-same-origin');
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];

    const body = await response.text();
    expect(body).toContain('<h1 class="hero">Wednesday, Sep 30</h1>');
    expect(body).not.toContain('pwned');
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain('Save as PDF');
  });

  it('falls back to the text PDF when no page was relayed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, messages: [] })),
    );
    const response = await call('dossier');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/\/api\/briefings\/dossier\/pdf$/);
  });

  it('rejects an unknown kind', async () => {
    expect((await call('weekly')).status).toBe(404);
  });
});
