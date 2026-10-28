import { z } from 'zod';
import { FAQ_ITEM, FAQ_ITEMS, FAQ_LIMITS, type FaqItem } from '@/lib/booking/chatbot-config';

/**
 * The public job board assistant's settings ("Ask Arwin" on the board,
 * Portfolio > Jobs > Ask Arwin): whether it shows, the written answers it
 * may give, and whether a question nothing else answers may go to the jobs
 * assistant routine (Arwin's own Claude plan, no API key, no spend).
 *
 * Stored as `job_board_settings.assistant` (jsonb, added by
 * 20261028110000_jobs_chat.sql) and read leniently, field by field, like the
 * booking assistant's settings (lib/booking/chatbot-config.ts, whose answer
 * rules this reuses): a missing or bad field takes its default and never
 * hides the others. Before the column exists, or before anyone saves, the
 * default answers below are used.
 *
 * Pure and client-safe: the settings panel, the public widget and the server
 * read the same shape.
 */

export const JOBS_DAILY_AI_CAP_DEFAULT = 15;
export const JOBS_DAILY_AI_CAP_MAX = 30;

export interface JobsAssistantConfig {
  /** The assistant shows on the public board. */
  enabled: boolean;
  /** What it may answer word for word, after what the board's own data answers. */
  faqItems: FaqItem[];
  /**
   * A question nothing else answers may go to the jobs assistant routine (it
   * needs JOBS_CHAT_FIRE_URL and JOBS_CHAT_TOKEN as well).
   */
  aiAnswers: boolean;
  /** Questions the routine may take a day, for the whole board. */
  dailyAiCap: number;
}

/**
 * The answers it starts with: only what the code itself makes true. Every
 * Apply button links to the company's own page (lib/jobs-board/public.ts
 * applyLinkFor); the board lists only roles at portfolio companies; roles
 * come from the companies' own job boards (synced every day by the daily
 * job, which closes a role its board drops) or from the companies
 * themselves, approved by a person before they show.
 */
export const DEFAULT_JOBS_FAQ: readonly FaqItem[] = [
  {
    q: 'How do I apply?',
    a: "Each role's Apply button opens the company's own application page. Your application goes straight to the company.",
  },
  {
    q: 'What is this job board?',
    a: 'It lists open roles at companies TipTop VC has invested in.',
  },
  {
    q: 'Where do the roles come from?',
    a: "Roles are read from each company's own careers page or job board, or come from the companies directly; a person at TipTop approves those before they show here.",
  },
  {
    q: 'How often is the board updated?',
    a: "Roles from a company's own job board are checked every day. When the company takes a role down, it leaves this board too.",
  },
];

export const DEFAULT_JOBS_ASSISTANT: JobsAssistantConfig = {
  enabled: true,
  faqItems: [...DEFAULT_JOBS_FAQ],
  aiAnswers: false,
  dailyAiCap: JOBS_DAILY_AI_CAP_DEFAULT,
};

/** The shape the panel saves: strict, every value bounded. */
export const JOBS_ASSISTANT_SCHEMA = z
  .object({
    enabled: z.boolean(),
    faqItems: FAQ_ITEMS,
    aiAnswers: z.boolean(),
    dailyAiCap: z.number().int().min(0).max(JOBS_DAILY_AI_CAP_MAX),
  })
  .strict();

/** A save from the panel: any of the fields, merged onto what is stored. */
export const JOBS_ASSISTANT_PATCH = JOBS_ASSISTANT_SCHEMA.partial().strict();
export type JobsAssistantPatch = z.infer<typeof JOBS_ASSISTANT_PATCH>;

/**
 * The settings from the stored jsonb (or anything else). A stored
 * `faqItems` list is used as saved, even empty (the team cleared it);
 * with none saved, the defaults stand in.
 */
export function readJobsAssistantConfig(raw: unknown): JobsAssistantConfig {
  const stored =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const shape = JOBS_ASSISTANT_SCHEMA.shape;
  const field = <K extends keyof JobsAssistantConfig>(key: K, fallback: JobsAssistantConfig[K]) => {
    const parsed = (shape[key] as z.ZodType).safeParse(stored[key]);
    return parsed.success ? (parsed.data as JobsAssistantConfig[K]) : fallback;
  };
  return {
    enabled: field('enabled', DEFAULT_JOBS_ASSISTANT.enabled),
    faqItems: Array.isArray(stored.faqItems)
      ? readItems(stored.faqItems)
      : [...DEFAULT_JOBS_ASSISTANT.faqItems],
    aiAnswers: field('aiAnswers', DEFAULT_JOBS_ASSISTANT.aiAnswers),
    dailyAiCap: field('dailyAiCap', DEFAULT_JOBS_ASSISTANT.dailyAiCap),
  };
}

/** Stored answers, one at a time: a bad one is dropped, never the list. */
function readItems(raw: readonly unknown[]): FaqItem[] {
  const out: FaqItem[] = [];
  for (const entry of raw) {
    const item = FAQ_ITEM.safeParse(entry);
    if (item.success) out.push(item.data);
    if (out.length >= FAQ_LIMITS.items) break;
  }
  return out;
}
