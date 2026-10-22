import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The booking link's migration (D-074) as text: its row-level security
 * matches what the app allows. Turning the public link on, its slug and its
 * photo belong to an admin or the owner (the Settings routes require admin),
 * so the table refuses a plain member's write too; any member may answer a
 * request. Browser roles have no grants today, so this is the second lock.
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261022000000_booking_link.sql'),
  'utf8',
);

/** Every `create policy <name> on <table> ...;` statement, by name. */
function policies(): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of SQL.matchAll(/create policy (\w+) on (\w+)([\s\S]*?);/g)) {
    out.set(match[1]!, `${match[2]} ${match[3]!.replace(/\s+/g, ' ').trim()}`);
  }
  return out;
}

describe('booking link row-level security', () => {
  it('lets only an admin or the owner write booking_settings (review fix)', () => {
    const p = policies();
    expect(p.get('booking_settings_select')).toContain('is_org_member(organization_id)');
    for (const name of [
      'booking_settings_insert',
      'booking_settings_update',
      'booking_settings_delete',
    ]) {
      expect(p.get(name), name).toMatch(/has_org_role\(organization_id, 'admin'\)/);
      expect(p.get(name), name).not.toMatch(/'member'/);
    }
  });

  it('keeps booking_requests readable by members and writable by member and above', () => {
    expect(SQL).toMatch(/foreach t in array array\['booking_requests'\] loop/);
    expect(SQL).toMatch(/has_org_role\(organization_id, ''member''\)/);
  });

  it('can be run again: every policy is dropped before it is created', () => {
    for (const name of policies().keys()) {
      expect(SQL, name).toContain(`drop policy if exists ${name} on`);
    }
    expect(SQL).toMatch(/create table if not exists booking_settings/);
    expect(SQL).toMatch(/create table if not exists booking_requests/);
  });
});
