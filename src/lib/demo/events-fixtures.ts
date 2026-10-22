import { newEventDoc, sectionTemplate } from '@/lib/events/doc';
import type { EventDoc } from '@/lib/events/schema';
import { getThemePreset } from '@/lib/events/themes';
import type {
  EventEditor,
  EventGuest,
  EventGuestSession,
  EventRecord,
  EventRegistrationSettings,
  EventSession,
  EventVersion,
} from '@/lib/types/domain';
import { sha256 } from '@/lib/util/hash';
import { DEMO_IDS } from './ids';

/**
 * Fictional Events demo data (D-075). Every name, company, address, email
 * and number here is invented; emails use example.com. Nothing describes a
 * real TipTop event, LP or guest.
 *
 *   - "Harborview Annual Meeting": published, invite-only, unlisted, two
 *     sessions (afternoon meeting + evening reception), five guests with a
 *     spread of statuses and one plus-one, an outside editor link and a
 *     published version.
 *   - "Founders Putting Night": a draft, open registration, one session.
 *
 * Ids are fixed (00000000-0000-4000-8000-0000e7e0xxxx) so tests and docs can
 * link to them.
 */

const NS = '00000000-0000-4000-8000-0000e7e0';
export function demoEventId(n: number): string {
  return `${NS}${n.toString(16).padStart(4, '0')}`;
}

export const DEMO_EVENT_IDS = {
  annualMeeting: demoEventId(1),
  puttingNight: demoEventId(2),
  sessionMeeting: demoEventId(0x11),
  sessionReception: demoEventId(0x12),
  sessionPutting: demoEventId(0x21),
  guestAvery: demoEventId(0x101),
  guestBianca: demoEventId(0x102),
  guestCarlos: demoEventId(0x103),
  guestDana: demoEventId(0x104),
  guestEli: demoEventId(0x105),
  guestEliPlusOne: demoEventId(0x106),
  editorJordan: demoEventId(0x201),
  versionPublished: demoEventId(0x301),
} as const;

export const DEMO_EVENT_SLUGS = {
  annualMeeting: 'harborview-annual-meeting',
  puttingNight: 'founders-putting-night',
} as const;

/** Section ids are 0x1000 + n per event, so they are stable too. */
function idMaker(base: number): () => string {
  let n = 0;
  return () => demoEventId(base + n++);
}

function registration(
  overrides: Partial<EventRegistrationSettings> = {},
): EventRegistrationSettings {
  return {
    open: true,
    closes_at: null,
    show_remaining: false,
    response_set: {
      maybe: true,
      labels: { going: 'Count me in', maybe: 'Maybe', not_going: 'Regretfully decline' },
    },
    plus_ones: { max: 1, per_session: true, collect_email: false, ask_questions: true },
    waitlist: true,
    auto_promote: false,
    claim_window_hours: null,
    request_invite: true,
    guest_wall: 'hidden',
    ...overrides,
  };
}

function at(now: Date, days: number, hourUtc: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

function annualMeetingDoc(): EventDoc {
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', {
        headline: 'Harborview Annual Meeting',
        subheadline: 'An afternoon on the year in review, then an evening reception.',
      }),
      sectionTemplate('details', {}),
      sectionTemplate(
        'agenda',
        {
          heading: 'The day',
          items: [
            { time: '1:00 PM', title: 'Welcome and year in review' },
            { time: '3:00 PM', title: 'Portfolio spotlights' },
            { time: '6:00 PM', title: 'Evening reception' },
          ],
        },
        'two_column',
      ),
      sectionTemplate('text', {
        heading: 'Pre-reads',
        body: 'Materials for registered guests appear here two weeks before the meeting.',
      }),
      sectionTemplate('rsvp', {
        cta: 'RSVP',
        going: 'Count me in',
        maybe: 'Maybe',
        notGoing: 'Regretfully decline',
      }),
      sectionTemplate('faq', {
        heading: 'Questions',
        items: [{ q: 'Is there parking?', a: 'Yes, in the garage next door.' }],
      }),
      sectionTemplate('footer', {}),
    ],
    idMaker(0x1000),
  );
}

function puttingNightDoc(): EventDoc {
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'Founders Putting Night', subheadline: '' }),
      sectionTemplate('details', {}),
      sectionTemplate('rsvp', {
        cta: 'Save my spot',
        going: 'Going',
        maybe: 'Maybe',
        notGoing: "Can't go",
      }),
      sectionTemplate('footer', {}),
    ],
    idMaker(0x2000),
  );
}

