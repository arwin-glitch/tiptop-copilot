import { z } from 'zod';

/**
 * The public booking assistant's settings (the Booking tab's "Assistant"
 * panel, D-078): whether it shows on the page, the questions and answers it
 * may give, and whether a question it cannot match may go to the booking
 * assistant routine (Arwin's own Claude plan, no API key, no spend).
 *
 * Stored inside the booking link's settings document as `settings.chatbot`
 * and read leniently, like the rest of that document: a missing or bad
 * field takes its default and never hides the others. A row saved before
 * this existed still works: the old `chatbotEnabled` switch and the old
 * free-text `faq` are read in its place (`readChatbotConfig`).
 *
 * Pure and client-safe: the panel, the public widget and the server all
 * read the same shape. Nothing here names a real person or fact; the
 * answers are typed in Copilot and live only in the database.
 */

export const FAQ_LIMITS = { items: 30, question: 200, answer: 800 } as const;

export const DAILY_AI_CAP_DEFAULT = 15;
export const DAILY_AI_CAP_MAX = 30;

export interface FaqItem {
  q: string;
  a: string;
}

export interface ChatbotConfig {
  /** The assistant shows on the public booking page. */
  enabled: boolean;
  /** What it may answer, word for word. The only firm facts it gives. */
  faqItems: FaqItem[];
  /**
   * A question no answer matches may go to the booking assistant routine
   * (it needs BOOKING_CHAT_FIRE_URL and BOOKING_CHAT_TOKEN as well).
   */
  aiAnswers: boolean;
  /** Questions the routine may take a day, for the whole link. */
  dailyAiCap: number;
}

export const DEFAULT_CHATBOT_CONFIG: ChatbotConfig = {
  enabled: true,
  faqItems: [],
  aiAnswers: false,
  dailyAiCap: DAILY_AI_CAP_DEFAULT,
};

/**
 * Text Arwin typed, made plain: no control or invisible characters and no
 * angle brackets. Line breaks stay in an answer (it may list things) and go
 * from a question.
 */
export function plainFaqText(value: string, oneLine: boolean): string {
  let out = value
    .replace(/\p{Cf}/gu, '')
    .replace(/<[^<>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  out = oneLine ? out.replace(/[\r\n\t]+/g, ' ') : out.replace(/\r\n?/g, '\n');
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const FAQ_ITEM = z
  .object({
    q: z
      .string()
      .max(FAQ_LIMITS.question * 2)
      .transform((v) => plainFaqText(v, true))
      .pipe(
        z
          .string()
          .min(1, 'Every answer needs its question.')
          .max(FAQ_LIMITS.question, `Keep a question under ${FAQ_LIMITS.question} characters.`),
      ),
    a: z
      .string()
      .max(FAQ_LIMITS.answer * 2)
      .transform((v) => plainFaqText(v, false))
      .pipe(
        z
          .string()
          .min(1, 'Every question needs its answer.')
          .max(FAQ_LIMITS.answer, `Keep an answer under ${FAQ_LIMITS.answer} characters.`),
      ),
  })
  .strict();

export const FAQ_ITEMS = z
  .array(FAQ_ITEM)
  .max(FAQ_LIMITS.items, `At most ${FAQ_LIMITS.items} questions.`);

/** The shape the panel saves: strict, every value bounded. */
export const CHATBOT_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean(),
    faqItems: FAQ_ITEMS,
    aiAnswers: z.boolean(),
    dailyAiCap: z.number().int().min(0).max(DAILY_AI_CAP_MAX),
  })
  .strict();

/** A save from the panel: any of the fields, merged onto what is stored. */
export const CHATBOT_CONFIG_PATCH = CHATBOT_CONFIG_SCHEMA.partial().strict();
export type ChatbotConfigPatch = z.infer<typeof CHATBOT_CONFIG_PATCH>;

/**
 * The old free-text FAQ as questions and answers: "Q: … / A: …" pairs when
 * it was written that way; otherwise one answer per line, its question the
 * words before a colon ("Stage: pre-seed" answers "Stage"), and a line with
 * no label answering "About <firm>".
 */
export function legacyFaqItems(text: unknown, firmName: unknown): FaqItem[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const firm = typeof firmName === 'string' && firmName.trim() ? firmName.trim() : 'the firm';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: FaqItem[] = [];
  const push = (q: string, a: string) => {
    const item = FAQ_ITEM.safeParse({
      q: q.slice(0, FAQ_LIMITS.question),
      a: a.slice(0, FAQ_LIMITS.answer),
    });
    if (item.success && out.length < FAQ_LIMITS.items) out.push(item.data);
  };
  if (lines.some((l) => /^q\s*[:.)-]/i.test(l))) {
    let q: string | null = null;
    let a: string[] = [];
    const flush = () => {
      if (q && a.length) push(q, a.join('\n'));
      q = null;
      a = [];
    };
    for (const line of lines) {
      if (/^q\s*[:.)-]/i.test(line)) {
        flush();
        q = line.replace(/^q\s*[:.)-]\s*/i, '');
      } else if (q) {
        a.push(line.replace(/^a\s*[:.)-]\s*/i, ''));
      }
    }
    flush();
    return out;
  }
  const unlabelled: string[] = [];
  for (const line of lines) {
    const label = /^([^:]{2,60}):\s*(.+)$/.exec(line);
    if (label && !/^https?$/i.test(label[1]!.trim())) push(label[1]!.trim(), line);
    else unlabelled.push(line);
  }
  if (unlabelled.length) out.unshift(...legacyAbout(firm, unlabelled.join('\n')));
  return out.slice(0, FAQ_LIMITS.items);
}

