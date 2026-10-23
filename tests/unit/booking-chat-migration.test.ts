import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The booking assistant's migration (D-078) as text: additive and re-runnable,
 * members may read (the Booking tab's status) and no browser role may write
 * (the server writes with the service role), and no constraint is named the
 * way Postgres names an inline column check, the clash that broke the first
 * booking migration.
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261022200100_booking_chat.sql'),
  'utf8',
);

describe('booking_chat_questions migration', () => {
  it('creates the table additively, with the columns the code writes', () => {
    expect(SQL).toMatch(/create table if not exists booking_chat_questions/);
    for (const column of [
      'id uuid primary key',
      'organization_id uuid not null references organizations',
      'question text not null',
      'answer text',
      "status text not null default 'pending'",
      'ip_hash text',
      'created_at timestamptz not null default now()',
      'answered_at timestamptz',
    ]) {
      expect(SQL, column).toContain(column);
    }
    expect(SQL).not.toMatch(/\bdrop table\b|\balter table \w+ drop column\b/i);
  });

  it('names its status check apart from the inline auto-name, and drops it before adding it', () => {
    expect(SQL).not.toMatch(/constraint booking_chat_questions_status_check\b/);
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    const drop = SQL.indexOf('drop constraint if exists booking_chat_questions_status_allowed');
    const add = SQL.indexOf('add constraint booking_chat_questions_status_allowed');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(SQL).toMatch(/check \(status in \('pending', 'answered', 'expired'\)\)/);
  });

  it('lets members read and gives browser roles no write at all', () => {
    expect(SQL).toMatch(/enable row level security/);
    const creates = [...SQL.matchAll(/create policy (\w+) on (\w+)\s+for (\w+)/g)].map((m) => [
      m[1],
      m[3],
    ]);
    expect(creates).toEqual([['booking_chat_questions_select', 'select']]);
    expect(SQL).toMatch(/for select using \(is_org_member\(organization_id\)\)/);
    for (const name of ['select', 'insert', 'update', 'delete']) {
      expect(SQL).toContain(`drop policy if exists booking_chat_questions_${name} on`);
    }
  });
});