export function demoEvents(now: Date): {
  events: EventRecord[];
  event_sessions: EventSession[];
  event_guests: EventGuest[];
  event_guest_sessions: EventGuestSession[];
  event_editors: EventEditor[];
  event_versions: EventVersion[];
  event_slug_aliases: [];
  event_presence: [];
  event_edits: [];
  event_media: [];
  event_page_views: [];
  event_share_links: [];
} {
  const ORG = DEMO_IDS.org;
  const USER = DEMO_IDS.user;
  const ID = DEMO_EVENT_IDS;
  const created = at(now, -10, 15);
  const nowIso = now.toISOString();

  // 1–5 PM and 6–9 PM Central (UTC-6 in winter; close enough for a demo).
  const meetingStart = at(now, 30, 19);
  const meetingEnd = at(now, 30, 23);
  const receptionStart = at(now, 31, 0);
  const receptionEnd = at(now, 31, 3);
  const annualDoc = annualMeetingDoc();
  const annualDocJson = annualDoc as unknown as Record<string, unknown>;

  const venue = {
    kind: 'in_person' as const,
    name: 'The Lantern Hall',
    address: '100 Example Avenue, Springfield',
    lat: null,
    lng: null,
    place_id: null,
    maps_url: null,
    online_url: null,
    reveal: 'registered' as const,
    notes: 'Enter from the courtyard.',
  };

  const events: EventRecord[] = [
    {
      id: ID.annualMeeting,
      organization_id: ORG,
      slug: DEMO_EVENT_SLUGS.annualMeeting,
      title: 'Harborview Annual Meeting',
      status: 'published',
      visibility: 'unlisted',
      access: 'invite_only',
      password_hash: null,
      time_zone: 'America/Chicago',
      starts_at: meetingStart,
      ends_at: receptionEnd,
      venue,
      capacity: null,
      registration: registration(),
      questions: [
        {
          id: demoEventId(0x401),
          type: 'dietary',
          label: 'Any dietary needs?',
          help: null,
          required: false,
          options: [],
          session_id: ID.sessionReception,
          ask_plus_ones: true,
          position: 0,
          removed_at: null,
        },
        {
          id: demoEventId(0x402),
          type: 'long_text',
          label: 'Who would you like to meet?',
          help: null,
          required: false,
          options: [],
          session_id: null,
          ask_plus_ones: false,
          position: 1,
          removed_at: null,
        },
      ],
      comms: { reminder_offsets_minutes: [10_080, 1_440, 180], sender: 'nick' },
      draft_doc: annualDocJson,
      draft_version: 0,
      published_doc: structuredClone(annualDocJson),
      published_version: 1,
      published_draft_version: 0,
      published_at: at(now, -5, 16),
      published_by: USER,
      schedule_version: 0,
      og_image_path: null,
      editing_paused: false,
      cancel_message: null,
      cancelled_at: null,
      is_template: false,
      created_by: USER,
      created_at: created,
      updated_at: nowIso,
    },
    {
      id: ID.puttingNight,
      organization_id: ORG,
      slug: DEMO_EVENT_SLUGS.puttingNight,
      title: 'Founders Putting Night',
      status: 'draft',
      visibility: 'unlisted',
      access: 'open',
      password_hash: null,
      time_zone: 'America/Chicago',
      starts_at: at(now, 45, 23),
      ends_at: at(now, 46, 2),
      venue: {
        ...venue,
        name: 'Greenway Putting Club',
        address: '200 Sample Road, Springfield',
        reveal: 'public',
        notes: null,
      },
      capacity: 60,
      registration: registration({
        request_invite: false,
        plus_ones: { max: 0, per_session: false, collect_email: false, ask_questions: false },
      }),
      questions: [],
      comms: { reminder_offsets_minutes: [1_440, 180], sender: 'arwin' },
      draft_doc: puttingNightDoc() as unknown as Record<string, unknown>,
      draft_version: 0,
      published_doc: null,
      published_version: 0,
      published_draft_version: 0,
      published_at: null,
      published_by: null,
      schedule_version: 0,
      og_image_path: null,
      editing_paused: false,
      cancel_message: null,
      cancelled_at: null,
      is_template: false,
      created_by: USER,
      created_at: at(now, -2, 15),
      updated_at: nowIso,
    },
  ];

  const session = (
    id: string,
    eventId: string,
    name: string,
    startsAt: string,
    endsAt: string,
    position: number,
    capacity: number | null,
  ): EventSession => ({
    id,
    organization_id: ORG,
    event_id: eventId,
    name,
    description: null,
    starts_at: startsAt,
    ends_at: endsAt,
    venue: null,
    capacity,
    requires_approval: null,
    waitlist: null,
    visible_to_tags: [],
    position,
    created_at: created,
    updated_at: nowIso,
  });

  const event_sessions: EventSession[] = [
    session(ID.sessionMeeting, ID.annualMeeting, 'Annual Meeting', meetingStart, meetingEnd, 0, 80),
    session(
      ID.sessionReception,
      ID.annualMeeting,
      'Evening Reception',
      receptionStart,
      receptionEnd,
      1,
      125,
    ),
    session(
      ID.sessionPutting,
      ID.puttingNight,
      'Founders Putting Night',
      events[1]!.starts_at!,
      events[1]!.ends_at!,
      0,
      60,
    ),
  ];

  const guest = (
    id: string,
    first: string,
    last: string,
    company: string,
    tags: string[],
    extra: Partial<EventGuest> = {},
  ): EventGuest => ({
    id,
    organization_id: ORG,
    event_id: ID.annualMeeting,
    parent_guest_id: null,
    email: `${first}.${last}@example.com`.toLowerCase(),
    first_name: first,
    last_name: last,
    company,
    title: null,
    phone: null,
    record_id: null,
    tags,
    host_note: null,
    answers: {},
    source: 'invite',
    token_version: 1,
    show_on_wall: false,
    referral_code: null,
    utm: null,
    ip_hash: null,
    notified_status: {},
    registered_at: null,
    created_at: created,
    updated_at: nowIso,
    ...extra,
  });

  const event_guests: EventGuest[] = [
    guest(ID.guestAvery, 'Avery', 'Quill', 'Northwind Capital', ['LP'], {
      registered_at: at(now, -4, 17),
    }),
    guest(ID.guestBianca, 'Bianca', 'Moreau', 'Example Partners', ['LP', 'Co-investor'], {
      registered_at: at(now, -3, 18),
    }),
    guest(ID.guestCarlos, 'Carlos', 'Ferro', 'Sample Labs', ['Founder']),
    guest(ID.guestDana, 'Dana', 'Whitlock', 'Placeholder Ventures', ['LP'], {
      registered_at: at(now, -1, 14),
    }),
    guest(ID.guestEli, 'Eli', 'Barrow', 'Fictional Fund', ['LP'], {
      registered_at: at(now, -2, 20),
      answers: { [demoEventId(0x401)]: 'Vegetarian' },
    }),
    guest(ID.guestEliPlusOne, 'Rowan', 'Barrow', '', [], {
      parent_guest_id: ID.guestEli,
      email: null,
      source: 'plus_one',
      registered_at: at(now, -2, 20),
    }),
  ];

  const gs = (
    guestId: string,
    sessionId: string,
    status: EventGuestSession['status'],
    extra: Partial<EventGuestSession> = {},
  ): EventGuestSession => ({
    guest_id: guestId,
    session_id: sessionId,
    organization_id: ORG,
    event_id: ID.annualMeeting,
    status,
    requested_at: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    claim_expires_at: null,
    checked_in_at: null,
    checked_in_by: null,
    created_at: created,
    updated_at: nowIso,
    ...extra,
  });

  const event_guest_sessions: EventGuestSession[] = [
    gs(ID.guestAvery, ID.sessionMeeting, 'going', { requested_at: at(now, -4, 17) }),
    gs(ID.guestAvery, ID.sessionReception, 'going', { requested_at: at(now, -4, 17) }),
    gs(ID.guestBianca, ID.sessionMeeting, 'maybe', { requested_at: at(now, -3, 18) }),
    gs(ID.guestBianca, ID.sessionReception, 'going', { requested_at: at(now, -3, 18) }),
    gs(ID.guestCarlos, ID.sessionReception, 'invited'),
    gs(ID.guestDana, ID.sessionMeeting, 'not_going', { requested_at: at(now, -1, 14) }),
    gs(ID.guestDana, ID.sessionReception, 'pending', { requested_at: at(now, -1, 14) }),
    gs(ID.guestEli, ID.sessionReception, 'going', { requested_at: at(now, -2, 20) }),
    gs(ID.guestEliPlusOne, ID.sessionReception, 'going', { requested_at: at(now, -2, 20) }),
  ];

  const event_editors: EventEditor[] = [
    {
      id: ID.editorJordan,
      organization_id: ORG,
      event_id: ID.annualMeeting,
      label: 'Jordan – Example Partners',
      email: 'jordan@example.com',
      role: 'editor',
      scope: { design: false, content: true, sections: 'all', brand_locked: true },
      // The hash of an invented string: this demo link opens nothing.
      token_hash: sha256('demo-event-editor-link-not-a-real-secret'),
      token_hint: 'demo',
      token_version: 1,
      password_hash: null,
      expires_at: at(now, 14, 0),
      revoked_at: null,
      created_by: USER,
      created_at: at(now, -3, 15),
      first_claimed_at: null,
      last_used_at: null,
      last_ip_hash: null,
      last_ua_hash: null,
      use_count: 0,
    },
  ];

  const event_versions: EventVersion[] = [
    {
      id: ID.versionPublished,
      organization_id: ORG,
      event_id: ID.annualMeeting,
      version: 1,
      kind: 'published',
      name: null,
      doc: structuredClone(annualDocJson),
      draft_version: 0,
      author_user_id: USER,
      author_editor_id: null,
      author_name: 'Nick Tippmann',
      created_at: at(now, -5, 16),
    },
  ];

  return {
    events,
    event_sessions,
    event_guests,
    event_guest_sessions,
    event_editors,
    event_versions,
    event_slug_aliases: [],
    event_presence: [],
    event_edits: [],
    event_media: [],
    event_page_views: [],
    event_share_links: [],
  };
}
