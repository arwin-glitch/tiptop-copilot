import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_ATTACHMENTS } from '@/lib/demo/attachment-fixtures';

/** The demo's fictional attachments, for the preview overlay: served without Gmail. */

let harness: Harness;
vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: true },
    integration: null,
  }),
}));
const route = await import('@/app/api/inbox/attachment/route');

beforeEach(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  await harness.dispose();
});

describe('demo attachments', () => {
  it('serves the fictional PDF and PNG inline, and nothing else', async () => {
    for (const file of DEMO_ATTACHMENTS) {
      const res = await route.GET(
        new NextRequest(
          `http://localhost/api/inbox/attachment?m=d0e0f0000000000200&a=${file.id}&name=${file.name}&type=${encodeURIComponent(file.mimeType)}`,
        ),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(file.mimeType);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const head = String.fromCharCode(...bytes.slice(1, 4));
      expect(head).toBe(file.mimeType === 'application/pdf' ? 'PDF' : 'PNG');
    }
    const missing = await route.GET(
      new NextRequest(
        'http://localhost/api/inbox/attachment?m=d0e0f0000000000200&a=demo-att-unknown1',
      ),
    );
    expect(missing.status).toBe(404);
  });
});