function legacyAbout(firm: string, answer: string): FaqItem[] {
  const item = FAQ_ITEM.safeParse({
    q: `About ${firm}`.slice(0, FAQ_LIMITS.question),
    a: answer.slice(0, FAQ_LIMITS.answer),
  });
  return item.success ? [item.data] : [];
}

/**
 * The assistant's settings from a stored booking settings document. Reads
 * `settings.chatbot` field by field; with no `chatbot` saved yet, the old
 * `chatbotEnabled` switch and free-text `faq` stand in for it.
 */
export function readChatbotConfig(rawSettings: unknown): ChatbotConfig {
  const settings =
    rawSettings && typeof rawSettings === 'object' ? (rawSettings as Record<string, unknown>) : {};
  const stored =
    settings.chatbot && typeof settings.chatbot === 'object'
      ? (settings.chatbot as Record<string, unknown>)
      : null;
  const shape = CHATBOT_CONFIG_SCHEMA.shape;
  const field = <K extends keyof ChatbotConfig>(key: K, fallback: ChatbotConfig[K]) => {
    const parsed = (shape[key] as z.ZodType).safeParse(stored?.[key]);
    return parsed.success ? (parsed.data as ChatbotConfig[K]) : fallback;
  };
  const legacyEnabled =
    typeof settings.chatbotEnabled === 'boolean'
      ? settings.chatbotEnabled
      : DEFAULT_CHATBOT_CONFIG.enabled;
  const faqItems = stored
    ? readItems(stored.faqItems)
    : legacyFaqItems(settings.faq, settings.firmName);
  return {
    enabled: field('enabled', legacyEnabled),
    faqItems,
    aiAnswers: field('aiAnswers', DEFAULT_CHATBOT_CONFIG.aiAnswers),
    dailyAiCap: field('dailyAiCap', DEFAULT_CHATBOT_CONFIG.dailyAiCap),
  };
}

/** Stored answers, one at a time: a bad one is dropped, never the list. */
function readItems(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) return [];
  const out: FaqItem[] = [];
  for (const entry of raw) {
    const item = FAQ_ITEM.safeParse(entry);
    if (item.success) out.push(item.data);
    if (out.length >= FAQ_LIMITS.items) break;
  }
  return out;
}

/**
 * Whether visitors may add guests, and how many: the booking link's own
 * settings (`allowGuests`, `maxGuests`), read from the stored document so the
 * assistant works whichever version saved it. Allowed, five, by default.
 */
export function readGuestRules(rawSettings: unknown): { allowed: boolean; max: number } {
  const settings =
    rawSettings && typeof rawSettings === 'object' ? (rawSettings as Record<string, unknown>) : {};
  const allowed = typeof settings.allowGuests === 'boolean' ? settings.allowGuests : true;
  const max =
    typeof settings.maxGuests === 'number' &&
    Number.isInteger(settings.maxGuests) &&
    settings.maxGuests >= 0 &&
    settings.maxGuests <= 10
      ? settings.maxGuests
      : 5;
  return { allowed: allowed && max > 0, max: allowed ? max : 0 };
}
