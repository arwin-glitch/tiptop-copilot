import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkSendAt,
  schedulePresets,
  sendWindowNote,
  SEND_WINDOW_MINUTES,
} from '@/lib/email/schedule-send';

const zone = 'America/Chicago';

describe("Gmail's schedule-send presets", () => {
  it('offers tomorrow at 8 AM and 1 PM, and Monday at 8 AM, on the wall clock', () => {
    // Wednesday Nov 4, 2026, 9 AM in Chicago.
    const presets = schedulePresets(new Date('2026-11-04T15:00:00Z'), zone);
    expect(presets.map((p) => p.id)).toEqual([
      'tomorrowMorning',
      'tomorrowAfternoon',
      'mondayMorning',
    ]);
    expect(presets[0]!.at.toISOString()).toBe('2026-11-05T14:00:00.000Z');
    expect(presets[1]!.at.toISOString()).toBe('2026-11-05T19:00:00.000Z');
    expect(presets[2]!.at.toISOString()).toBe('2026-11-09T14:00:00.000Z');
  });

  it('leaves out Monday when tomorrow is Monday', () => {
    // Sunday Nov 8, 2026.
    const presets = schedulePresets(new Date('2026-11-08T18:00:00Z'), zone);
    expect(presets.map((p) => p.id)).toEqual(['tomorrowMorning', 'tomorrowAfternoon']);
  });

  it("follows the reader's own zone", () => {
    const tokyo = schedulePresets(new Date('2026-11-04T15:00:00Z'), 'Asia/Tokyo');
    // Already Nov 5 in Tokyo: tomorrow is Nov 6, 8 AM there.
    expect(tokyo[0]!.at.toISOString()).toBe('2026-11-05T23:00:00.000Z');
  });
});

describe('send times', () => {
  const now = new Date('2026-11-04T15:00:00Z');
  it('must be a minute or more ahead and at most a year', () => {
    expect(checkSendAt('2026-11-04T15:00:30Z', now).ok).toBe(false);
    expect(checkSendAt('2026-11-04T15:05:00Z', now).ok).toBe(true);
    expect(checkSendAt('2027-11-05T15:00:00Z', now).ok).toBe(false);
    expect(checkSendAt('nonsense', now).ok).toBe(false);
  });

  it('says the honest window: minutes in sending hours, 6 AM Central outside them', () => {
    expect(sendWindowNote(new Date('2026-11-05T14:00:00Z'))).toContain(
      `${SEND_WINDOW_MINUTES} minutes`,
    );
    expect(sendWindowNote(new Date('2026-11-05T09:00:00Z'))).toMatch(/6 AM Central/);
  });

  it("matches the sender loop's hours in push-alerts.yml", () => {
    const yml = readFileSync(
      path.resolve(import.meta.dirname, '../../.github/workflows/push-alerts.yml'),
      'utf8',
    );
    expect(yml).toMatch(/LOOP_FROM_HOUR: '6'/);
    expect(yml).toMatch(/LOOP_UNTIL_HOUR: '21'/);
    const route = readFileSync(
      path.resolve(import.meta.dirname, '../../src/app/api/cron/push/route.ts'),
      'utf8',
    );
    expect(route).toMatch(/dispatchDueScheduledForAll\(/);
  });
});

describe('inbox_scheduled_sends migration', () => {
  const SQL = readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../supabase/migrations/20261104000000_inbox_scheduled_sends.sql',
    ),
    'utf8',
  );

  it('is additive, names its constraints, and keeps RLS like the others', () => {
    expect(SQL).toMatch(/create table if not exists inbox_scheduled_sends/);
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    for (const match of SQL.matchAll(/add constraint (\w+)/g)) {
      expect(SQL).toContain(`drop constraint if exists ${match[1]}`);
    }
    expect(SQL).toMatch(/status in \('scheduled', 'sending', 'sent', 'cancelled', 'failed'\)/);
    expect(SQL).toMatch(/foreach t in array array\['inbox_scheduled_sends'\] loop/);
    expect(SQL).toMatch(/drop trigger if exists inbox_scheduled_sends_updated_at/);
    expect(SQL).toMatch(
      /Until it is applied the Schedule option says it needs a\s+-- database update/,
    );
  });
});
