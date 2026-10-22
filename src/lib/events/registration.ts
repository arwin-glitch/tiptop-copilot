import { z } from 'zod';
import {
  DIETARY_NOTE_SUFFIX,
  DIETARY_OPTIONS,
  QUESTION_TYPES,
  hasOwnOptions,
  questionsAsked,
  type AnswerContext,
  type RegistrationQuestion,
} from './questions';
import type { EventAccess, EventGuestWall, EventRegistrationSettings } from '@/lib/types/domain';

/**
 * Registration: the questions a host asks, which ones a guest sees, how an
 * answer is checked, and the shapes the RSVP endpoints accept (D-075).
 *
 * Pure and isomorphic: the RSVP form (client) and the RSVP routes (server)
 * run the same rules, and the server is the boundary. Every schema is strict
 * (unknown keys are refused) and bounded, mirroring the SQL length checks in
 * 20261023000000_events.sql. The zod-free rules a browser also needs live
 * in ./questions.ts and are re-exported here.
 */

export * from './questions';

/* ------------------------------------------------------------- questions */

/** Any lowercase/uppercase hex uuid (ids come from Postgres or newId()). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID_RE, 'Expected an id.')
  .transform((v) => v.toLowerCase());

export const showIfSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), session_id: uuid }),
  z.strictObject({ kind: z.literal('answer'), question_id: uuid, equals: z.string().max(200) }),
]);

export const questionSchema = z
  .strictObject({
    id: uuid,
    type: z.enum(QUESTION_TYPES),
    label: z.string().trim().min(1, 'Every question needs a label.').max(200),
    help: z.string().max(2000).nullable(),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(100)).max(30),
    session_id: uuid.nullable(),
    ask_plus_ones: z.boolean(),
    position: z.number().int().min(0).max(1000),
    removed_at: z.iso.datetime({ offset: true }).nullable(),
    show_if: showIfSchema.nullable().optional(),
  })
  .superRefine((q, ctx) => {
    if (hasOwnOptions(q.type) && q.options.length < 2 && !q.removed_at) {
      ctx.addIssue({ code: 'custom', message: `"${q.label}" needs at least two choices.` });
    }
    if (q.show_if?.kind === 'answer' && q.show_if.question_id === q.id) {
      ctx.addIssue({ code: 'custom', message: `"${q.label}" cannot depend on itself.` });
    }
  });

export const MAX_QUESTIONS = 40;
export const questionsSchema = z.array(questionSchema).max(MAX_QUESTIONS);

const PHONE_RE = /^[+()0-9 .\-x]{5,40}$/;
const LINKEDIN_RE = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/[A-Za-z0-9_\-/%.]{1,200}$/i;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export type AnswerValue = string | string[] | boolean | number;

/**
 * Check and normalise one answer. Null: no answer (allowed unless required).
 * Returns the problem as a sentence the form can show.
 */
export function checkAnswer(
  q: RegistrationQuestion,
  raw: unknown,
): { ok: true; value: AnswerValue | null } | { ok: false; message: string } {
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === 'string' && raw.trim() === '') ||
    (Array.isArray(raw) && raw.length === 0);
  if (empty) {
    return q.required ? { ok: false, message: 'Required.' } : { ok: true, value: null };
  }
  const text = (max: number) =>
    typeof raw === 'string' && raw.trim().length <= max
      ? ({ ok: true, value: raw.trim() } as const)
      : ({ ok: false, message: `Up to ${max} characters.` } as const);

  switch (q.type) {
    case 'short_text':
    case 'company':
    case 'job_title':
      return text(200);
    case 'long_text':
      return text(2000);
    case 'terms':
      // The typed signature: their name.
      return typeof raw === 'string' && raw.trim().length >= 2 && raw.trim().length <= 120
        ? { ok: true, value: raw.trim() }
        : { ok: false, message: 'Type your full name to agree.' };
    case 'phone':
      return typeof raw === 'string' && PHONE_RE.test(raw.trim())
        ? { ok: true, value: raw.trim() }
        : { ok: false, message: 'That does not look like a phone number.' };
    case 'url':
      return typeof raw === 'string' && raw.length <= 500 && isHttpUrl(raw.trim())
        ? { ok: true, value: raw.trim() }
        : { ok: false, message: 'Use a full address starting with https://.' };
    case 'linkedin':
      return typeof raw === 'string' && LINKEDIN_RE.test(raw.trim())
        ? { ok: true, value: raw.trim() }
        : { ok: false, message: 'Use your LinkedIn profile address (https://linkedin.com/in/…).' };
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return Number.isFinite(n) && Math.abs(n) <= 1_000_000
        ? { ok: true, value: n }
        : { ok: false, message: 'Enter a number.' };
    }
    case 'yes_no':
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'yes' || raw === 'no') return { ok: true, value: raw === 'yes' };
      return { ok: false, message: 'Choose yes or no.' };
    case 'single_choice':
      return typeof raw === 'string' && q.options.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, message: 'Choose one of the options.' };
    case 'multi_choice':
    case 'dietary': {
      const allowed: readonly string[] = q.type === 'dietary' ? DIETARY_OPTIONS : q.options;
      const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : null;
      if (
        !values ||
        values.length > allowed.length ||
        values.some((v) => typeof v !== 'string' || !allowed.includes(v))
      ) {
        return { ok: false, message: 'Choose from the options.' };
      }
      return { ok: true, value: [...new Set(values as string[])] };
    }
  }
}

