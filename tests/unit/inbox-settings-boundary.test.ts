import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where Gmail's own settings (the signature, the vacation responder) can be
 * changed, read from the source: the module that writes them is reached only
 * from the Inbox settings service, and that only from its two routes (a
 * person's Save click). No AI tool, routine, cron job or relay names either,
 * and the module never touches forwarding.
 */

const SRC = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const SOURCES = files(SRC).map((file) => ({
  rel: relative(SRC, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

const importers = (pattern: RegExp) =>
  SOURCES.filter((s) => pattern.test(s.text))
    .map((s) => s.rel)
    .sort();

describe('Gmail settings', () => {
  it('only the settings service reaches the module that writes them', () => {
    expect(importers(/from ['"][^'"]*google\/gmail-settings['"]/)).toEqual([
      'lib/services/inbox-settings.ts',
    ]);
  });

  it("only the Inbox's settings routes reach the service", () => {
    const routes = importers(/from ['"][^'"]*services\/inbox-settings['"]/);
    expect(routes.every((r) => /^app\/api\/inbox\/(signature|vacation)\/route\.ts$/.test(r))).toBe(
      true,
    );
    expect(routes).toContain('app/api/inbox/signature/route.ts');
  });

  it('never touches forwarding, delegates or other send-as fields', () => {
    const text = SOURCES.find((s) => s.rel === 'lib/google/gmail-settings.ts')!.text;
    expect(text).not.toMatch(/\/(autoForwarding|forwardingAddresses|delegates|imap|pop)\b/);
    // The signature write sends the signature field alone.
    expect(text).toMatch(/body: JSON\.stringify\(\{ signature: clean \}\)/);
  });
});
