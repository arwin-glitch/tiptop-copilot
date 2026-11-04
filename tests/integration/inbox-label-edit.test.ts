import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import { demoLabelList, resetInboxLiveCache } from '@/lib/services/inbox-live';
import type { Integration } from '@/lib/types/domain';
import { ok } from '@/lib/util/result';

/**
 * The nav label menu's Label color, Edit and Remove label
 * (/api/inbox/labels PATCH and DELETE), and Add sublabel (POST). The demo
 * keeps its labels in this process; against Gmail the label writes are
 * stubbed, so the test sees exactly what would be sent.
 */

let harness: Harness;
let live = false;

const INTEGRATION: Integration = {
  id: '33333333-3333-4333-8333-333333333333',
  organization_id: DEMO_IDS.org,
  user_id: DEMO_IDS.user,
  provider: 'google',
  kinds: ['gmail'],
  account_email: 'partner@firm.example',
  scopes: [...SEND_SCOPES],
  status: 'connected',
  status_detail: null,
  last_sync_at: null,
  last_sync_error: null,
  sync_cursor: null,
  watch_expires_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const updateLabel = vi.fn(async (..._args: unknown[]) => ok({ id: 'Label_7201', name: 'x' }));
const deleteLabel = vi.fn(async (..._args: unknown[]) => ok(true as const));

vi.mock('@/lib/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/env')>();
  return { ...actual, isDemoMode: () => !live && actual.isDemoMode() };
});
vi.mock('@/lib/google/gmail-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-send')>()),
  updateLabel: (...args: unknown[]) => updateLabel(...args),
  deleteLabel: (...args: unknown[]) => deleteLabel(...args),
}));
vi.mock('@/lib/google/gmail-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/gmail-inbox')>()),
  readLabelDirectory: async () => ({
    names: new Map([
      ['INBOX', 'INBOX'],
      ['Label_7201', 'Clients'],
      ['Label_7202', 'Clients/Active'],
    ]),
    colors: new Map(),
  }),
}));
vi.mock('@/lib/services/email-session-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/email-session-auth')>()),
  sessionAuth: async () => ({
    ok: true,
    auth: { ...harness.auth, isDemo: !live },
    integration: live ? INTEGRATION : null,
  }),
}));

const route = await import('@/app/api/inbox/labels/route');
const req = (method: string, body?: unknown, query = '') =>
  new NextRequest(`http://localhost/api/inbox/labels${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(async () => {
  live = false;
  updateLabel.mockClear();
  deleteLabel.mockClear();
  resetInboxLiveCache();
  harness = await createHarness();
});
afterEach(async () => {
  await harness.dispose();
});

describe('label menu in the demo', () => {
  it('adds a sublabel, renames a parent with its sublabels, recolours and removes', async () => {
    const parent = demoLabelList().find((l) => l.name === 'Deal flow')!;
    const made = await (await route.POST(req('POST', { name: 'Deal flow/Seed' }))).json();
    expect(made.label.name).toBe('Deal flow/Seed');

    const renamed = await route.PATCH(req('PATCH', { id: parent.id, name: 'Pipeline' }));
    expect(renamed.status).toBe(200);
    const names = demoLabelList().map((l) => l.name);
    expect(names).toContain('Pipeline');
    expect(names).toContain('Pipeline/Seed');
    expect(names).toContain('Pipeline/Intro requests');
    expect(names).not.toContain('Deal flow');

    const coloured = await route.PATCH(
      req('PATCH', { id: parent.id, color: { bg: '#16a766', fg: '#ffffff' } }),
    );
    expect(coloured.status).toBe(200);
    expect(demoLabelList().find((l) => l.id === parent.id)!.color).toEqual({
      bg: '#16a766',
      fg: '#ffffff',
    });

    expect((await route.DELETE(req('DELETE', undefined, `?id=${parent.id}`))).status).toBe(200);
    expect(demoLabelList().some((l) => l.id === parent.id)).toBe(false);
    expect(updateLabel).not.toHaveBeenCalled();
    expect(deleteLabel).not.toHaveBeenCalled();
  });

  it("refuses a colour outside Gmail's palette, a system label, and an empty change", async () => {
    const id = demoLabelList()[0]!.id;
    expect(
      (await route.PATCH(req('PATCH', { id, color: { bg: '#123456', fg: '#ffffff' } }))).status,
    ).toBe(400);
    expect((await route.PATCH(req('PATCH', { id: 'INBOX', name: 'x' }))).status).toBe(400);
    expect((await route.PATCH(req('PATCH', { id }))).status).toBe(400);
    expect((await route.DELETE(req('DELETE', undefined, '?id=TRASH'))).status).toBe(400);
  });
});

describe('label menu against Gmail', () => {
  it('a rename carries the sublabels; remove calls labels.delete once', async () => {
    live = true;
    const res = await route.PATCH(req('PATCH', { id: 'Label_7201', name: 'Customers' }));
    expect(res.status).toBe(200);
    expect(updateLabel.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['Label_7201', { name: 'Customers', color: undefined }],
      ['Label_7202', { name: 'Customers/Active' }],
    ]);
    expect((await route.DELETE(req('DELETE', undefined, '?id=Label_7201'))).status).toBe(200);
    expect(deleteLabel).toHaveBeenCalledTimes(1);
    expect((await route.DELETE(req('DELETE', undefined, '?id=Label_9999'))).status).toBe(404);
  });
});
