import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Snooze migration as text: additive and re-runnable, members read and
 * write (the Inbox's actions), one open snooze per thread, and no constraint
 * takes a name Postgres gives an inline column check (the clash that broke
 * the first booking migration).
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261102000000_inbox_snoozes.sql'),
  'utf8',
);

describe('inbox_snoozes migration', () => {
  it('creates the table additively', () => {
    expect(SQL).toMatch(/create table if not exists inbox_snoozes/);
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    for (const column of [
      'id uuid primary key default gen_random_uuid()',
      'organization_id uuid not null references organizations(id) on delete cascade',
      'thread_id text not null',
      'wake_at timestamptz not null',
      "status text not null default 'snoozed'",
      'created_by uuid references auth.users(id) on delete set null',
      'created_at timestamptz not null default now()',
      'updated_at timestamptz not null default now()',
    ]) {
      expect(SQL, column).toContain(column);
    }
  });

  it('names every constraint itself, dropping it before adding it', () => {
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    for (const match of SQL.matchAll(/add constraint (\w+)/g)) {
      expect(SQL).toContain(`drop constraint if exists ${match[1]}`);
    }
    expect(SQL).toMatch(/thread_id ~ '\^\[0-9a-f\]\{10,24\}\$'/);
    expect(SQL).toMatch(/status in \('snoozed', 'woken', 'cancelled'\)/);
  });

  it('keeps one open snooze per thread', () => {
    expect(SQL).toMatch(
      /create unique index if not exists inbox_snoozes_one_open_idx\s+on inbox_snoozes \(organization_id, thread_id\)\s+where status = 'snoozed'/,
    );
  });

  it('lets members read and write, and can be run again', () => {
    expect(SQL).toMatch(/foreach t in array array\['inbox_snoozes'\] loop/);
    expect(SQL).toMatch(/is_org_member\(organization_id\)/);
    expect(SQL).toMatch(/has_org_role\(organization_id, ''member''\)/);
    expect(SQL).toMatch(/create trigger inbox_snoozes_updated_at/);
    expect(SQL).toMatch(/drop trigger if exists inbox_snoozes_updated_at/);
  });

  it('says what happens before it is applied', () => {
    expect(SQL).toMatch(
      /Until it is applied the Snooze button says it needs a\s+-- database update/,
    );
  });
});
