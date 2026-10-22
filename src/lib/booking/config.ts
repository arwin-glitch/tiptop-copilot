import { z } from 'zod';

/**
 * The booking link's settings (Settings > Booking link), as data: who the
 * public page shows, where the host meets people, and the rules every open
 * slot is checked against. Pure and client-safe: the Settings form, the
 * public page and the server all read the same shape and the same defaults.
 *
 * Stored as one jsonb document per organization (booking_settings.settings),
 * read through `parseBookingConfig`, which fills every missing or unreadable
 * field with its default rather than refusing the whole document: a setting
 * added later never breaks a row saved before it.
 *
 * Nothing here names a real person or place. Nick's display name, bio,
 * photo, home city and places are typed in Settings and live only in the
 * database.
 */

export const MEETING_TYPES = ['call', 'in_person'] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MEETING_KINDS = ['coffee', 'lunch', 'dinner'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const KIND_LABEL: Record<MeetingKind, string> = {
  coffee: 'Coffee',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

/** Minutes each meeting type lasts. Fixed: the page offers exactly these two. */
export const MEETING_MINUTES: Record<MeetingType, number> = { call: 30, in_person: 60 };

export const TYPE_LABEL: Record<MeetingType, string> = {
  call: '30-minute call',
  in_person: '1-hour in person',
};

/** ISO weekday numbers (Mon=1 ... Sun=7). Only Tuesday to Thursday may ever be offered. */
export const ALLOWED_WEEKDAYS = [2, 3, 4] as const;
export const WEEKDAY_NAME: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

/** A wall-clock time in the host's zone, "HH:MM", 24-hour. */
const CLOCK = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30.');

/**
 * A window of host time. `from` may equal `to`: a start window that holds one
 * start (dinner starts at 18:00 and nowhere else).
 */
export const TIME_WINDOW = z
  .object({ from: CLOCK, to: CLOCK })
  .refine((w) => w.from <= w.to, 'A window has to end after it starts.');
export type TimeWindow = z.infer<typeof TIME_WINDOW>;

/**
 * The hard bounds on the hours, host time (Central, America/Chicago: CDT
 * until 1 November, CST after). Whatever Settings holds, nothing starts
 * before 8:00; calls, coffee and lunch end by 18:00 (the last call 17:30 to
 * 18:00, the last coffee 17:00 to 18:00); dinner is 18:00 to 19:00 and
 * nothing else. The engine checks them on every offer and on every re-check
 * of a stored time (lib/booking/engine.ts), Settings refuses a window
 * outside them, and a stored window is clamped into them.
 */
export const BOOKING_EARLIEST_START = '08:00';
export const BOOKING_LATEST_END = '18:00';
export const DINNER_WINDOW = { from: '18:00', to: '19:00' } as const;

/** The hint over Settings > Booking link > Times. */
export const BOOKING_HOURS_HINT = '8:00 AM to 6:00 PM Central; dinner 6-7 PM.';

/** "09:30" as minutes after midnight. */
export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function clockOf(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  return `${h}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The window a whole call must sit inside. */
export const CALL_BOUNDS: TimeWindow = { from: BOOKING_EARLIEST_START, to: BOOKING_LATEST_END };

/** The latest start of an hour that ends by 18:00. */
const LAST_HOUR_START = clockOf(clockMinutes(BOOKING_LATEST_END) - MEETING_MINUTES.in_person);

/**
 * The start windows each in-person kind is held to: an hour long, so coffee
 * and lunch start by 17:00 to end by 18:00, and dinner starts at 18:00.
 */
export const KIND_START_BOUNDS: Record<MeetingKind, TimeWindow> = {
  coffee: { from: BOOKING_EARLIEST_START, to: LAST_HOUR_START },
  lunch: { from: BOOKING_EARLIEST_START, to: LAST_HOUR_START },
  dinner: {
    from: DINNER_WINDOW.from,
    to: clockOf(clockMinutes(DINNER_WINDOW.to) - MEETING_MINUTES.in_person),
  },
};

/** Whether a window lies inside its bounds. */
export function windowWithin(window: TimeWindow, bounds: TimeWindow): boolean {
  return window.from >= bounds.from && window.to <= bounds.to;
}

/**
 * A window cut down to its bounds, or null when none of it is inside them
 * (a stored window that would otherwise shrink to a start nobody chose).
 */
export function clampWindow(window: TimeWindow, bounds: TimeWindow): TimeWindow | null {
  if (window.to < bounds.from || window.from > bounds.to) return null;
  return {
    from: window.from < bounds.from ? bounds.from : window.from,
    to: window.to > bounds.to ? bounds.to : window.to,
  };
}

const HTTP_URL = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\/[^\s"<>]+$/i.test(v), 'Use a link that starts with https://');

export const PLACE = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  area: z.string().trim().max(80).default(''),
  mapUrl: HTTP_URL.nullable().default(null),
});
export type Place = z.infer<typeof PLACE>;

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type PhotoType = (typeof PHOTO_TYPES)[number];
const PHOTO_EXT: Record<PhotoType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The one shape a stored photo path may have: Copilot names it on upload
 * (booking/<organization>/host-photo-<version>.<ext>), so a path with "..",
 * another folder or another file is never read back.
 */
const PHOTO_PATH = /^booking\/[0-9a-f-]{36}\/host-photo-[0-9a-f]{8}\.(?:jpg|png|webp)$/;

export const PHOTO_REF = z.object({
  path: z.string().regex(PHOTO_PATH),
  type: z.enum(PHOTO_TYPES),
  /** Changes with every upload, so the page's photo URL changes and caches refresh. */
  version: z.string().regex(/^[0-9a-f]{8}$/),
});
export type PhotoRef = z.infer<typeof PHOTO_REF>;

/** Where an uploaded host photo is kept in the private bucket. */
export function bookingPhotoPath(organizationId: string, version: string, type: PhotoType): string {
  return `booking/${organizationId}/host-photo-${version}.${PHOTO_EXT[type]}`;
}

/**
 * Whether a stored photo names exactly the file Copilot would have written
 * for this organization: the only one the photo routes serve or remove.
 */
export function isOwnPhotoPath(
  organizationId: string,
  photo: Pick<PhotoRef, 'path' | 'type' | 'version'>,
): boolean {
  return (
    PHOTO_PATH.test(photo.path) &&
    (PHOTO_TYPES as readonly string[]).includes(photo.type) &&
    photo.path === bookingPhotoPath(organizationId, photo.version, photo.type)
  );
}

/** Everything Settings > Booking link edits, apart from on/off and the slug. */
export interface BookingConfig {
  displayName: string;
  title: string;
  bio: string;
  firmName: string;
  /** The city the host lives in: in person only on days he is there. */
  homeCity: string;
  /** Other names the home city goes by in an address (a neighbourhood, a suburb). */
  homeAliases: string[];
  places: Place[];
  /** Visitors may suggest a place of their own (free text) as well as pick one. */
  allowCustomPlace: boolean;
  /** Which of Tuesday to Thursday are offered (ISO weekdays, a subset of 2..4). */
  weekdays: number[];
  /** Calls: the whole call sits inside this window, host time (inside CALL_BOUNDS). */
  callWindow: TimeWindow;
  /**
   * In person: the start-time windows of each kind, host time (start inside,
   * inclusive; inside KIND_START_BOUNDS).
   */
  kindWindows: Record<MeetingKind, TimeWindow[]>;
  /** Minutes kept free before and after any existing meeting, for a call. */
  callBufferMinutes: number;
  /** The same for an in-person meeting (travel time), and around any existing in-person one. */
  inPersonBufferMinutes: number;
  /** A run of this many back-to-back meetings blocks the time around it. */
  stackSize: number;
  /** Meetings closer than this count as back to back. */
  stackGapMinutes: number;
  /** Nothing is offered within this long after such a run. */
  stackCooldownMinutes: number;
  /**
   * Nor within this long before it (for a call too, whose usual buffer is
   * shorter): the free half hour before a stack stays free.
   */
  stackLeadMinutes: number;
  noticeHours: number;
  horizonDays: number;
  /** Link bookings (waiting and approved) a day can hold. */
  maxLinkBookingsPerDay: number;
  /** A day with this many meetings already offers nothing. */
  maxMeetingsPerDay: number;
  /**
   * Instant booking (D-074 addendum): on, a request for a free time is booked
   * straight away through Approve's own core (the live re-check, the event on
   * the host's main calendar, the invitation); one that cannot be booked then
   * waits for Approve. Off, every request waits for Approve.
   */
  instant: boolean;
  chatbotEnabled: boolean;
  /** The only TipTop facts the public chatbot may give. */
  faq: string;
  /** The public chatbot stops using the model past this much spend in a month. */
  monthlyAiCapUsd: number;
  photo: PhotoRef | null;
  /**
   * The host's own video link (a Zoom room, say), put in every call invite
   * instead of a Google Meet; '' for Google Meet. Only the invite carries it:
   * the public page, its routes and its chatbot show what it is, never the link.
   */
  callLink: string;
}

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  displayName: '',
  title: '',
  bio: '',
  firmName: 'TipTop Ventures',
  homeCity: '',
  homeAliases: [],
  places: [],
  allowCustomPlace: true,
  weekdays: [...ALLOWED_WEEKDAYS],
  callWindow: { from: '08:00', to: '18:00' },
  kindWindows: {
    coffee: [
      { from: '08:00', to: '11:00' },
      { from: '14:00', to: '17:00' },
    ],
    lunch: [{ from: '11:30', to: '13:00' }],
    dinner: [{ from: '18:00', to: '18:00' }],
  },
  callBufferMinutes: 15,
  inPersonBufferMinutes: 30,
  stackSize: 3,
  stackGapMinutes: 15,
  stackCooldownMinutes: 60,
  stackLeadMinutes: 30,
  noticeHours: 24,
  horizonDays: 21,
  maxLinkBookingsPerDay: 2,
  maxMeetingsPerDay: 5,
  instant: true,
  chatbotEnabled: true,
  faq: '',
  monthlyAiCapUsd: 20,
  photo: null,
  callLink: '',
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** A coffee or lunch start window, held inside its bounds. */
const kindWindow = (kind: 'coffee' | 'lunch', label: string) =>
  TIME_WINDOW.refine(
    (w) => windowWithin(w, KIND_START_BOUNDS[kind]),
    `${label} has to start between 8:00 AM and 5:00 PM Central, so it ends by 6:00 PM`,
  );

function isHttpsLink(value: string): boolean {
  if (!/^https:\/\/[^\s"<>]+$/i.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** A video link for calls: '' (Google Meet), or an https link of at most 500 characters. */
const CALL_LINK = z
  .string()
  .trim()
  .max(500, 'Use a link of at most 500 characters.')
  .refine((v) => v === '' || isHttpsLink(v), 'Use a video link that starts with https://');

/** The shape Settings saves: strict, every field required, every value bounded. */
export const BOOKING_CONFIG_SCHEMA = z
  .object({
    displayName: z.string().trim().max(80),
    title: z.string().trim().max(120),
    bio: z.string().trim().max(600),
    firmName: z.string().trim().max(80),
    homeCity: z.string().trim().max(80),
    homeAliases: z.array(z.string().trim().min(1).max(60)).max(10),
    places: z
      .array(PLACE)
      .max(20)
      .refine((list) => new Set(list.map((p) => p.id)).size === list.length, 'Place ids repeat.'),
    allowCustomPlace: z.boolean(),
    weekdays: z
      .array(z.number().int())
      .max(3)
      .refine(
        (days) => days.every((d) => (ALLOWED_WEEKDAYS as readonly number[]).includes(d)),
        'Only Tuesday, Wednesday and Thursday can be offered.',
      ),
    callWindow: TIME_WINDOW.refine(
      (w) => windowWithin(w, CALL_BOUNDS),
      'Calls have to be between 8:00 AM and 6:00 PM Central',
    ),
    kindWindows: z.object({
      coffee: z.array(kindWindow('coffee', 'Coffee')).max(4),
      lunch: z.array(kindWindow('lunch', 'Lunch')).max(4),
      dinner: z
        .array(
          TIME_WINDOW.refine(
            (w) => windowWithin(w, KIND_START_BOUNDS.dinner),
            'Dinner is 6:00 to 7:00 PM Central, so it starts at 6:00 PM',
          ),
        )
        .max(4),
    }),
    callBufferMinutes: int(15, 120),
    inPersonBufferMinutes: int(30, 180),
    stackSize: int(2, 8),
    stackGapMinutes: int(0, 60),
    stackCooldownMinutes: int(0, 240),
    stackLeadMinutes: int(15, 120),
    noticeHours: int(24, 24 * 14),
    horizonDays: int(1, 45),
    maxLinkBookingsPerDay: int(0, 10),
    maxMeetingsPerDay: int(1, 15),
    instant: z.boolean(),
    chatbotEnabled: z.boolean(),
    faq: z.string().max(4000),
    monthlyAiCapUsd: z.number().min(0).max(500),
    photo: PHOTO_REF.nullable(),
    callLink: CALL_LINK,
  })
  .strict();

/**
 * The windows every link had before the hours got their hard bounds
 * (22 October 2026). A stored window still equal to one of them was never
 * chosen, only saved along with the rest, so it reads as today's default.
 */
const EARLIER_DEFAULT_WINDOWS: Partial<Record<'callWindow' | MeetingKind, TimeWindow[]>> = {
  callWindow: [{ from: '09:00', to: '17:00' }],
  coffee: [
    { from: '08:30', to: '11:00' },
    { from: '14:00', to: '16:00' },
  ],
  dinner: [{ from: '18:00', to: '19:30' }],
};

function sameWindows(a: readonly TimeWindow[], b: readonly TimeWindow[] | undefined): boolean {
  return Boolean(
    b && a.length === b.length && a.every((w, i) => w.from === b[i]!.from && w.to === b[i]!.to),
  );
}

/** A stored call window, clamped into the bounds; the default when unreadable or wholly outside. */
function readCallWindow(raw: unknown): TimeWindow {
  const parsed = TIME_WINDOW.safeParse(raw);
  const clamped =
    parsed.success && !sameWindows([parsed.data], EARLIER_DEFAULT_WINDOWS.callWindow)
      ? clampWindow(parsed.data, CALL_BOUNDS)
      : null;
  return clamped ?? structuredClone(DEFAULT_BOOKING_CONFIG.callWindow);
}

/**
 * Stored start windows, kind by kind, each clamped into its kind's bounds: a
 * window wholly outside them is dropped, and an unreadable list takes its
 * kind's default.
 */
function readKindWindows(raw: unknown): Record<MeetingKind, TimeWindow[]> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<MeetingKind, TimeWindow[]>;
  for (const kind of MEETING_KINDS) {
    const parsed = z.array(TIME_WINDOW).max(4).safeParse(source[kind]);
    if (!parsed.success || sameWindows(parsed.data, EARLIER_DEFAULT_WINDOWS[kind])) {
      out[kind] = structuredClone(DEFAULT_BOOKING_CONFIG.kindWindows[kind]);
      continue;
    }
    out[kind] = parsed.data.flatMap((w) => {
      const clamped = clampWindow(w, KIND_START_BOUNDS[kind]);
      return clamped ? [clamped] : [];
    });
  }
  return out;
}

/**
 * A stored document read leniently: each field that is missing or fails its
 * check takes its default, so one bad value never hides the rest. Buffers,
 * notice and the weekday list can only be tightened, never loosened, past
 * the standing rules (15 and 30 minutes, 24 hours, Tuesday to Thursday), and
 * the hours are clamped into their hard bounds (8:00 to 18:00, dinner 18:00
 * to 19:00).
 */
export function parseBookingConfig(raw: unknown): BookingConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const shape = BOOKING_CONFIG_SCHEMA.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as (keyof BookingConfig)[]) {
    const parsed = (shape[key] as z.ZodType).safeParse(source[key]);
    out[key] = parsed.success ? parsed.data : structuredClone(DEFAULT_BOOKING_CONFIG[key]);
  }
  out.callWindow = readCallWindow(source.callWindow);
  out.kindWindows = readKindWindows(source.kindWindows);
  return out as unknown as BookingConfig;
}

/** Slugs a booking link may not take: words that read as the app's own pages. */
const RESERVED_SLUGS = new Set(['api', 'admin', 'login', 'settings', 'photo', 'new', 'edit']);

export const SLUG = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'Use 1 to 40 lowercase letters, numbers and dashes.',
  )
  .refine((s) => !RESERVED_SLUGS.has(s), 'That word is kept for the app. Pick another.');

/** The host's first name, for "Nick's AI scheduling assistant". */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** Whether in-person meetings can be offered at all: a home city, and somewhere to meet. */
export function inPersonOffered(
  config: Pick<BookingConfig, 'homeCity' | 'places' | 'allowCustomPlace'>,
) {
  return Boolean(config.homeCity.trim()) && (config.places.length > 0 || config.allowCustomPlace);
}
