import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Zero spend, read from the source (D-078): the booking page assistant never
 * reaches a paid model. Walking every runtime import from its modules, its
 * routes and its widgets, no path reaches the Anthropic SDK or the app's AI
 * layer (lib/ai), and none of its own files names an API key, the model
 * client or the usage ledger. The walk stops at lib/runtime.ts, the app's
 * dependency root, which the routes import for `getStore` alone (it builds
 * every provider, the AI one included, so following it would say nothing
 * about this code); a second check pins that the assistant's files take only
 * `getStore` from it.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const ENTRIES = [
  'src/lib/booking/chat.ts',
  'src/lib/booking/chat-bridge.ts',
  'src/lib/booking/chatbot-config.ts',
  'src/lib/booking/faq.ts',
  'src/app/api/meet/[slug]/chat/route.ts',
  'src/app/api/meet/[slug]/chat/answer/route.ts',
  'src/app/api/booking/chatbot/route.ts',
  'src/components/booking/booking-chat.tsx',
  'src/components/booking/chatbot-panel.tsx',
];

const STOP = new Set(['src/lib/runtime.ts']);

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

function resolveFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime imports of one file: `import type` and `export type` are erased and skipped. */
function runtimeSpecifiers(text: string): string[] {
  const out: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(statement)) {
    if (m[2]) continue;
    out.push(m[4]!);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function walk(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = ENTRIES.map((e) => join(ROOT, e));
  while (queue.length) {
    const file = queue.pop()!;
    const key = rel(file);
    if (files.has(key)) continue;
    files.add(key);
    if (STOP.has(key)) continue;
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      let target: string | null = null;
      if (spec.startsWith('@/')) target = resolveFile(join(SRC, spec.slice(2)));
      else if (spec.startsWith('.')) target = resolveFile(join(dirname(file), spec));
      else {
        packages.add(spec);
        continue;
      }
      if (target) queue.push(target);
    }
  }
  return { files, packages };
}

describe('the booking page assistant spends nothing', () => {
  const { files, packages } = walk();

  it('walks a real graph', () => {
    for (const entry of ENTRIES) expect(files.has(entry), entry).toBe(true);
    expect(files.size).toBeGreaterThan(ENTRIES.length);
  });

  it('reaches neither the Anthropic SDK nor the app’s model client', () => {
    expect([...packages].filter((p) => p.startsWith('@anthropic-ai'))).toEqual([]);
    // The shared services the booking link reads (the host's zone, the
    // inbox's helpers) pull in two plain data modules from lib/ai: zod
    // shapes and prompt text. Neither calls anything; the client, the
    // providers and the tool runner are never reached.
    const DATA_ONLY = new Set(['src/lib/ai/schemas.ts', 'src/lib/ai/prompts/index.ts']);
    expect([...files].filter((f) => f.startsWith('src/lib/ai/') && !DATA_ONLY.has(f))).toEqual([]);
    for (const data of DATA_ONLY) {
      if (!files.has(data)) continue;
      const imports = runtimeSpecifiers(readFileSync(join(ROOT, data), 'utf8'));
      expect(
        imports.filter((s) => /anthropic|\/ai\/(?!schemas|prompts)/.test(s)),
        data,
      ).toEqual([]);
    }
    expect(files.has('src/lib/services/chat.ts')).toBe(false);
  });

  it('names no API key, model client or usage ledger in its own files', () => {
    for (const entry of ENTRIES) {
      const text = readFileSync(join(ROOT, entry), 'utf8');
      expect(text, entry).not.toMatch(
        /ANTHROPIC_API_KEY|anthropicApiKey|getAI\(|runToolConversation|recordAiUsage|ai_usage|monthlyAiCapUsd/,
      );
    }
  });

  it('takes only getStore from the dependency root', () => {
    for (const entry of ENTRIES) {
      const text = readFileSync(join(ROOT, entry), 'utf8');
      for (const m of text.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"]@\/lib\/runtime['"]/g)) {
        expect(
          m[1]!
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          entry,
        ).toEqual(['getStore']);
      }
    }
  });
});

describe('the assistant never says a person confirms', () => {
  it('has no such copy in its widget, its server answers or its panel', () => {
    for (const entry of ENTRIES) {
      const text = readFileSync(join(ROOT, entry), 'utf8')
        // Comments and the sanitiser's own patterns may name the phrase.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/const (CONFIRM_WORD|PROMISE_WORD)[\s\S]*?;\n/g, '');
      expect(text, entry).not.toMatch(
        /will confirm|confirms by email|until (?:arwin|nick|someone) confirms|someone will review|we'll review|Arwin will reply/i,
      );
    }
  });
});