/**
 * Check every asked question's answer. Unasked keys are dropped (never
 * stored), so a crafted body cannot plant answers to hidden questions.
 */
export function checkAnswers(
  questions: readonly RegistrationQuestion[],
  answers: Readonly<Record<string, unknown>>,
  ctx: Omit<AnswerContext, 'answers'>,
):
  | { ok: true; answers: Record<string, AnswerValue> }
  | { ok: false; errors: Record<string, string> } {
  const out: Record<string, AnswerValue> = {};
  const errors: Record<string, string> = {};
  for (const q of questionsAsked(questions, { ...ctx, answers })) {
    const checked = checkAnswer(q, answers[q.id]);
    if (!checked.ok) {
      errors[q.id] = checked.message;
      continue;
    }
    if (checked.value !== null) out[q.id] = checked.value;
    if (q.type === 'dietary') {
      const note = answers[`${q.id}${DIETARY_NOTE_SUFFIX}`];
      if (typeof note === 'string' && note.trim()) {
        if (note.trim().length > 200) errors[q.id] = 'Keep the note under 200 characters.';
        else out[`${q.id}${DIETARY_NOTE_SUFFIX}`] = note.trim();
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers: out };
}

/* ------------------------------------------------------------ submissions */

const name = z.string().trim().max(100);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/, 'Enter a valid email address.');
const answersInput = z
  .record(
    z.string().max(80),
    z.union([z.string().max(2000), z.array(z.string().max(100)).max(30), z.boolean(), z.number()]),
  )
  .refine((a) => Object.keys(a).length <= 2 * MAX_QUESTIONS, 'Too many answers.');
export const RESPONSES = ['going', 'maybe', 'not_going'] as const;
export type GuestResponse = (typeof RESPONSES)[number];

export const MAX_PLUS_ONES = 10;

const plusOneInput = z.strictObject({
  /** An existing plus-one (personal link edits); omitted for a new one. */
  id: uuid.optional(),
  firstName: name.min(1, 'Your guest needs a name.'),
  lastName: name.default(''),
  email: email.optional().or(z.literal('').transform(() => undefined)),
  /** Sessions they come to (when plus-ones are chosen per session). */
  sessions: z.array(uuid).max(20).optional(),
  answers: answersInput.default({}),
});
export type PlusOneInput = z.infer<typeof plusOneInput>;

const utmInput = z
  .strictObject({
    source: z.string().max(100).optional(),
    medium: z.string().max(100).optional(),
    campaign: z.string().max(100).optional(),
  })
  .optional();

/** POST /api/e/<slug>/rsvp: the public form (open or approval), or "Request an invite". */
export const publicRsvpInput = z.strictObject({
  /** Signed render time (lib/events/public-gate.ts). */
  formToken: z.string().max(400),
  /** The honeypot: always empty for people. */
  website: z.string().max(200).optional(),
  turnstileToken: z.string().max(4000).optional(),
  firstName: name.min(1, 'Add your first name.'),
  lastName: name.default(''),
  email,
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  sessions: z.array(uuid).min(1, 'Choose at least one session.').max(20),
  answers: answersInput.default({}),
  plusOnes: z.array(plusOneInput).max(MAX_PLUS_ONES).default([]),
  showOnWall: z.boolean().default(false),
  /** An invite-only page's "Request an invite". */
  request: z.boolean().default(false),
  /** ?via=<partner code> (v1 nice). */
  via: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .optional(),
  utm: utmInput,
});
export type PublicRsvpInput = z.infer<typeof publicRsvpInput>;

/** POST /api/e/<slug>/i/<token>/respond: a personal link's per-session answers. */
export const inviteResponseInput = z.strictObject({
  formToken: z.string().max(400).optional(),
  website: z.string().max(200).optional(),
  /** session id → Going / Maybe / Can't go. Sessions left out are unchanged. */
  responses: z
    .record(uuid, z.enum(RESPONSES))
    .refine(
      (r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 20,
      'Answer for at least one session.',
    ),
  firstName: name.min(1).optional(),
  lastName: name.optional(),
  company: z.string().trim().max(200).optional(),
  title: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  answers: answersInput.default({}),
  /** The full plus-one list (replaces the previous one). Omitted: unchanged. */
  plusOnes: z.array(plusOneInput).max(MAX_PLUS_ONES).optional(),
  showOnWall: z.boolean().optional(),
});
export type InviteResponseInput = z.infer<typeof inviteResponseInput>;

/* -------------------------------------------------- host: registration tab */

export const GUEST_WALL_MODES = [
  'hidden',
  'count',
  'going',
  'public',
] as const satisfies readonly EventGuestWall[];
export const ACCESS_MODES = [
  'open',
  'approval',
  'invite_only',
] as const satisfies readonly EventAccess[];

const label = z.string().trim().min(1).max(40);

export const registrationSettingsSchema = z.strictObject({
  open: z.boolean(),
  closes_at: z.iso.datetime({ offset: true }).nullable(),
  show_remaining: z.boolean(),
  response_set: z.strictObject({
    maybe: z.boolean(),
    labels: z.strictObject({ going: label, maybe: label, not_going: label }),
  }),
  plus_ones: z.strictObject({
    max: z.number().int().min(0).max(MAX_PLUS_ONES),
    per_session: z.boolean(),
    collect_email: z.boolean(),
    ask_questions: z.boolean(),
  }),
  waitlist: z.boolean(),
  auto_promote: z.boolean(),
  claim_window_hours: z.number().int().min(1).max(336).nullable(),
  request_invite: z.boolean(),
  guest_wall: z.enum(GUEST_WALL_MODES),
}) satisfies z.ZodType<EventRegistrationSettings>;

/** PUT /api/events/[id]/registration. Every field optional; sent fields replace. */
export const registrationPatchSchema = z.strictObject({
  access: z.enum(ACCESS_MODES).optional(),
  capacity: z.number().int().min(0).max(100_000).nullable().optional(),
  registration: registrationSettingsSchema.optional(),
  questions: questionsSchema.optional(),
});
export type RegistrationPatch = z.infer<typeof registrationPatchSchema>;

const venueOverride = z
  .strictObject({
    kind: z.enum(['in_person', 'online', 'hybrid']),
    name: z.string().trim().max(200).nullable(),
    address: z.string().trim().max(400).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    place_id: z.string().max(200).nullable(),
    maps_url: z
      .string()
      .max(500)
      .refine((v) => /^https:\/\//i.test(v), 'Maps links start with https://.')
      .nullable(),
    online_url: z
      .string()
      .max(500)
      .refine((v) => /^https:\/\//i.test(v), 'Online links start with https://.')
      .nullable(),
    reveal: z.enum(['public', 'registered', 'going']),
    notes: z.string().max(1000).nullable(),
  })
  .nullable();

const tag = z
  .string()
  .trim()
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{0,39}$/u,
    'Tags are letters, numbers and spaces (up to 40).',
  );

/** One session as the sessions editor sends it. */
export const sessionInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'Name the session.').max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
  ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
  venue: venueOverride.optional(),
  capacity: z.number().int().min(0).max(100_000).nullable().optional(),
  requires_approval: z.boolean().nullable().optional(),
  waitlist: z.boolean().nullable().optional(),
  visible_to_tags: z.array(tag).max(20).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export type SessionInput = z.infer<typeof sessionInputSchema>;

export const guestTagSchema = tag;

/** A walk-in at the door (staff or owner). */
export const walkInInput = z.strictObject({
  firstName: z.string().trim().min(1, 'Add their name.').max(100),
  lastName: z.string().trim().max(100).optional(),
  email: z.string().trim().max(320).optional(),
  company: z.string().trim().max(200).optional(),
  sessionId: uuid,
});
