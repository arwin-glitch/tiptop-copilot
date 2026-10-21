import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OWNER_FIX_REASON,
  DEFAULT_OWNER_FIX_STATUSES,
} from '@/lib/tasks/principal-backfill';

/**
 * The backfill that gives tasks filed under the owner to the principal is
 * SQL for the Supabase editor, and the repo has no Postgres to run it. Its
 * selection is pinned in TypeScript (lib/tasks/principal-backfill.ts, tested
 * in tests/integration/tasks-principal.test.ts); this checks the SQL says
 * the same thing, names no one, and is one read-only preview plus one
 * transaction.
 */

const FILE = path.resolve(
  import.meta.dirname,
  '../../supabase/migrations/20261021002000_tasks_to_principal.sql',
);
const SQL = readFileSync(FILE, 'utf8');
const LINES = SQL.split(/\r?\n/);
const isComment = (line: string) => line.trim().startsWith('--');
/** The statements that run, without comments. */
const CODE = LINES.filter((line) => !isComment(line)).join('\n');
/** The commented-out preview, uncommented. */
const PREVIEW = (() => {
  const start = LINES.findIndex((line) => /^-- -+ PREVIEW$/.test(line));
  const end = LINES.findIndex((line, i) => i > start && /^-- -+$/.test(line));
  return LINES.slice(start + 1, end)
    .map((line) => line.replace(/^-- ?/, ''))
    .join('\n');
})();
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** One CTE's body, `name as ( … )`, by balanced parentheses. */
function cte(text: string, name: string): string {
  const start = text.search(new RegExp(`\\b${name} as \\(`));
  if (start < 0) throw new Error(`no ${name} CTE`);
  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return squash(text.slice(start, i + 1));
  }
  throw new Error(`unbalanced ${name} CTE`);
}

/** The moves CTE from its `from` on: the joins and the where, the selection itself. */
function selection(text: string): string {
  const body = cte(text, 'moves');
  return body.slice(body.indexOf(' from public.tasks t '));
}

describe('the default-owner backfill SQL', () => {
  it('names no one: no ids and no addresses', () => {
    expect(SQL).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(SQL).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('runs as one transaction and changes no schema', () => {
    expect(CODE.match(/^begin;$/gm)).toHaveLength(1);
    expect(CODE.match(/^commit;$/gm)).toHaveLength(1);
    const begin = CODE.indexOf('begin;');
    const commit = CODE.indexOf('commit;');
    expect(begin).toBeLessThan(commit);
    expect(CODE).not.toMatch(/\b(create|drop|truncate|delete|grant|revoke)\b/i);
    // The only ALTERs switch the updated_at trigger off and on again, inside it.
    const alters = [...CODE.matchAll(/^alter .*$/gim)].map((m) => [m[0], m.index]);
    expect(alters.map(([line]) => line)).toEqual([
      'alter table public.tasks disable trigger tasks_updated_at;',
      'alter table public.tasks enable trigger tasks_updated_at;',
    ]);
    for (const [, at] of alters) {
      expect(at as number).toBeGreaterThan(begin);
      expect(at as number).toBeLessThan(commit);
    }
    const update = CODE.search(/\bupdate public\.tasks\b/);
    expect(update).toBeGreaterThan(CODE.indexOf('disable trigger'));
    expect(update).toBeLessThan(CODE.indexOf('enable trigger'));
  });

  it('finds the principal by the rule the app uses', () => {
    const mailbox = cte(CODE, 'mailbox');
    expect(mailbox).toContain("i.provider = 'google'");
    expect(mailbox).toContain("'gmail' = any (i.kinds)");
    // A mailbox that needs reconnecting, or was disconnected, still counts,
    // after a connected one: as principalMailbox ranks them.
    expect(mailbox).not.toContain('i.status =');
    expect(mailbox).toContain(
      "order by i.organization_id, case i.status when 'connected' then 0 when 'disconnected' then 2 else 1 end, i.created_at, i.id",
    );
    expect(mailbox).toContain('lower(btrim(i.account_email))');
    // Members in team order: oldest membership, then id.
    expect(cte(CODE, 'by_address')).toContain(
      'order by m.organization_id, m.created_at, m.user_id',
    );
    expect(cte(CODE, 'by_owner')).toContain("m.role = 'owner'");
    // (a) address, then (b) who connected it, then (c) the owner.
    expect(cte(CODE, 'principal')).toContain('coalesce(a.user_id, c.user_id, w.user_id)');
  });

  it('moves only what the code put on the owner by default', () => {
    const where = selection(CODE);
    expect(where).toContain(
      "join public.organization_members om on om.organization_id = t.organization_id and om.user_id = t.assigned_to and om.role = 'owner'",
    );
    expect(where).toContain('t.assigned_to <> p.principal_id');
    expect(where).toContain("t.source <> 'human'");
    expect(where).toContain(
      `t.status in (${DEFAULT_OWNER_FIX_STATUSES.map((s) => `'${s}'`).join(', ')})`,
    );
    expect(where).toContain('not exists');
    expect(where).toContain("e.action = 'task.assigned'");
    expect(where).toContain('e.entity_id = t.id::text');
    // Only a row nobody changed since it was read is moved.
    expect(squash(CODE)).toContain('where t.id = mv.id and t.assigned_to = mv.from_id');
  });

  it('writes the audit row the app writes for an assignment', () => {
    const insert = squash(CODE.slice(CODE.indexOf('insert into public.audit_events')));
    expect(insert).toMatch(
      /^insert into public\.audit_events \(organization_id, user_id, action, entity_type, entity_id, metadata\) select mo\.organization_id, null, 'task\.assigned', 'task', mo\.id::text, jsonb_build_object\('from', mo\.from_id, 'to', mo\.to_id, 'reason', '([^']+)'\) from moved mo;/,
    );
    expect(insert).toContain(`'reason', '${DEFAULT_OWNER_FIX_REASON}'`);
    // Every column it names is a column of audit_events; the rest default.
    const table = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../supabase/migrations/20260101000500_briefs_chat_ops.sql',
      ),
      'utf8',
    );
    const definition = table.slice(table.indexOf('create table if not exists audit_events ('));
    for (const column of [
      'organization_id',
      'user_id',
      'action',
      'entity_type',
      'entity_id',
      'metadata',
    ]) {
      expect(definition.slice(0, definition.indexOf(');'))).toMatch(
        new RegExp(`^\\s+${column} `, 'm'),
      );
    }
  });

  it('previews the same selection, and the preview only reads', () => {
    for (const name of ['mailbox', 'by_address', 'by_connector', 'by_owner']) {
      expect(cte(PREVIEW, name)).toBe(cte(CODE, name));
    }
    expect(selection(PREVIEW)).toBe(selection(CODE));
    expect(PREVIEW).not.toMatch(/\b(update|insert|alter|delete|drop|create|begin|commit)\b/i);
    expect(PREVIEW.trim().endsWith(';')).toBe(true);
    // Every preview line is commented out, so running the file never runs it twice.
    const start = LINES.findIndex((line) => /^-- -+ PREVIEW$/.test(line));
    const end = LINES.findIndex((line, i) => i > start && /^-- -+$/.test(line));
    expect(LINES.slice(start, end + 1).every(isComment)).toBe(true);
    expect(start).toBeLessThan(LINES.indexOf('begin;'));
  });
});
