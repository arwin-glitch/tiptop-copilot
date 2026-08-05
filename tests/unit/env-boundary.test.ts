import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityReport, env, envLimits, resetEnvCache } from '@/lib/config/env';

/**
 * The secret boundary.
 *
 * Two things are checked here, and both are the sort of mistake that is
 * invisible until it is on the public internet:
 *   1. No client component reaches a module that reads secrets.
 *   2. The diagnostics screen reports *presence*, never a value.
 */

const SRC = path.resolve(import.meta.dirname, '../../src');

const SAVED = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Modules that read secrets and are therefore marked `server-only`. */
const SERVER_ONLY_IMPORTS = [
  '@/lib/config/env',
  '@/lib/security/crypto',
  '@/lib/security/limits',
  '@/lib/runtime',
  '@/lib/google/oauth',
  '@/lib/db/supabase-store',
  '@/lib/email/gmail',
];

describe('no secret is reachable from a client component', () => {
  it("marks every secret-reading module 'server-only'", async () => {
    for (const specifier of SERVER_ONLY_IMPORTS) {
      const file = path.join(SRC, `${specifier.replace('@/', '')}.ts`);
      const source = await readFile(file, 'utf8');
      expect(source, `${specifier} must import 'server-only'`).toMatch(/^import 'server-only';/m);
    }
  });

  it("no 'use client' file imports a server-only module", async () => {
    const files = await walk(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(source)) continue;
      for (const specifier of SERVER_ONLY_IMPORTS) {
        if (new RegExp(`from '${specifier}'`).test(source)) {
          offenders.push(`${path.relative(SRC, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no 'use client' file reads process.env beyond a public variable", async () => {
    // NODE_ENV is inlined by the bundler and carries no secret; everything
    // else a client component may read has to be explicitly NEXT_PUBLIC_.
    const PUBLIC = new Set(['NODE_ENV']);
    const files = await walk(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(source)) continue;
      for (const match of source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
        const name = match[1] ?? '';
        if (!name.startsWith('NEXT_PUBLIC_') && !PUBLIC.has(name)) {
          offenders.push(`${path.relative(SRC, file)} -> ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never names a secret variable in a NEXT_PUBLIC_ form', async () => {
    const source = await readFile(path.join(SRC, 'lib/config/env.ts'), 'utf8');
    for (const secret of [
      'SESSION_SECRET',
      'APP_ENCRYPTION_KEY',
      'ANTHROPIC_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'GOOGLE_CLIENT_SECRET',
      'RESEARCH_API_KEY',
      'CRON_SECRET',
    ]) {
      expect(source).not.toContain(`NEXT_PUBLIC_${secret}`);
    }
  });
});

describe('capabilityReport', () => {
  it('reports presence and never echoes a value', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-super-secret-value';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret-value';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret-value';
    process.env.CRON_SECRET = 'cron-secret-value';
    resetEnvCache();

    const serialised = JSON.stringify(capabilityReport());
    for (const value of [
      'sk-ant-super-secret-value',
      'google-secret-value',
      'service-role-secret-value',
      'cron-secret-value',
      process.env.APP_ENCRYPTION_KEY,
      process.env.SESSION_SECRET,
    ]) {
      expect(serialised).not.toContain(value);
    }
  });

  it('lists the variable names an operator has to set', () => {
    const report = capabilityReport();
    const names = report.flatMap((c) => c.variables);
    for (const expected of [
      'SESSION_SECRET',
      'APP_ENCRYPTION_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_CLIENT_ID',
      'CRON_SECRET',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("reports 'demo' rather than 'missing' when demo mode covers the gap", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.DEMO_MODE = 'true';
    resetEnvCache();

    const anthropic = capabilityReport().find((c) => c.key === 'anthropic');
    expect(anthropic?.status).toBe('demo');
  });

  it("reports 'missing' for a required capability outside demo mode", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.DEMO_MODE = 'false';
    resetEnvCache();

    const anthropic = capabilityReport().find((c) => c.key === 'anthropic');
    expect(anthropic?.status).toBe('missing');
    expect(anthropic?.required).toBe(true);
  });

  it('rejects an encryption key of the wrong length', () => {
    process.env.DEMO_MODE = 'false';
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    resetEnvCache();

    expect(capabilityReport().find((c) => c.key === 'encryption')?.status).toBe('missing');
  });
});

describe('env()', () => {
  it('treats an empty string as unset rather than as a configured value', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    resetEnvCache();
    expect(env().anthropicApiKey).toBeUndefined();
  });

  it('takes model ids from the environment with documented defaults', () => {
    delete process.env.AI_MODEL_FAST;
    delete process.env.AI_MODEL_DEEP;
    resetEnvCache();
    expect(env().modelFast).toBe('claude-haiku-4-5');
    expect(env().modelDeep).toBe('claude-opus-5');

    process.env.AI_MODEL_DEEP = 'claude-sonnet-5';
    resetEnvCache();
    expect(env().modelDeep).toBe('claude-sonnet-5');
  });

  it('falls back to a safe effort level when given nonsense', () => {
    process.env.AI_EFFORT_DEEP = 'turbo';
    resetEnvCache();
    expect(env().aiEffortDeep).toBe('high');
  });

  it("defaults the research provider to 'none' rather than guessing", () => {
    process.env.RESEARCH_PROVIDER = 'wikipedia';
    resetEnvCache();
    expect(env().researchProvider).toBe('none');
  });

  it('derives the Google redirect URI from APP_URL when not set explicitly', () => {
    delete process.env.GOOGLE_REDIRECT_URI;
    process.env.APP_URL = 'https://copilot.tiptop.test';
    resetEnvCache();
    expect(env().googleRedirectUri).toBe(
      'https://copilot.tiptop.test/api/integrations/google/callback',
    );
  });
});

describe('envLimits()', () => {
  it('falls back to defaults when a value is not a number', () => {
    process.env.MAX_EMAILS_PER_SYNC = 'lots';
    resetEnvCache();
    expect(envLimits().maxEmailsPerSync).toBe(250);
  });

  it('reads the ceilings an operator can lower', () => {
    process.env.MAX_ATTACHMENT_PAGES = '10';
    process.env.DAILY_AI_BUDGET_USD = '5.50';
    resetEnvCache();
    expect(envLimits().maxAttachmentPages).toBe(10);
    expect(envLimits().dailyAiBudgetUsd).toBe(5.5);
  });
});
