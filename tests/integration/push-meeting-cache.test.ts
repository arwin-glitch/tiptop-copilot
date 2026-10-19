import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/config/env';
import type { MeetingEvent } from '@/lib/calendar/meetings';
import { meetingAlerts, resetPushAlertCaches } from '@/lib/services/push-alerts';
import { ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Outside demo mode, one Calendar read serves every caller of an
 * organization for 50 seconds: the phone job and each computer with desktop
 * alerts all ask every minute, and Calendar has no cache of its own.
 */

const listed = vi.hoisted(() => vi.fn());
vi.mock('@/lib/calendar/meetings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calendar/meetings')>()),
  listMeetingEvents: listed,
}));

const NOW = new Date('2026-10-07T15:00:00Z');
const TZ = 'America/Chicago';
const SAVED = { ...process.env };

function meeting(startsAt: Date): MeetingEvent {
  return {
    id: 'evt-cache-1',
    status: 'confirmed',
    title: 'Partner sync',
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    allDay: false,
    eventType: 'default',
    transparent: false,
    location: null,
    description: null,
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    organizer: { email: 'sam@fund.example', self: false, name: 'Sam Rivera' },
    attendees: [
      { email: 'sam@fund.example', name: 'Sam Rivera', response: 'accepted', self: false },
    ],
  } as MeetingEvent;
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ now: NOW });
  process.env.DEMO_MODE = 'false';
  resetEnvCache();
  listed.mockReset();
  listed.mockResolvedValue(ok([meeting(new Date(NOW.getTime() + 5 * 60_000))]));
});

afterEach(async () => {
  Object.assign(process.env, SAVED);
  resetEnvCache();
  await harness.dispose();
});

describe('meeting alerts outside demo mode', () => {
  it('reads Calendar once per 50 seconds per organization', async () => {
    const org = harness.auth.organizationId;
    const first = await meetingAlerts(harness.store, org, new Set(), NOW, TZ);
    expect(first).toHaveLength(1);
    const soon = new Date(NOW.getTime() + 30_000);
    expect(await meetingAlerts(harness.store, org, new Set(), soon, TZ)).toHaveLength(1);
    expect(listed).toHaveBeenCalledTimes(1);

    await meetingAlerts(harness.store, org, new Set(), new Date(NOW.getTime() + 50_000), TZ);
    expect(listed).toHaveBeenCalledTimes(2);

    resetPushAlertCaches();
    await meetingAlerts(harness.store, org, new Set(), new Date(NOW.getTime() + 51_000), TZ);
    expect(listed).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed read', async () => {
    listed.mockResolvedValueOnce({
      ok: false,
      error: { code: 'provider_unavailable', message: 'down' },
    });
    const org = harness.auth.organizationId;
    expect(await meetingAlerts(harness.store, org, new Set(), NOW, TZ)).toEqual([]);
    expect(await meetingAlerts(harness.store, org, new Set(), NOW, TZ)).toHaveLength(1);
    expect(listed).toHaveBeenCalledTimes(2);
  });
});
