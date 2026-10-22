import { DEFAULT_BOOKING_CONFIG, type BookingConfig } from '@/lib/booking/config';
import type { BookingRequest, BookingSettingsRow } from '@/lib/types/domain';
import { addDaysToKey, localDateKey, wallTimeToUtc } from '@/lib/util/time';
import { DEMO_IDS } from './ids';

/**
 * The demo's booking link (D-074): switched on, so the demo shows the public
 * page at /meet/nick, with an invented profile, invented places in an
 * invented city and an invented FAQ, and three invented requests waiting on
 * the Calendar tab. Every name, address, place, link and fact here is made
 * up; the real ones are typed in Settings and live only in the database.
 * (Outside the demo the link starts off, with no row at all.)
 */

const ZONE = 'America/Chicago';
const NS = '00000000-0000-4000-8000-';
const id = (n: number) => `${NS}${n.toString(16).padStart(12, '0')}`;

export const DEMO_BOOKING_SLUG = 'nick';
export const DEMO_BOOKING_SETTINGS_ID = id(0xb00c);

export const DEMO_BOOKING_CONFIG: BookingConfig = {
  ...structuredClone(DEFAULT_BOOKING_CONFIG),
  // The demo shows requests waiting for Approve on the Calendar tab; Instant
  // booking (on by default) is switched on in Settings to see it book.
  instant: false,
  displayName: 'Nick Avery',
  title: 'Partner, TipTop VC (Demo)',
  bio: 'Backs early software teams from the first check. This is an invented demo profile: the real one is written in Settings.',
  firmName: 'TipTop VC (Demo)',
  homeCity: 'Harbor City',
  homeAliases: ['Riverside', 'Old Mill District'],
  places: [
    {
      id: 'juniper-rye',
      name: 'Juniper & Rye Coffee',
      area: 'Riverside',
      mapUrl: 'https://maps.example/juniper-rye',
    },
    {
      id: 'copper-kettle',
      name: 'The Copper Kettle',
      area: 'Old Mill District',
      mapUrl: null,
    },
    {
      id: 'saltgrass-table',
      name: 'Saltgrass Table',
      area: 'Harbor City downtown',
      mapUrl: 'https://maps.example/saltgrass-table',
    },
  ],
  faq: [
    'TipTop VC (Demo) is an invented fund used to show this page.',
    'Stage: pre-seed and seed software companies.',
    'Check size: an invented $250K to $500K first check.',
    'Pitching: share a deck link in the form; the team reads every one.',
  ].join('\n'),
};

/** The next Tuesday-to-Thursday dates at least `minDays` ahead, demo time. */
function nextMidweek(now: Date, minDays: number, count: number): string[] {
  const out: string[] = [];
  const today = localDateKey(now, ZONE);
  for (let i = minDays; out.length < count && i < minDays + 21; i++) {
    const key = addDaysToKey(today, i);
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (weekday >= 2 && weekday <= 4) out.push(key);
  }
  return out;
}

function at(dateKey: string, hour: number, minute = 0): string {
  return (
    wallTimeToUtc(dateKey, hour, minute, ZONE) ?? new Date(`${dateKey}T15:00:00Z`)
  ).toISOString();
}

export function demoBooking(now: Date): {
  booking_settings: BookingSettingsRow[];
  booking_requests: BookingRequest[];
} {
  const created = new Date(now.getTime() - 3 * 3_600_000).toISOString();
  const [callDay, coffeeDay] = nextMidweek(now, 16, 2);
  const base = {
    organization_id: DEMO_IDS.org,
    status: 'pending' as const,
    visitor_time_zone: 'America/New_York',
    place_id: null,
    place_name: null,
    place_area: null,
    place_map_url: null,
    place_custom: false,
    deck_url: null,
    ip_hash: null,
    claimed_at: null,
    calendar_id: null,
    event_id: null,
    decided_by: null,
    decided_at: null,
    created_at: created,
    updated_at: created,
  };
  return {
    booking_settings: [
      {
        id: DEMO_BOOKING_SETTINGS_ID,
        organization_id: DEMO_IDS.org,
        enabled: true,
        slug: DEMO_BOOKING_SLUG,
        settings: DEMO_BOOKING_CONFIG as unknown as Record<string, unknown>,
        updated_by: DEMO_IDS.user,
        created_at: created,
        updated_at: created,
      },
    ],
    booking_requests: [
      {
        ...base,
        id: id(0xb101),
        meeting_type: 'call',
        kind: null,
        starts_at: at(callDay!, 10, 0),
        ends_at: at(callDay!, 10, 30),
        name: 'Jamie Rivera',
        email: 'jamie@brightloom.example',
        company: 'Brightloom',
        note: 'Seed round for a scheduling tool for clinics. Would love 30 minutes.',
        deck_url: 'https://deck.example/brightloom-seed',
        source: 'form',
      },
      {
        ...base,
        id: id(0xb102),
        meeting_type: 'in_person',
        kind: 'coffee',
        starts_at: at(coffeeDay!, 9, 0),
        ends_at: at(coffeeDay!, 10, 0),
        visitor_time_zone: ZONE,
        name: 'Morgan Ellis',
        email: 'morgan@quarryline.example',
        company: 'Quarryline',
        place_id: 'juniper-rye',
        place_name: 'Juniper & Rye Coffee',
        place_area: 'Riverside',
        place_map_url: 'https://maps.example/juniper-rye',
        note: 'Catching up on the pilot results.',
        source: 'chatbot',
      },
      {
        ...base,
        id: id(0xb103),
        meeting_type: 'message',
        kind: null,
        starts_at: null,
        ends_at: null,
        visitor_time_zone: 'Europe/Lisbon',
        name: 'Ana Sousa',
        email: 'ana@tidepool.example',
        company: 'Tidepool Analytics',
        note: 'Not urgent: sharing our pre-seed deck in case it fits.',
        deck_url: 'https://deck.example/tidepool',
        source: 'form',
      },
    ],
  };
}
