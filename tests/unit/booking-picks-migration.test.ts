import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Pick times migration as text: additive and re-runnable, members read
 * and write (the Calendar's panel), and no constraint takes a name Postgres
 * gives an inline column check (the clash that broke the first booking
 * migration).
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261028000000_booking_picks.sql'),
  'utf8',
);

describe('booking_picks migration', () => {
  it('creates the table and the pick_id column additively', () => {
    expect(SQL).toMatch(/create table if not exists booking_picks/);
    expect(SQL).toMatch(/add column if not exists pick_id uuid/);
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    for (const column of [
      'organization_id uuid not null references organizations(id) on delete cascade',
      'token_hash text not null',
      'duration_minutes integer not null',
      'ranges jsonb not null',
      'recipient_time_zone text not null',
      'hold boolean not null default true',
      "status text not null default 'open'",
      'booking_request_id uuid references booking_requests(id) on delete set null',
      'expires_at timestamptz not null',
    ]) {
      expect(SQL, column).toContain(column);
    }
  });

  it('names every constraint itself, dropping it before adding it', () => {
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    for (const match of SQL.matchAll(/add constraint (\w+)/g)) {
      expect(SQL).toContain(`drop constraint if exists ${match[1]}`);
    }
    expect(SQL).toMatch(/token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it('lets members read and write, and can be run again', () => {
    expect(SQL).toMatch(/foreach t in array array\['booking_picks'\] loop/);
    expect(SQL).toMatch(/is_org_member\(organization_id\)/);
    expect(SQL).toMatch(/has_org_role\(organization_id, ''member''\)/);
    expect(SQL).toMatch(/create trigger booking_picks_updated_at/);
    expect(SQL).toMatch(/drop trigger if exists booking_picks_updated_at/);
  });
});
