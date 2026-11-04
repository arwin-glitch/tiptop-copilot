import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS } from '@/lib/demo/ids';
import { deleteTemplate, listTemplates, saveTemplate } from '@/lib/services/inbox-templates';

/** The compose window's Templates: saved, overwritten, sanitized, deleted; and before the migration. */

let harness: Harness;
const actor = () => ({ organizationId: DEMO_IDS.org, userId: DEMO_IDS.user });

beforeEach(async () => {
  harness = await createHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe('templates', () => {
  it('lists the demo templates, saves one, overwrites by name, deletes', async () => {
    const before = await listTemplates(harness.store, DEMO_IDS.org);
    expect(before.ok && before.value.length).toBe(2);

    const made = await saveTemplate(harness.store, actor(), {
      name: 'Follow-up',
      subject: 'Checking in',
      html: '<div>Hi <b>there</b></div><script>alert(1)</script>',
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.html).not.toMatch(/script/);

    const again = await saveTemplate(harness.store, actor(), {
      name: 'follow-up',
      subject: 'Checking in again',
      html: '<div>Hello</div>',
    });
    expect(again.ok && again.value.id).toBe(made.value.id);
    const listed = await listTemplates(harness.store, DEMO_IDS.org);
    expect(listed.ok && listed.value.length).toBe(3);

    expect((await deleteTemplate(harness.store, DEMO_IDS.org, made.value.id)).ok).toBe(true);
    expect((await deleteTemplate(harness.store, DEMO_IDS.org, made.value.id)).ok).toBe(false);
  });

  it('before the migration: says so and stores nothing', async () => {
    const original = harness.store.list.bind(harness.store);
    vi.spyOn(harness.store, 'list').mockImplementation((async (
      table: string,
      ...rest: unknown[]
    ) => {
      if (table === 'inbox_templates') {
        throw Object.assign(new Error('relation "inbox_templates" does not exist'), {
          code: '42P01',
        });
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(table, ...rest);
    }) as never);
    const insert = vi.spyOn(harness.store, 'insert');
    const res = await saveTemplate(harness.store, actor(), { name: 'X', subject: '', html: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.details).toMatchObject({ needsMigration: true });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('inbox_templates migration', () => {
  const SQL = readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../supabase/migrations/20261105000000_inbox_templates.sql',
    ),
    'utf8',
  );
  it('is additive, names its constraints, and keeps RLS like the others', () => {
    expect(SQL).toMatch(/create table if not exists inbox_templates/);
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    for (const match of SQL.matchAll(/add constraint (\w+)/g)) {
      expect(SQL).toContain(`drop constraint if exists ${match[1]}`);
    }
    expect(SQL).toMatch(/foreach t in array array\['inbox_templates'\] loop/);
  });
});
