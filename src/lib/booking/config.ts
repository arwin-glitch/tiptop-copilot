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

export const TIME_WINDOW = z
  .object({ from: CLOCK, to: CLOCK })
  .refine((w) => w.from <= w.to, 'A window has to end after it starts.');
export type TimeWindow = z.infer<typeof TIME_WINDOW>;

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

export const PHOTO_REF = z.object({
  path: z.string().min(1).max(300),
  type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** Changes with every upload, so the page's photo URL changes and caches refresh. */
  version: z.string().min(1).max(40),
});
export type PhotoRef = z.infer<typeof PHOTO_REF>;

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
  /** Calls: the whole call sits inside this window, host time. */
  callWindow: TimeWindow;
  /** In person: the start-time windows of each kind, host time (start inside, inclusive). */
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
   * Stored for later. In this version Copilot writes to the calendar only on
   * a person's Approve (never from the public page), so with it on a request
   * is only tagged "Instant" in the drawer (D-074).
   */
  instant: boolean;
  chatbotEnabled: boolean;
  /** The only TipTop facts the public chatbot may give. */
  faq: string;
  /** The public chatbot stops using the model past this much spend in a month. */
  monthlyAiCapUsd: number;
  photo: PhotoRef | null;
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
  callWindow: { from: '09:00', to: '17:00' },
  kindWindows: {
    coffee: [
      { from: '08:30', to: '11:00' },
      { from: '14:00', to: '16:00' },
    ],
    lunch: [{ from: '11:30', to: '13:00' }],
    dinner: [{ from: '18:00', to: '19:30' }],
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
  instant: false,
  chatbotEnabled: true,
  faq: '',
  monthlyAiCapUsd: 20,
  photo: null,
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);

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
    callWindow: TIME_WINDOW,
    kindWindows: z.object({
      coffee: z.array(TIME_WINDOW).max(4),
      lunch: z.array(TIME_WINDOW).max(4),
      dinner: z.array(TIME_WINDOW).max(4),
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
  })
  .strict();

/**
 * A stored document read leniently: each field that is missing or fails its
 * check takes its default, so one bad value never hides the rest. Buffers,
 * notice and the weekday list can only be tightened, never loosened, past
 * the standing rules (15 and 30 minutes, 24 hours, Tuesday to Thursday).
 */
export function parseBookingConfig(raw: unknown): BookingConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const shape = BOOKING_CONFIG_SCHEMA.shape;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as (keyof BookingConfig)[]) {
    const parsed = (shape[key] as z.ZodType).safeParse(source[key]);
    out[key] = parsed.success ? parsed.data : structuredClone(DEFAULT_BOOKING_CONFIG[key]);
  }
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
