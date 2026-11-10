import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { parsePersonEmail, personPagePath } from '@/lib/network/person-path';
import { buildPersonProfile } from '@/lib/services/person-profile';
import { resetRelationshipCache } from '@/lib/services/relationships';
import type { CalendarEvent, MeetingNote } from '@/lib/types/domain';

/**
 * The person page's data (Network → People → a person) on the demo store:
 * the demo workspace's invented relationship history plus a few rows added
 * here. Every name, address and subject is invented, on .example domains.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ADA = 'ada@brindlehealth.example';
const ORG_NOTE_BASE = {
  source_url: null,
  injection_flagged: false,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

let harness: Harness;

const day = (n: number) => {
  const d = new Date(NOW.getTime() + n * 86_400_000);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
};

beforeEach(async () => {
  resetRelationshipCache();
  harness = await createHarness({ now: NOW });
  const org = harness.auth.organizationId;
  const store = harness.store;

  // A private calendar event with her: never on the page.
  const secret: CalendarEvent = {
    id: '00000000-0000-4000-8000-00000000f001',
    organization_id: org,
    user_id: harness.auth.userId,
    provider: 'google',
    provider_event_id: 'test-private-event',
    title: 'Private dinner with Ada',
    description: null,
    location: null,
    starts_at: day(-20),
    ends_at: day(-20),
    all_day: false,
    attendees: [
      { name: 'Nick Tippmann', email: 'nick@tiptop.demo', response: 'accepted' },
      { name: 'Ada Brennan', email: ADA, response: 'accepted' },
    ],
    organizer_email: 'nick@tiptop.demo',
    is_private: true,
    created_at: day(-20),
    updated_at: day(-20),
  };
  await store.insert('calendar_events', secret as never);

  // A Granola note titled like a meeting with her, with no attendees: joins that meeting.
  const granola: MeetingNote = {
    ...ORG_NOTE_BASE,
    id: '00000000-0000-4000-8000-00000000f002',
    organization_id: org,
    provider: 'granola',
    external_id: 'test-granola-board-prep',
    title: 'Brindle Health: board prep',
    occurred_at: day(-90),
    attendees: [],
    content: '## Board prep\n\nAgreed the **runway** slide leads. Ada to send the revised plan.',
    visibility: 'team',
  };
  // A private Kraken note with her, recorded by someone else: never on the page.
  const privateNote: MeetingNote = {
    ...ORG_NOTE_BASE,
    id: '00000000-0000-4000-8000-00000000f003',
    organization_id: org,
    provider: 'copilot',
    external_id: '00000000-0000-4000-8000-00000000f004',
    meeting_id: '00000000-0000-4000-8000-00000000f004',
    title: 'One-to-one with Ada',
    occurred_at: day(-10),
    attendees: [{ name: 'Ada Brennan', email: ADA }],
    content: 'Private thoughts nobody else should read.',
    visibility: 'private',
    owner_id: '00000000-0000-4000-8000-00000000ffff',
  };
  await store.insert('meeting_notes', granola as never);
  await store.insert('meeting_notes', privateNote as never);
});

afterEach(async () => {
  resetRelationshipCache();
  await harness.dispose();
});

async function profile(email = ADA) {
  const built = await buildPersonProfile(harness.store, harness.auth, email, { now: NOW });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

describe('the person page link', () => {
  it('round-trips an address and refuses anything else', () => {
    expect(personPagePath('Ada@BrindleHealth.example')).toBe(
      '/network/person/ada%40brindlehealth.example',
    );
    expect(parsePersonEmail('ada%40brindlehealth.example')).toBe(ADA);
    expect(parsePersonEmail('ada@brindlehealth.example')).toBe(ADA);
    for (const bad of [
      '',
      'ada',
      'ada@',
      '@x.example',
      'a b@x.example',
      'a@x',
      '%E0%A4%A',
      'javascript:alert(1)@x.example',
    ]) {
      expect(parsePersonEmail(bad), bad).toBeNull();
    }
  });
});

describe('buildPersonProfile', () => {
  it('heads the page with who they are and how warm', async () => {
    const p = await profile();
    expect(p.name).toBe('Ada Brennan');
    expect(p.domain).toBe('brindlehealth.example');
    expect(p.status).toBe('recent');
    expect(p.strength.label).toBe('strong');
    expect(p.evidence.threads).toBe(p.threads.length);
  });

  it('lists every thread with them, newest first, with direction and snippet', async () => {
    const p = await profile();
    expect(p.threads.length).toBe(5);
    const times = p.threads.map((t) => t.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(p.threads[0]).toMatchObject({
      subject: 'Customer reference for diligence',
      direction: 'them',
      snippet: 'Yes, setting it up for Thursday.',
      gmailId: 'de0a000000000005',
    });
  });

  it('lists meetings with attendees, and joins a note to its meeting by title', async () => {
    const p = await profile();
    const titles = p.meetings.map((m) => m.title);
    expect(titles).toContain('Brindle Health: monthly check-in');
    expect(p.meetings.find((m) => m.upcoming)?.title).toBe('Brindle Health: monthly check-in');
    const prep = p.meetings.find((m) => m.title === 'Brindle Health: board prep');
    expect(prep?.attendees.map((a) => a.email)).toEqual(
      expect.arrayContaining([ADA, 'nick@tiptop.demo']),
    );
    expect(prep?.notes).toHaveLength(1);
    expect(prep?.notes[0]).toMatchObject({ source: 'granola' });
    expect(prep?.notes[0]?.summary).toBe(
      'Board prep Agreed the runway slide leads. Ada to send the revised plan.',
    );
    expect(prep?.notes[0]?.href).toBe(
      `/meetings?tab=notes&q=${encodeURIComponent('Brindle Health: board prep')}`,
    );
  });

  it('never shows a private calendar event or a private note', async () => {
    const p = await profile();
    const titles = p.meetings.map((m) => m.title);
    expect(titles).not.toContain('Private dinner with Ada');
    expect(titles).not.toContain('One-to-one with Ada');
    expect(JSON.stringify(p)).not.toContain('Private thoughts');
  });

  it('is not found for the fund’s own address or a stranger', async () => {
    for (const email of ['nick@tiptop.demo', 'nobody@unknown.example']) {
      const built = await buildPersonProfile(harness.store, harness.auth, email, { now: NOW });
      expect(built.ok, email).toBe(false);
      if (!built.ok) expect(built.error.code).toBe('not_found');
    }
  });
});
