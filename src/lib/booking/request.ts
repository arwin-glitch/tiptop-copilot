import { z } from 'zod';
import { MEETING_KINDS, type MeetingKind, type MeetingType } from './config';

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

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;

/** No control characters, no angle brackets: the text is shown as text everywhere anyway. */
const clean = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));

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
    name: clean(LIMITS.name).pipe(z.string().min(1, 'Add your name.')),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(LIMITS.email)
      .refine((v) => EMAIL.test(v), 'Check your email address.'),
    company: clean(LIMITS.company).default(''),
    type: z.enum(REQUEST_TYPES),
    kind: z.enum(MEETING_KINDS).nullable().default(null),
    /** The slot's start, as the page was given it. Null for a message. */
    start: z.string().max(40).nullable().default(null),
    placeId: z.string().max(40).nullable().default(null),
    customPlace: clean(LIMITS.customPlace).default(''),
    note: clean(LIMITS.note).default(''),
    deckUrl: DECK_URL.default(''),
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

/** The first problem with a request, in plain words, for the page to show. */
export function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Check the form.';
  if (issue.code === 'too_big') return 'One of the fields is too long.';
  return issue.message || 'Check the form.';
}

/**
 * What the public chatbot may put in the form: every field optional, the
 * same caps, and nothing the visitor would not see before pressing Send.
 */
export const CHAT_FORM_FILL = z
  .object({
    name: clean(LIMITS.name).optional(),
    email: z.string().trim().toLowerCase().max(LIMITS.email).optional(),
    company: clean(LIMITS.company).optional(),
    type: z.enum(REQUEST_TYPES).optional(),
    kind: z.enum(MEETING_KINDS).optional(),
    start: z.string().max(40).optional(),
    placeId: z.string().max(40).optional(),
    customPlace: clean(LIMITS.customPlace).optional(),
    note: clean(LIMITS.note).optional(),
    deckUrl: DECK_URL.optional(),
  })
  .strict();

export type ChatFormFill = z.infer<typeof CHAT_FORM_FILL>;

/** The form state the page keeps, which the chatbot's fill merges into. */
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

/** A chatbot's fill merged into the form: only the fields it names change. */
export function applyFill(form: BookingFormState, fill: ChatFormFill): BookingFormState {
  const patch: Partial<BookingFormState> = {};
  for (const [key, value] of Object.entries(fill) as [keyof ChatFormFill, string | undefined][]) {
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  return patchForm(form, patch);
}
