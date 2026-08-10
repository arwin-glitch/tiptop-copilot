import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import { getAI, resetRuntime } from '@/lib/runtime';

/**
 * Which AI provider serves a given environment.
 *
 * This exists because of one specific hazard: the mock produces fluent,
 * evidence-shaped analysis, and for a long time it was selected whenever the
 * API key was absent — including with `DEMO_MODE` off. That configuration is
 * exactly the one a first real deployment lands in, and it would have written
 * a plausible scorecard for a real company from a stub.
 *
 * The rule these tests lock down: the mock is reachable in demo mode and
 * nowhere else. Real data with no key refuses.
 */

const SAVED = { ...process.env };

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  resetRuntime();
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
  resetRuntime();
});

describe('AI provider selection', () => {
  it('uses the deterministic stub in demo mode', () => {
    setEnv({ DEMO_MODE: 'true', ANTHROPIC_API_KEY: undefined });
    const ai = getAI();
    expect(ai.kind).toBe('mock');
    expect(ai.available()).toBe(true);
  });

  it('still uses the stub in demo mode even when a key is present', () => {
    // Demo data is fictional; spending real tokens on it would be pointless
    // and would make "no external calls" untrue.
    setEnv({ DEMO_MODE: 'true', ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' });
    expect(getAI().kind).toBe('mock');
  });

  it('refuses rather than fabricating when live and unkeyed', () => {
    setEnv({ DEMO_MODE: 'false', ANTHROPIC_API_KEY: undefined });
    const ai = getAI();
    expect(ai.kind).toBe('none');
    expect(ai.available()).toBe(false);
  });

  it('never serves the mock over real data', () => {
    setEnv({ DEMO_MODE: undefined, ANTHROPIC_API_KEY: undefined });
    expect(getAI().kind).not.toBe('mock');
  });

  it('reports not_configured with what still works, rather than throwing', async () => {
    setEnv({ DEMO_MODE: 'false', ANTHROPIC_API_KEY: undefined });
    const ai = getAI();

    const structured = await ai.generateStructured({} as never);
    expect(structured.ok).toBe(false);
    if (!structured.ok) {
      expect(structured.error.code).toBe('not_configured');
      // Degraded-state UI leans on this: the point is to say what is still
      // usable, not just that something failed.
      expect(structured.error.stillUsable).toMatch(/email, calendar, deals/i);
    }

    const text = await ai.generateText({} as never);
    expect(text.ok).toBe(false);

    const tools = await ai.runToolConversation({} as never);
    expect(tools.ok).toBe(false);
  });

  it('uses the real provider once a key is present', () => {
    setEnv({ DEMO_MODE: 'false', ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' });
    expect(getAI().kind).toBe('anthropic');
  });
});
