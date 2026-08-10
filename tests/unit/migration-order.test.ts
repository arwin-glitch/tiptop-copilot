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

/**
 * Stored generated columns may only call IMMUTABLE functions. Postgres refuses
 * anything else:
 *
 *   ERROR: 42P17: generation expression is not immutable
 *
 * `array_to_string` was in `network_contacts.search_vector` and is marked
 * STABLE, so the schema could not be applied. The allowlist is deliberately
 * short: adding to it should require checking `provolatile` in pg_proc, not a
 * guess. `to_tsvector` is immutable only in its two-argument form, so the
 * config argument is checked separately.
 */
const IMMUTABLE_IN_GENERATED = new Set([
  'coalesce',
  'setweight',
  'to_tsvector',
  'text_array_to_string',
]);

function generatedExpressions(): { file: string; expression: string }[] {
  const out: { file: string; expression: string }[] = [];
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(DIR, file), 'utf8');
    for (const m of sql.matchAll(/generated always as\s*\(([\s\S]*?)\)\s*stored/gi)) {
      out.push({ file, expression: m[1] as string });
    }
  }
  return out;
}

describe('generated columns are immutable', () => {
  const expressions = generatedExpressions();

  it('finds the generated columns', () => {
    expect(expressions.length).toBeGreaterThan(0);
  });

  it('calls only allowlisted immutable functions', () => {
    const offenders: string[] = [];
    for (const { file, expression } of expressions) {
      for (const m of expression.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
        const fn = (m[1] as string).toLowerCase();
        if (!IMMUTABLE_IN_GENERATED.has(fn)) offenders.push(`${file}: ${fn}()`);
      }
    }
    expect([...new Set(offenders)].join('\n')).toBe('');
  });

  it('always gives to_tsvector an explicit text search config', () => {
    // The one-argument form depends on default_text_search_config, which is a
    // session setting — so it is STABLE and would be rejected.
    const offenders: string[] = [];
    for (const { file, expression } of expressions) {
      for (const m of expression.matchAll(/to_tsvector\s*\(\s*([^,)]*)/gi)) {
        const firstArg = (m[1] as string).trim();
        if (!/^'[a-z_]+'$/i.test(firstArg)) offenders.push(`${file}: to_tsvector(${firstArg}…`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

/**
 * The schema must grant its own privileges.
 *
 * Supabase grants the API roles access to new tables only when a project
 * setting called "Automatically expose new tables" is on — and Supabase itself
 * recommends leaving it off. A schema that relies on it therefore works or
 * fails depending on a checkbox ticked once, in a dashboard, months earlier.
 *
 * Ours relied on it, and the failure was opaque: sign-in succeeded, then the
 * first query raised `permission denied for table organization_members`.
 */
describe('the schema grants its own privileges', () => {
  const sql = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(DIR, f), 'utf8'))
    .join('\n');

  it('grants table privileges to service_role', () => {
    expect(sql).toMatch(/grant all privileges on all tables in schema public to service_role/i);
  });

  it('grants schema usage to the API roles', () => {
    expect(sql).toMatch(/grant usage on schema public to[^;]*service_role/i);
  });

  it('sets default privileges so later tables inherit them', () => {
    expect(sql).toMatch(
      /alter default privileges in schema public grant all on tables to service_role/i,
    );
  });

  it('does not grant table access to anon', () => {
    // Every query runs server-side under the service role. Granting anon table
    // access would make a leaked publishable key materially worse, and RLS
    // would become the only thing standing in the way rather than the second
    // thing.
    expect(sql).not.toMatch(/grant\s+(all|select)[^;]*on all tables in schema public to[^;]*anon/i);
  });
});

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
