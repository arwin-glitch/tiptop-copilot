import { z } from 'zod';
import { MAX_GUESTS, MEETING_KINDS, type MeetingKind, type MeetingType } from './config';

/**
 * What a visitor may send from the public booking page, and what the public
 * chatbot may put in that form for them. Pure and client-safe: the page
 * checks the same rules before sending, the server decides with them.
 *
 * Every text has a length cap, a deck link must be http or https, and a
 * `website` field no person sees catches form-filling robots (a honeypot:
 * the server answers as if all went well and keeps nothing).
 */

export const LIMITS = {
  name: 120,
  email: 254,
  company: 120,
  note: 2000,
  deckUrl: 500,
  customPlace: 160,
} as const;

/**
 * A plain address: letters, digits and . _ % + ' - before the @, dotted
 * labels after it, a top-level part of two or more letters. No "?cc=" or
 * "&body=" (a mailto link built from it would carry them), no doubled dots,
 * no invisible or right-to-left characters.
 */
const EMAIL =
  /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export const EMAIL_INPUT = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.email)
  .refine((v) => EMAIL.test(v), 'Check your email address.');

/**
 * Text a visitor typed, made plain: no control characters, no invisible or
 * direction-changing characters (they can make a name read as something
 * else), and no angle brackets (the note reaches a Google Calendar
 * description, which reads HTML). One-line fields also lose line breaks.
 */
const clean = (max: number, oneLine = false) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => {
      let out = v.replace(/\p{Cf}/gu, '').replace(/[<>]/g, '');
      if (oneLine) out = out.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
      return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    });

export const DECK_URL = z
  .string()
  .trim()
  .max(LIMITS.deckUrl)
  .refine((v) => v === '' || /^https?:\/\/[^\s"<>]+\.[^\s"<>]+$/i.test(v), {
    message: 'Use a link that starts with https://',
  });

export const REQUEST_TYPES = ['call', 'in_person', 'message'] as const;
export type RequestType = MeetingType | 'message';

export const BOOKING_REQUEST_INPUT = z
  .object({
    name: clean(LIMITS.name, true).pipe(z.string().min(1, 'Add your name.')),
    email: EMAIL_INPUT,
    company: clean(LIMITS.company, true).default(''),
    type: z.enum(REQUEST_TYPES),
    kind: z.enum(MEETING_KINDS).nullable().default(null),
    /** The slot's start, as the page was given it. Null for a message. */
    start: z.string().max(40).nullable().default(null),
    placeId: z.string().max(40).nullable().default(null),
    customPlace: clean(LIMITS.customPlace, true).default(''),
    note: clean(LIMITS.note).default(''),
    deckUrl: DECK_URL.default(''),
    /**
     * Guests to invite with them (Calendly's "Add guests", D-078): plain
     * addresses, at most MAX_GUESTS here and Settings' own limit on the
     * server. Checked again with the host's and the team's addresses there.
     */
    guests: z
      .array(z.string().max(LIMITS.email + 10))
      .max(MAX_GUESTS)
      .default([]),
    /** The visitor's own zone, to say the time back to them in the drawer. */
    timeZone: z.string().max(64).nullable().default(null),
    /** Who filled the form: the visitor, or the chatbot for them (they still pressed Send). */
    source: z.enum(['form', 'chatbot']).default('form'),
    /** The honeypot. A person never sees it, so it is always empty. */
    website: z.string().max(200).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'message') {
      if (!value.note && !value.deckUrl) {
        ctx.addIssue({ code: 'custom', path: ['note'], message: 'Write your message.' });
      }
      return;
    }
    if (!value.start) ctx.addIssue({ code: 'custom', path: ['start'], message: 'Pick a time.' });
    if (value.type === 'in_person') {
      if (!value.kind) {
        ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Pick coffee, lunch or dinner.' });
      }
      if (!value.placeId && !value.customPlace) {
        ctx.addIssue({ code: 'custom', path: ['placeId'], message: 'Pick or suggest a place.' });
      }
    }
  });

export type BookingRequestInput = z.infer<typeof BOOKING_REQUEST_INPUT>;

/** Whether a string is a plain address the page and the server both accept. */
export function isPlainEmail(value: string): boolean {
  return EMAIL_INPUT.safeParse(value).success;
}

export interface GuestRules {
  /** The booker's own address: never their own guest. */
  booker: string;
  /** Addresses that are never a guest: the host's and every teammate's. */
  blocked: readonly string[];
  /** Settings' limit (0 when guests are off). */
  max: number;
}

/**
 * The guests a booking may invite, cleaned: trimmed, lower-cased, plain
 * addresses only, each once, never the booker's own address, never the
 * host's or a teammate's. A problem in plain words when one is not allowed,
 * so the visitor can fix it rather than have a guest silently dropped.
 */
export function cleanGuests(
  raw: readonly string[],
  rules: GuestRules,
): { ok: true; guests: string[] } | { ok: false; problem: string } {
  const booker = rules.booker.trim().toLowerCase();
  const blocked = new Set(rules.blocked.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (!isPlainEmail(email)) return { ok: false, problem: `Check the guest address ${email}.` };
    if (email === booker) {
      return { ok: false, problem: 'You are invited already: add other people as guests.' };
    }
    if (blocked.has(email)) {
      return { ok: false, problem: `${email} is on the host's side already. Leave them out.` };
    }
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > rules.max) {
    return rules.max === 0
      ? { ok: false, problem: 'This booking link does not take guests.' }
      : { ok: false, problem: `Add at most ${rules.max} guests.` };
  }
  return { ok: true, guests: out };
}

/** The longest note a visitor may leave the host when they cancel. */
export const CANCEL_NOTE_MAX = 500;

/** Cancelling from the booking's own page: an optional note to the host. */
export const CANCEL_INPUT = z
  .object({
    note: clean(CANCEL_NOTE_MAX).default(''),
    website: z.string().max(200).default(''),
  })
  .strict();

/** Moving a booking from its own page: the new start, as the page was given it. */
export const RESCHEDULE_INPUT = z
  .object({
    start: z.string().max(40),
    website: z.string().max(200).default(''),
  })
  .strict();

/** The first problem with a request, in plain words, for the page to show. */
export function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the form.';
  if (issue.code === 'too_big') return 'One of the fields is too long.';
  return issue.message || 'Check the form.';
}

/** The form state the page keeps. */
export interface BookingFormState {
  type: RequestType;
  kind: MeetingKind | null;
  start: string | null;
  placeId: string | null;
  customPlace: string;
  name: string;
  email: string;
  company: string;
  note: string;
  deckUrl: string;
  /** Guests to invite with the visitor (D-078). */
  guests: string[];
}

export const EMPTY_FORM: BookingFormState = {
  type: 'call',
  kind: null,
  start: null,
  placeId: null,
  customPlace: '',
  name: '',
  email: '',
  company: '',
  note: '',
  deckUrl: '',
  guests: [],
};

/**
 * A change to the form, as the page makes one: the fields named are set
 * (null clears a time or a place). Another kind of meeting clears a time
 * picked for the old one, and only an in-person meeting keeps a kind.
 */
export function patchForm(
  form: BookingFormState,
  patch: Partial<BookingFormState>,
): BookingFormState {
  const next: BookingFormState = { ...form, ...patch };
  const retimed = 'start' in patch;
  if (patch.type !== undefined && patch.type !== form.type && !retimed) next.start = null;
  if (patch.kind !== undefined && patch.kind !== form.kind && !retimed) next.start = null;
  if (next.type !== 'in_person') next.kind = null;
  return next;
}
