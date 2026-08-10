import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The migrations must be applicable in filename order.
 *
 * They were not. `is_org_member` and `has_org_role` were declared in
 * `20260101000000_extensions_and_helpers.sql` and read `organization_members`,
 * which is not created until `20260101000100_core_tables.sql`. Both are
 * `language sql`, which Postgres validates *at creation time* rather than at
 * first call — so applying the schema in order failed on the very first file:
 *
 *   ERROR: 42P01: relation "organization_members" does not exist
 *
 * That survived a typecheck, a production build and 444 tests because nothing
 * in the suite had ever read a migration, let alone executed one. This test is
 * the cheap half of that gap: it cannot prove the SQL runs, but it does prove
 * no object is referenced before the file that creates it.
 *
 * `language plpgsql` bodies are parsed lazily, so a forward reference there is
 * a latent runtime error rather than a load failure. Reported separately.
 */

const DIR = path.resolve(import.meta.dirname, '../../supabase/migrations');

interface Reference {
  kind: 'sql-function' | 'plpgsql-function' | 'foreign-key';
  owner: string;
  table: string;
  declaredIn: string;
  createdIn: string;
}

function analyse(): { files: string[]; tables: Map<string, number>; forward: Reference[] } {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const tables = new Map<string, number>();
  files.forEach((file, index) => {
    const sql = readFileSync(path.join(DIR, file), 'utf8');
    for (const m of sql.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)) {
      const name = m[1] as string;
      if (!tables.has(name)) tables.set(name, index);
    }
  });

  const forward: Reference[] = [];

  files.forEach((file, index) => {
    const sql = readFileSync(path.join(DIR, file), 'utf8');

    const fnRe =
      /create or replace function\s+([a-z_]+)\s*\([^)]*\)[\s\S]*?language\s+(sql|plpgsql)[\s\S]*?\$\$([\s\S]*?)\$\$;/gi;
    for (const m of sql.matchAll(fnRe)) {
      const name = m[1] as string;
      const lang = m[2] as string;
      const body = m[3] as string;
      const refs = new Set<string>();
      for (const r of body.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)/gi)) {
        refs.add(r[1] as string);
      }
      for (const table of refs) {
        const createdAt = tables.get(table);
        if (createdAt === undefined || createdAt <= index) continue;
        forward.push({
          kind: lang === 'sql' ? 'sql-function' : 'plpgsql-function',
          owner: name,
          table,
          declaredIn: file,
          createdIn: files[createdAt] as string,
        });
      }
    }

    for (const m of sql.matchAll(/references\s+([a-z_]+)\s*\(/gi)) {
      const table = m[1] as string;
      const createdAt = tables.get(table);
      if (createdAt === undefined || createdAt <= index) continue;
      forward.push({
        kind: 'foreign-key',
        owner: '(table definition)',
        table,
        declaredIn: file,
        createdIn: files[createdAt] as string,
      });
    }
  });

  return { files, tables, forward };
}

function describeAll(refs: Reference[]): string {
  return refs
    .map(
      (r) =>
        `${r.kind}: ${r.owner} uses "${r.table}" (declared ${r.declaredIn}, table ${r.createdIn})`,
    )
    .join('\n');
}

describe('migrations apply in filename order', () => {
  const { files, tables, forward } = analyse();

  it('finds the migrations', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(tables.size).toBe(34);
  });

  it('declares no SQL function before a table it reads', () => {
    // The failure mode that made the schema unapplicable. A `language sql`
    // body is validated when the function is created, so this is fatal, not
    // latent.
    const fatal = forward.filter((r) => r.kind === 'sql-function');
    expect(describeAll(fatal)).toBe('');
  });

  it('declares no foreign key to a table created later', () => {
    const fatal = forward.filter((r) => r.kind === 'foreign-key');
    expect(describeAll(fatal)).toBe('');
  });

  it('declares no plpgsql function before a table it reads', () => {
    // Not fatal at load — plpgsql bodies are parsed on first call — but it
    // would fail the first time the trigger fired, which is worse: in
    // production, on a real user's first sign-in.
    const latent = forward.filter((r) => r.kind === 'plpgsql-function');
    expect(describeAll(latent)).toBe('');
  });
});
