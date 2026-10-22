import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where `organization_members` is read, from the source. The table is
 * scopeless (store.ts): the organization id a store read takes does not
 * filter it, so a read with no filter of its own returns every
 * organization's members. Three did, and each picked "the owner" or a
 * membership from the whole table (D-071). Every read goes through
 * listOrganizationMembers, which filters on the column.
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

describe('organization member reads', () => {
  it('name the table only in the stores and the one scoped reader', () => {
    const naming = SOURCES.filter((s) => /['"]organization_members['"]/.test(s.text)).map(
      (s) => s.rel,
    );
    expect(naming.sort()).toEqual(
      [
        // The table map and the scopeless list.
        'lib/db/store.ts',
        // membershipsForUser: one person's memberships, by user id.
        'lib/db/demo-store.ts',
        'lib/db/supabase-store.ts',
        'lib/db/members.ts',
      ].sort(),
    );
  });

  it('filter on the organization in the reader', () => {
    const reader = SOURCES.find((s) => s.rel === 'lib/db/members.ts')?.text ?? '';
    expect(reader).toMatch(
      /store\.list\('organization_members', organizationId, \{\s*eq: \{ organization_id: organizationId \},?\s*\}\)/,
    );
  });
});
