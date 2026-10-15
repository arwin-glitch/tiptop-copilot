import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';

/**
 * Next bundles route handlers apart from pages, and each bundle has its own
 * copy of lib/runtime. With the demo store held in that module, an Affinity
 * import sent to /api/crm/import went into one in-memory database and the
 * Lists pages read another — the import vanished until the server restarted.
 * A fresh copy of the module (vi.resetModules) stands in for the other bundle.
 */

const SAVED = { ...process.env };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'copilot-demo-store-'));
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_DATA_DIR = dir;
  resetEnvCache();
});

afterEach(async () => {
  (await import('@/lib/runtime')).resetRuntime();
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  vi.resetModules();
  await rm(dir, { recursive: true, force: true });
});

describe('the demo store', () => {
  it('is one store per process, whichever copy of the runtime asks for it', async () => {
    const pages = await import('@/lib/runtime');
    const store = pages.getStore();
    expect(store.kind).toBe('demo');

    vi.resetModules();
    const routes = await import('@/lib/runtime');
    expect(routes).not.toBe(pages);
    expect(routes.getStore()).toBe(store);
  });

  it('starts afresh after a reset', async () => {
    const runtime = await import('@/lib/runtime');
    const first = runtime.getStore();
    runtime.resetRuntime();
    expect(runtime.getStore()).not.toBe(first);
  });
});
