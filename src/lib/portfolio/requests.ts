import { PORTFOLIO_REQUEST_LABELS, type PortfolioUpdate } from '@/lib/types/domain';

/**
 * How portfolio requests read on a page, wherever they are shown (Portfolio >
 * Requests, Today's brief). Pure and client-safe; the asks themselves are read
 * by `lib/services/portfolio-asks.ts`.
 */

/** Marks a request read from an update by these rules (bump if the rules change what an ask is). */
export const AUTO_ASK_VERSION = 'auto-asks/1';

/** Whether a request was read from an update's asks rather than classified by a person. */
export function isAutoAsk(update: Pick<PortfolioUpdate, 'prompt_version'>): boolean {
  return update.prompt_version?.startsWith('auto-asks/') ?? false;
}

/** The badge for a request: "Ask" for an ask read from an update that names no kind of help. */
export function requestLabel(
  update: Pick<PortfolioUpdate, 'request_type' | 'prompt_version'>,
): string | null {
  if (!update.request_type) return null;
  if (update.request_type === 'general_update' && isAutoAsk(update)) return 'Ask';
  return PORTFOLIO_REQUEST_LABELS[update.request_type];
}

/** The requests that came from one email: its asks read automatically and any classification of it. */
export interface RequestGroup {
  key: string;
  portfolioCompanyId: string;
  /** Newest first, as the requests came; the asks keep their order in the email. */
  updates: PortfolioUpdate[];
}

/** The email a request came from, so the asks of one update share a card. */
function sourceKey(update: PortfolioUpdate): string {
  if (update.email_message_id) return `message:${update.email_message_id}`;
  if (isAutoAsk(update)) {
    const cited = update.citations[0]?.id;
    if (cited) return `cited:${update.portfolio_company_id}:${cited}`;
  }
  return `update:${update.id}`;
}

/**
 * One group per email, in the order the requests come (newest first): a
 * four-ask update is one card with four asks, not four cards, and a person's
 * classification of the same email joins it.
 */
export function groupRequests(updates: readonly PortfolioUpdate[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const update of updates) {
    const key = sourceKey(update);
    const group = groups.get(key);
    if (group) group.updates.push(update);
    else
      groups.set(key, { key, portfolioCompanyId: update.portfolio_company_id, updates: [update] });
  }
  for (const group of groups.values()) {
    // A person's classification leads; the asks follow in the order they were
    // written (each ask's created_at is a millisecond after the one above it).
    group.updates.sort(
      (a, b) =>
        Number(isAutoAsk(a)) - Number(isAutoAsk(b)) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  }
  return [...groups.values()];
}
