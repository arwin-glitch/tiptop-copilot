import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '@/proxy';

/**
 * The proxy's part in Copilot Notes (D-076): the recorder may ask for the
 * microphone and the meeting's audio on Copilot's own pages (and only from
 * Copilot's own origin), never on the pages outsiders open; the vendors'
 * sockets are allowed; and a shared note's page is public, unindexed and
 * uncached.
 */

const ORIGIN = 'http://localhost:3000';
const SESSION = { cookie: 'tiptop_demo_session=x' };

async function headersFor(path: string, signedIn = true) {
  const response = await proxy(
    new NextRequest(`${ORIGIN}${path}`, { headers: signedIn ? SESSION : {} }),
  );
  return { status: response.status, headers: response.headers };
}

describe('microphone and screen capture', () => {
  it("are allowed for Copilot's own origin on its pages", async () => {
    for (const path of ['/meetings/abc', '/today', '/calendar']) {
      const policy = (await headersFor(path)).headers.get('permissions-policy') ?? '';
      expect(policy, path).toContain('microphone=(self)');
      expect(policy, path).toContain('display-capture=(self)');
      expect(policy, path).toContain('camera=()');
    }
  });

  it('stay off on pages outsiders open', async () => {
    for (const path of ['/n/abcdefghijklmnopqrstuvwxyz012345', '/meet/nick', '/t/o/x']) {
      const policy = (await headersFor(path, false)).headers.get('permissions-policy') ?? '';
      expect(policy, path).toContain('microphone=()');
      expect(policy, path).toContain('display-capture=()');
    }
  });

  it("let the recorder reach the speech vendors' sockets", async () => {
    const csp = (await headersFor('/meetings/abc')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain('wss://*.rt.speechmatics.com');
    expect(csp).toContain('wss://streaming.assemblyai.com');
  });
});

describe('the shared-note page', () => {
  it('is public, never indexed, never cached, and sends no referrer', async () => {
    const { status, headers } = await headersFor('/n/abcdefghijklmnopqrstuvwxyz012345', false);
    expect(status).toBe(200);
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('opens nothing else: the notes API and the meetings pages stay signed in', async () => {
    expect((await headersFor('/api/notes/meetings', false)).status).toBe(401);
    expect((await headersFor('/meetings/abc', false)).status).toBe(307);
    expect((await headersFor('/notes', false)).status).toBe(307);
  });
});
