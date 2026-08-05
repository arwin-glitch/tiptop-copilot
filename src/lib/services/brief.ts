import 'server-only';
import { CitationRegistry } from '@/lib/ai/citations';
import { PROMPTS } from '@/lib/ai/prompts';
import { dailyOutlookSchema } from '@/lib/ai/schemas';
import type { AuthContext } from '@/lib/auth/session';
import { getAI, getCalendarProvider, getResearchProvider, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import type {
  BriefItem,
  CalendarEvent,
  Citation,
  DailyBrief,
  Deal,
  DealAnalysis,
  EmailMessage,
  PortfolioCompany,
  PortfolioUpdate,
  Task,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { relativeTime, todayWindow } from '@/lib/util/time';
import { truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import { dueAndOverdue } from './tasks';
import { getActiveThesis } from './thesis';

/**
 * Daily outlook.
 *
 * The candidate set is assembled deterministically from real records — meetings,
 * unread email, new deals, overdue follow-ups, portfolio requests — and the
 * model's job is narrowing and phrasing, not discovery. That is why the outlook
 * cannot contain an item that does not exist, and why every item carries a
 * citation back to the record it came from.
 */

export interface MeetingPrep {
  event: CalendarEvent;
  relatedDeal: Deal | null;
  relatedPortfolio: PortfolioCompany | null;
  lastInteraction: EmailMessage | null;
  openQuestions: string[];
  suggestedPrep: string;
}

export interface TodayData {
  dateKey: string;
  timezone: string;
  meetings: CalendarEvent[];
  meetingPrep: MeetingPrep[];
  importantEmails: EmailMessage[];
  newDeals: Deal[];
  awaitingDecision: { deal: Deal; analysis: DealAnalysis | null }[];
  overdueTasks: Task[];
  dueTodayTasks: Task[];
  portfolioRequests: { update: PortfolioUpdate; company: PortfolioCompany | null }[];
  lpItems: EmailMessage[];
  researchAvailable: boolean;
  researchUnavailableReason: string | null;
}

export async function gatherTodayData(
  auth: AuthContext,
  now: Date = new Date(),
): Promise<TodayData> {
  const store = getStore();
  const timezone = auth.profile.timezone;
  const window = todayWindow(timezone, now);
  const research = getResearchProvider();

  // Calendar: refresh from the provider when one is connected, then read back
  // from storage so the page renders the same rows the rest of the app sees.
  const integration = await getPrimaryIntegration(store, auth.organizationId);
  const calendar = getCalendarProvider(integration);
  if (calendar) {
    const fetched = await calendar.listEvents({
      timeMin: window.start.toISOString(),
      timeMax: window.end.toISOString(),
      maxResults: 40,
      cursor: integration?.sync_cursor ?? null,
    });
    if (fetched.ok) {
      for (const event of fetched.value.events) {
        await store.upsert(
          'calendar_events',
          {
            id: newId(),
            organization_id: auth.organizationId,
            user_id: auth.userId,
            provider: 'google',
            provider_event_id: event.providerEventId,
            title: event.title,
            description: event.description,
            location: event.location,
            starts_at: event.startsAt,
            ends_at: event.endsAt,
            all_day: event.allDay,
            attendees: event.attendees,
            organizer_email: event.organizerEmail,
            is_private: event.isPrivate,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          ['organization_id', 'provider', 'provider_event_id'],
        );
      }
    }
  }

  const [meetings, deals, tasksSplit, portfolioUpdates, portfolioCompanies] = await Promise.all([
    store.list(
      'calendar_events',
      auth.organizationId,
      {
        gte: { starts_at: window.start.toISOString() },
        lt: { starts_at: window.end.toISOString() },
      },
      { orderBy: [{ field: 'starts_at', direction: 'asc' }] },
    ) as Promise<CalendarEvent[]>,
    store.list(
      'deals',
      auth.organizationId,
      { eq: { is_archived: false } },
      {
        orderBy: [{ field: 'received_at', direction: 'desc' }],
      },
    ) as Promise<Deal[]>,
    dueAndOverdue(auth.organizationId, now),
    store.list(
      'portfolio_updates',
      auth.organizationId,
      { eq: { status: 'open' }, notNull: ['request_type'] },
      { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 10 },
    ) as Promise<PortfolioUpdate[]>,
    store.list('portfolio_companies', auth.organizationId, {
      eq: { is_archived: false },
    }) as Promise<PortfolioCompany[]>,
  ]);

  const recentSince = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const recentEmails = (await store.list(
    'email_messages',
    auth.organizationId,
    { gte: { sent_at: recentSince }, eq: { is_ignored: false } },
    { orderBy: [{ field: 'sent_at', direction: 'desc' }], limit: 60 },
  )) as EmailMessage[];

  const importantEmails = recentEmails
    .filter((m) => (m.importance ?? 0) >= 60 || m.is_unread)
    .filter((m) => m.category !== 'newsletter_or_market' && m.category !== 'personal_or_unrelated')
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .slice(0, 8);

  const lpItems = recentEmails.filter(
    (m) => m.category === 'lp_or_advisor' || m.category === 'co_investor',
  );

  const newDeals = deals.filter(
    (d) => Date.parse(d.received_at) >= now.getTime() - 3 * 86_400_000 && d.stage === 'new',
  );

  const awaitingStages = new Set([
    'new',
    'reviewing',
    'waiting_for_info',
    'diligence',
    'ic_review',
  ]);
  const awaitingDecision: { deal: Deal; analysis: DealAnalysis | null }[] = [];
  for (const deal of deals.filter((d) => awaitingStages.has(d.stage)).slice(0, 10)) {
    const rows = (await store.list(
      'deal_analyses',
      auth.organizationId,
      { eq: { deal_id: deal.id } },
      { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
    )) as DealAnalysis[];
    awaitingDecision.push({ deal, analysis: rows[0] ?? null });
  }

  const meetingPrep = await Promise.all(
    meetings.map((event) => buildMeetingPrep(auth, event, deals, portfolioCompanies, recentEmails)),
  );

  return {
    dateKey: window.dateKey,
    timezone,
    meetings,
    meetingPrep,
    importantEmails,
    newDeals,
    awaitingDecision,
    overdueTasks: tasksSplit.overdue,
    dueTodayTasks: tasksSplit.dueToday,
    portfolioRequests: portfolioUpdates.map((update) => ({
      update,
      company: portfolioCompanies.find((c) => c.id === update.portfolio_company_id) ?? null,
    })),
    lpItems,
    researchAvailable: research.available(),
    researchUnavailableReason: research.unavailableReason(),
  };
}

/**
 * Meeting preparation.
 *
 * Attendee matching is by email domain, and only against companies already in
 * the pipeline or portfolio. A private calendar entry with no business match
 * contributes its time slot and nothing else — unrelated personal detail is
 * never pulled into a deal or portfolio context.
 */
async function buildMeetingPrep(
  auth: AuthContext,
  event: CalendarEvent,
  deals: Deal[],
  portfolio: PortfolioCompany[],
  recentEmails: EmailMessage[],
): Promise<MeetingPrep> {
  const externalDomains = event.attendees
    .map((a) => a.email.split('@')[1]?.toLowerCase())
    .filter(
      (d): d is string => Boolean(d) && d !== auth.profile.email.split('@')[1]?.toLowerCase(),
    );

  const relatedDeal = deals.find((d) => d.domain && externalDomains.includes(d.domain)) ?? null;
  const relatedPortfolio =
    portfolio.find((p) => p.domain && externalDomains.includes(p.domain)) ?? null;

  const attendeeAddresses = new Set(event.attendees.map((a) => a.email.toLowerCase()));
  const lastInteraction =
    recentEmails.find((m) => attendeeAddresses.has(m.from_address.toLowerCase())) ?? null;

  const openQuestions = relatedDeal?.open_questions.slice(0, 3) ?? [];

  let suggestedPrep: string;
  if (relatedDeal) {
    suggestedPrep = openQuestions.length
      ? `Bring the open questions on ${relatedDeal.company_name}; they are what the decision turns on.`
      : `Review the ${relatedDeal.company_name} record before this.`;
  } else if (relatedPortfolio) {
    suggestedPrep = relatedPortfolio.current_priorities
      ? `Their stated priority is: ${truncate(relatedPortfolio.current_priorities, 120)}`
      : `Check what ${relatedPortfolio.name} last asked for.`;
  } else if (event.is_private || externalDomains.length === 0) {
    suggestedPrep = 'No linked company record. Nothing to prepare from TipTop data.';
  } else {
    suggestedPrep = 'No company in the pipeline or portfolio matches these attendees.';
  }

  return { event, relatedDeal, relatedPortfolio, lastInteraction, openQuestions, suggestedPrep };
}

/* --------------------------------------------------------------- generate */

export async function generateDailyBrief(
  auth: AuthContext,
  options: { force?: boolean; now?: Date } = {},
): Promise<Result<DailyBrief>> {
  const store = getStore();
  const now = options.now ?? new Date();
  const data = await gatherTodayData(auth, now);

  if (!options.force) {
    const existing = (await store.findOne('daily_briefs', auth.organizationId, {
      eq: { user_id: auth.userId, date_key: data.dateKey },
    })) as DailyBrief | null;
    if (existing) return ok(existing);
  }

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const registry = new CitationRegistry();
  const items: {
    kind: string;
    title: string;
    detail: string;
    source_id: string | null;
    href: string | null;
    occurred_at: string | null;
  }[] = [];

  for (const prep of data.meetingPrep) {
    const id = `event:${prep.event.id}`;
    registry.add({
      id,
      kind: 'calendar_event',
      ref_id: prep.event.id,
      label: prep.event.title,
      page: null,
      section: null,
      url: null,
      occurred_at: prep.event.starts_at,
      retrieved_at: null,
      publisher: null,
      excerpt: null,
    });
    items.push({
      kind: 'meeting',
      title: prep.event.title,
      detail: [
        `${prep.event.attendees.length} attendee${prep.event.attendees.length === 1 ? '' : 's'}`,
        prep.relatedDeal ? `Deal: ${prep.relatedDeal.company_name}` : null,
        prep.relatedPortfolio ? `Portfolio: ${prep.relatedPortfolio.name}` : null,
        prep.suggestedPrep,
      ]
        .filter(Boolean)
        .join('. '),
      source_id: id,
      href: prep.relatedDeal ? `/deals/${prep.relatedDeal.id}` : '/today',
      occurred_at: prep.event.starts_at,
    });
  }

  for (const email of data.importantEmails) {
    const id = `email:${email.id}`;
    registry.add({
      id,
      kind: 'email',
      ref_id: email.id,
      label: email.subject ?? '(no subject)',
      page: null,
      section: null,
      url: null,
      occurred_at: email.sent_at,
      retrieved_at: null,
      publisher: email.from_address,
      excerpt: truncate(email.snippet, 200),
    });
    items.push({
      kind:
        email.category === 'lp_or_advisor' || email.category === 'co_investor'
          ? 'lp_item'
          : 'email',
      title: `${email.from_name ?? email.from_address}: ${email.subject ?? '(no subject)'}`,
      detail: truncate(email.snippet, 280),
      source_id: id,
      href: `/inbox?message=${email.id}`,
      occurred_at: email.sent_at,
    });
  }

  for (const deal of data.newDeals) {
    const id = `deal:${deal.id}`;
    registry.add({
      id,
      kind: 'deal',
      ref_id: deal.id,
      label: deal.company_name,
      page: null,
      section: null,
      url: null,
      occurred_at: deal.received_at,
      retrieved_at: null,
      publisher: null,
      excerpt: deal.product_summary,
    });
    items.push({
      kind: 'new_deal',
      title: deal.company_name,
      detail: truncate(deal.product_summary ?? 'No product summary extracted yet.', 260),
      source_id: id,
      href: `/deals/${deal.id}`,
      occurred_at: deal.received_at,
    });
  }

  for (const { deal, analysis } of data.awaitingDecision) {
    const id = `deal:${deal.id}`;
    if (!registry.has(id)) {
      registry.add({
        id,
        kind: 'deal',
        ref_id: deal.id,
        label: deal.company_name,
        page: null,
        section: null,
        url: null,
        occurred_at: deal.received_at,
        retrieved_at: null,
        publisher: null,
        excerpt: deal.product_summary,
      });
    }
    items.push({
      kind: 'awaiting_decision',
      title: deal.company_name,
      detail: analysis
        ? `${analysis.recommendation.replace(/_/g, ' ')} at ${analysis.confidence}% confidence. ${truncate(analysis.recommended_next_step, 160)}`
        : 'No analysis has been run yet.',
      source_id: id,
      href: `/deals/${deal.id}`,
      occurred_at: deal.received_at,
    });
  }

  for (const task of [...data.overdueTasks, ...data.dueTodayTasks]) {
    const overdue = task.due_at ? Date.parse(task.due_at) < now.getTime() : false;
    items.push({
      kind: 'follow_up',
      title: task.title,
      detail: overdue
        ? `Overdue — was due ${relativeTime(task.due_at ?? '', now)}. ${task.detail ?? ''}`.trim()
        : `Due today. ${task.detail ?? ''}`.trim(),
      source_id: null,
      href: task.deal_id ? `/deals/${task.deal_id}` : '/tasks',
      occurred_at: task.due_at,
    });
  }

  for (const { update, company } of data.portfolioRequests) {
    const id = `portfolio_update:${update.id}`;
    registry.add({
      id,
      kind: 'portfolio_update',
      ref_id: update.id,
      label: `${company?.name ?? 'Portfolio'} — ${update.request_type ?? 'update'}`,
      page: null,
      section: null,
      url: null,
      occurred_at: update.occurred_at,
      retrieved_at: null,
      publisher: null,
      excerpt: truncate(update.summary, 200),
    });
    items.push({
      kind: 'portfolio_request',
      title: `${company?.name ?? 'Portfolio company'}: ${(update.request_type ?? 'update').replace(/_/g, ' ')}`,
      detail: truncate(update.request_detail ?? update.summary, 280),
      source_id: id,
      href: `/portfolio/${update.portfolio_company_id}`,
      occurred_at: update.occurred_at,
    });
  }

  const thesis = await getActiveThesis(store, auth.organizationId, auth.userId);

  const context = {
    date: data.dateKey,
    timezone: data.timezone,
    user_first_name: auth.profile.full_name?.split(' ')[0] ?? 'Nick',
    research_available: data.researchAvailable,
    research_unavailable_reason: data.researchUnavailableReason,
    thesis_summary: truncate(thesis.thesis_notes, 600),
    items,
    available_source_ids: registry.ids(),
  };

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'deep',
    operation: 'brief.outlook',
    promptVersion: PROMPTS.dailyOutlook.version,
    system: PROMPTS.dailyOutlook.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>

Write today's outlook from the items above. Every item you include must cite one of available_source_ids, unless you explicitly mark it as a suggestion.${
          data.researchAvailable
            ? ''
            : ' Web research is unavailable, so return an empty market_signals array rather than writing market commentary from memory.'
        }`,
      },
    ],
    schema: dailyOutlookSchema,
    maxTokens: 12_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'brief.outlook',
    promptVersion: PROMPTS.dailyOutlook.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const output = response.value.value;

  const toBriefItems = (
    raw: typeof output.priorities,
    fallbackKind: BriefItem['kind'],
  ): BriefItem[] =>
    raw.map((item, index) => {
      const { citations } = registry.resolve(item.citations);
      const href =
        items.find((i) => i.source_id && citations.some((c) => c.id === i.source_id))?.href ?? null;
      return {
        id: `${fallbackKind}-${index}`,
        kind: (item.kind as BriefItem['kind']) ?? fallbackKind,
        title: item.title,
        detail: item.detail,
        citation_ids: citations.map((c) => c.id),
        href,
        is_suggestion: item.is_suggestion || citations.length === 0,
        occurred_at:
          items.find((i) => i.source_id && citations.some((c) => c.id === i.source_id))
            ?.occurred_at ?? null,
      };
    });

  const usedCitations: Citation[] = registry.all();

  const brief: DailyBrief = {
    id: newId(),
    organization_id: auth.organizationId,
    user_id: auth.userId,
    date_key: data.dateKey,
    timezone: data.timezone,
    outlook: output.outlook,
    priorities: toBriefItems(output.priorities, 'priority'),
    sections: {
      meetings: toBriefItems(output.meetings, 'meeting'),
      emails: toBriefItems(output.emails, 'email'),
      new_deals: toBriefItems(output.new_deals, 'new_deal'),
      awaiting_decision: toBriefItems(output.awaiting_decision, 'awaiting_decision'),
      follow_ups: toBriefItems(output.follow_ups, 'follow_up'),
      portfolio_requests: toBriefItems(output.portfolio_requests, 'portfolio_request'),
      lp_items: toBriefItems(output.lp_items, 'lp_item'),
      market_signals: data.researchAvailable
        ? toBriefItems(output.market_signals, 'market_signal')
        : [],
    },
    recommended_actions: output.recommended_actions,
    citations: usedCitations,
    model: response.value.usage.model,
    prompt_version: PROMPTS.dailyOutlook.version,
    generated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  // One brief per user per day; regenerating replaces it.
  await store.removeWhere('daily_briefs', auth.organizationId, {
    eq: { user_id: auth.userId, date_key: data.dateKey },
  });
  await store.insert('daily_briefs', brief);

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'brief.generated',
    entityType: 'daily_brief',
    entityId: brief.id,
    metadata: { date_key: brief.date_key, items: items.length, model: brief.model },
  });

  return ok(brief);
}

export async function getTodaysBrief(
  auth: AuthContext,
  now: Date = new Date(),
): Promise<DailyBrief | null> {
  const store = getStore();
  const window = todayWindow(auth.profile.timezone, now);
  return (await store.findOne('daily_briefs', auth.organizationId, {
    eq: { user_id: auth.userId, date_key: window.dateKey },
  })) as DailyBrief | null;
}

/** Cheap check used by the Today page to decide between data and an empty state. */
export function hasAnythingToday(data: TodayData): boolean {
  return (
    data.meetings.length > 0 ||
    data.importantEmails.length > 0 ||
    data.newDeals.length > 0 ||
    data.overdueTasks.length > 0 ||
    data.dueTodayTasks.length > 0 ||
    data.portfolioRequests.length > 0
  );
}

export function briefUnavailable(reason: string): Result<never> {
  return err('provider_unavailable', reason);
}
