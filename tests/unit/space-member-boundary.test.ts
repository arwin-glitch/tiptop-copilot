import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The data boundary of a member's own Google for Spaces (D-081), read from
 * the source. A member connection (provider 'google_space') is read by
 * lib/services/space-member-mail.ts alone; what it reads reaches the Space's
 * own pages through space-content.ts and nothing else: never the Inbox,
 * Today, Follow-ups, Tasks, Ask Arwin, digests, routines or search. Every
 * other reader of the integrations table reads the main mailbox
 * (provider 'google') only, so a member's row can never stand in for it.
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

const find = (rel: string) => SOURCES.find((s) => s.rel === rel)!.text;
const importing = (module: string) =>
  SOURCES.filter((s) => new RegExp(`from ['"][^'"]*${module}['"]`).test(s.text))
    .map((s) => s.rel)
    .sort();

describe("a member's own Google for Spaces", () => {
  it('names the member provider in the type, the one reader and the demo fixture only', () => {
    const naming = SOURCES.filter((s) => /google_space/.test(s.text))
      .map((s) => s.rel)
      .sort();
    expect(naming).toEqual([
      'lib/demo/space-member-fixtures.ts',
      'lib/services/space-member-mail.ts',
      'lib/types/domain.ts',
    ]);
    expect(SOURCES.filter((s) => /\bMEMBER_PROVIDER\b/.test(s.text)).map((s) => s.rel)).toEqual([
      'lib/services/space-member-mail.ts',
    ]);
  });

  it('is read by one module, reached only from Spaces, the OAuth callback and Settings', () => {
    expect(importing('space-member-mail')).toEqual([
      'app/(app)/settings/page.tsx',
      'app/actions/spaces.ts',
      'app/api/integrations/google/callback/route.ts',
      'lib/services/space-content.ts',
      'lib/services/spaces.ts',
    ]);
    // Settings shows your own connection (no token, no mail); the callback
    // stores it; the action disconnects it. None of them reads mail.
    const uses = (rel: string) =>
      [...find(rel).matchAll(/import \{([^}]*)\} from '@\/lib\/services\/space-member-mail'/g)]
        .flatMap((m) => m[1]!.split(','))
        .map((n) => n.trim())
        .filter(Boolean)
        .sort();
    expect(uses('app/(app)/settings/page.tsx')).toEqual(['myMemberConnection']);
    expect(uses('app/api/integrations/google/callback/route.ts')).toEqual(['saveMemberConnection']);
    expect(uses('app/actions/spaces.ts')).toEqual(['disconnectMemberConnection']);
    expect(importing('space-member-fixtures')).toEqual([
      'lib/demo/fixtures.ts',
      'lib/services/space-member-mail.ts',
    ]);
  });

  it('what it reads reaches the Space pages, Space actions and Space Ask, nothing else', () => {
    expect(importing('services/space-content')).toEqual([
      'app/(app)/spaces/[id]/email/page.tsx',
      'app/(app)/spaces/[id]/page.tsx',
      'app/(app)/spaces/page.tsx',
      'app/actions/spaces.ts',
    ]);
    // space-ask imports it relatively, beside it.
    expect(find('lib/services/space-ask.ts')).toMatch(/from '\.\/space-content'/);
    const relative = SOURCES.filter((s) => /from '\.\/space-content'/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(relative).toEqual(['lib/services/space-ask.ts']);
    expect(importing('services/space-ask')).toEqual(['app/actions/spaces.ts']);
    // The readers of members' items are called from the Space's own code only.
    const callers = SOURCES.filter((s) =>
      /\b(spaceItems|spaceEmailPage|spaceMemberEmail|memberThreads|memberMeetings|readMemberThread)\(/.test(
        s.text,
      ),
    )
      .map((s) => s.rel)
      .sort();
    expect(callers).toEqual([
      'app/(app)/spaces/[id]/email/page.tsx',
      'app/(app)/spaces/[id]/page.tsx',
      'lib/services/space-ask.ts',
      'lib/services/space-content.ts',
      'lib/services/space-member-mail.ts',
    ]);
  });

  it('never writes: every Google call in the reader is a read', () => {
    const reader = find('lib/services/space-member-mail.ts');
    expect(reader).not.toMatch(/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/);
    expect(reader).not.toMatch(/gmail-send|gmail-filters|calendar\/write|modifyThread|sendMessage/);
    expect(reader).not.toMatch(/store\.(insert|upsert|update)\('(email_|calendar_|tasks)/);
    // Its own rows only: the primary is read (to refuse its account), never written.
    expect(reader).not.toMatch(/store\.(update|remove)\('integrations'[^)]*primary/);
  });

  it('every other integrations read is the main mailbox (provider google) alone', () => {
    const reads = SOURCES.filter((s) => s.rel !== 'lib/services/space-member-mail.ts').flatMap(
      (s) =>
        [...s.text.matchAll(/store\.(list|findOne)\(\s*'integrations',([\s\S]{0,160})/g)].map(
          (m) => ({ rel: s.rel, call: m[2]! }),
        ),
    );
    expect(reads.length).toBeGreaterThan(5);
    const unfiltered = reads.filter((r) => !/provider: 'google'/.test(r.call)).map((r) => r.rel);
    // relationships.ts reads every row and keeps the main mailbox's after.
    expect(unfiltered).toEqual(['lib/services/relationships.ts']);
    expect(find('lib/services/relationships.ts')).toMatch(/i\.provider === 'google'/);
  });

  it('a member connection asks Google for the read-only scopes alone', () => {
    const oauth = find('lib/google/oauth.ts');
    expect(oauth).toMatch(/scope: MEMBER_READ_SCOPES\.join\(' '\)/);
    expect(oauth).toMatch(/include_granted_scopes: 'false'/);
    const start = find('app/api/integrations/google/start/route.ts');
    expect(start).toMatch(/member \? \{ member: true \} : \{ send, calendar, filters \}/);
    const callback = find('app/api/integrations/google/callback/route.ts');
    // The member branch returns before the primary is touched.
    const member = callback.indexOf('if (parsed.member === true)');
    const primary = callback.indexOf('getPrimaryIntegration(store');
    expect(member).toBeGreaterThan(0);
    expect(primary).toBeGreaterThan(member);
  });

  it('the migration keeps member rows read-only and own-row only', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261107000000_space_member_google.sql'),
      'utf8',
    );
    expect(sql).toMatch(/alter type integration_provider add value if not exists 'google_space'/);
    expect(sql).toMatch(/drop constraint if exists integrations_member_read_only/);
    expect(sql).toMatch(/add constraint integrations_member_read_only check/);
    expect(sql).toMatch(/provider::text <> 'google_space' or user_id = auth\.uid\(\)/);
    expect(sql).not.toMatch(/gmail\.modify|gmail\.send|calendar\.events|settings\.basic/);
    expect(sql).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    // The new value is never used as an enum literal in the same transaction.
    expect(sql).not.toMatch(/=\s*'google_space'/);
  });
});
