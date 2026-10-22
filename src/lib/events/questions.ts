import type {
  EventQuestion,
  EventQuestionType,
  EventRegistrationSettings,
} from '@/lib/types/domain';

/**
 * The registration rules a browser needs too (D-075): question types and
 * labels, the dietary list, which questions are asked (session scope,
 * plus-ones, show-if), answers as text, the response labels and whether
 * RSVPs are open. No zod here, so the guest page's RSVP form stays light;
 * the schemas the server checks with live in ./registration.ts, which
 * re-exports all of this.
 */

export const QUESTION_TYPES = [
  'short_text',
  'long_text',
  'single_choice',
  'multi_choice',
  'yes_no',
  'dietary',
  'company',
  'job_title',
  'linkedin',
  'url',
  'phone',
  'number',
  'terms',
] as const satisfies readonly EventQuestionType[];

export const QUESTION_TYPE_LABELS: Record<EventQuestionType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  single_choice: 'Single choice',
  multi_choice: 'Multiple choice',
  yes_no: 'Yes / no',
  dietary: 'Dietary needs',
  company: 'Company',
  job_title: 'Job title',
  linkedin: 'LinkedIn URL',
  url: 'Website',
  phone: 'Phone',
  number: 'Number',
  terms: 'Terms (typed signature)',
};

/** The preset dietary list (the spec's). "Other" opens a short note. */
export const DIETARY_OPTIONS = [
  'Vegetarian',
  'Vegan',
  'Gluten-free',
  'Dairy-free',
  'Nut allergy',
  'Halal',
  'Kosher',
  'Other',
] as const;

/** Choice types: the host supplies the options (dietary has its own list). */
export function hasOwnOptions(type: EventQuestionType): boolean {
  return type === 'single_choice' || type === 'multi_choice';
}

/**
 * Show-if (v1 nice): one condition. Ask the question only when a session is
 * selected, or when another question's answer equals a value.
 */
export type ShowIf =
  { kind: 'session'; session_id: string } | { kind: 'answer'; question_id: string; equals: string };

/** A stored question (events.questions jsonb) plus its optional condition. */
export type RegistrationQuestion = EventQuestion & { show_if?: ShowIf | null };

/** Live questions in order (removed ones stay stored for exports). */
export function activeQuestions(
  questions: readonly RegistrationQuestion[],
): RegistrationQuestion[] {
  return questions
    .filter((q) => !q.removed_at)
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
}

export interface AnswerContext {
  /** Sessions the person is answering for (selected, or responded Going/Maybe). */
  sessionIds: ReadonlySet<string>;
  /** Their answers so far (for answer conditions). */
  answers: Readonly<Record<string, unknown>>;
  /** Answering as a plus-one: only questions marked ask_plus_ones. */
  plusOne?: boolean;
}

/** Whether one question is asked in this context (session scope, plus-one flag, show-if). */
export function isQuestionAsked(q: RegistrationQuestion, ctx: AnswerContext): boolean {
  if (q.removed_at) return false;
  if (ctx.plusOne && !q.ask_plus_ones) return false;
  if (q.session_id && !ctx.sessionIds.has(q.session_id)) return false;
  const cond = q.show_if;
  if (!cond) return true;
  if (cond.kind === 'session') return ctx.sessionIds.has(cond.session_id);
  const other = ctx.answers[cond.question_id];
  if (Array.isArray(other)) return other.includes(cond.equals);
  if (typeof other === 'boolean') return (other ? 'yes' : 'no') === cond.equals.toLowerCase();
  return typeof other === 'string' && other === cond.equals;
}

/** The questions asked in this context, in order. */
export function questionsAsked(
  questions: readonly RegistrationQuestion[],
  ctx: AnswerContext,
): RegistrationQuestion[] {
  return activeQuestions(questions).filter((q) => isQuestionAsked(q, ctx));
}

/** The free-text note that goes with a dietary "Other". */
export const DIETARY_NOTE_SUFFIX = ':note';

/** An answer as one line of text (guest table, exports, the ticket). */
export function answerText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** The guest-facing response labels for this event. */
export function responseLabels(
  settings: EventRegistrationSettings,
): Record<'going' | 'maybe' | 'not_going', string> {
  return {
    going: settings.response_set.labels.going || 'Going',
    maybe: settings.response_set.labels.maybe || 'Maybe',
    not_going: settings.response_set.labels.not_going || "Can't go",
  };
}

/** Whether registration accepts answers at this moment (toggle + Closes at). */
export function registrationAccepting(
  settings: Pick<EventRegistrationSettings, 'open' | 'closes_at'>,
  now: Date = new Date(),
): boolean {
  if (!settings.open) return false;
  if (settings.closes_at && Date.parse(settings.closes_at) <= now.getTime()) return false;
  return true;
}
