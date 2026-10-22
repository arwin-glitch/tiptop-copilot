/**
 * The public chatbot's settings (Booking tab > Chatbot, D-078), as data.
 *
 * PLACEHOLDER for the shared contract between the booking-v2 builders: the
 * chatbot builder owns this module and its version replaces this one when
 * the branches meet (same names, same shape). It is here so the Booking tab
 * can carry `chatbot: ChatbotConfig` in BookingConfig before then.
 *
 * Pure and client-safe; it never imports from ./config (config imports it).
 */

export interface ChatbotFaqItem {
  q: string;
  a: string;
}

export interface ChatbotConfig {
  enabled: boolean;
  /** The only facts about the firm the chatbot may give. Public: nothing private here. */
  faqItems: ChatbotFaqItem[];
  /** Free-text answers. Off by default: the chatbot never pays for a model (D-078). */
  aiAnswers: boolean;
  /** Free-text answers a day, at most, while `aiAnswers` is on. */
  dailyAiCap: number;
}

const MAX_ITEMS = 30;

function clean(text: unknown, max: number): string {
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

/**
 * The chatbot's settings from a stored booking settings document: its
 * `chatbot` field when there is one, else the older `chatbotEnabled` and
 * `faq` (free text, kept as one answer). Never throws; anything unreadable
 * takes its default.
 */
export function readChatbotConfig(rawSettings: unknown): ChatbotConfig {
  const source =
    rawSettings && typeof rawSettings === 'object' ? (rawSettings as Record<string, unknown>) : {};
  const own =
    source.chatbot && typeof source.chatbot === 'object'
      ? (source.chatbot as Record<string, unknown>)
      : null;
  const legacyFaq = clean(source.faq, 4000);
  const items = Array.isArray(own?.faqItems)
    ? own.faqItems
        .flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const q = clean((item as Record<string, unknown>).q, 200);
          const a = clean((item as Record<string, unknown>).a, 1000);
          return a ? [{ q, a }] : [];
        })
        .slice(0, MAX_ITEMS)
    : legacyFaq
      ? [{ q: 'About the firm', a: legacyFaq }]
      : [];
  const cap = Number(own?.dailyAiCap);
  return {
    enabled:
      typeof own?.enabled === 'boolean'
        ? own.enabled
        : typeof source.chatbotEnabled === 'boolean'
          ? source.chatbotEnabled
          : true,
    faqItems: items,
    aiAnswers: own?.aiAnswers === true,
    dailyAiCap: Number.isInteger(cap) && cap >= 0 && cap <= 500 ? cap : 20,
  };
}
