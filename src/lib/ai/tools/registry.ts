import 'server-only';
import { z } from 'zod';
import type { AuthContext } from '@/lib/auth/session';
import { CitationRegistry } from '@/lib/ai/citations';
import type { ToolDefinition, ToolInvocation, ToolOutcome } from '@/lib/ai/provider';
import { toModelJsonSchema } from '@/lib/ai/schemas';
import { getResearchProvider, getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { truncate } from '@/lib/util/text';
import type {
  CalendarEvent,
  Citation,
  Deal,
  DealAnalysis,
  DealDecision,
  DealSource,
  EmailAttachment,
  EmailMessage,
  PortfolioCompany,
  PortfolioUpdate,
  Task,
} from '@/lib/types/domain';
import { todayWindow } from '@/lib/util/time';
import { gatherTodayData } from '@/lib/services/brief';
import { searchKnowledge } from '@/lib/services/knowledge';
import { createTask } from '@/lib/services/tasks';
import { addNote, compareDeals } from '@/lib/services/deals';
import { analyzeDeal } from '@/lib/services/deal-analysis';
import { createDraft } from '@/lib/services/drafts';

/**
 * The allowlisted server-side tool layer.
 *
 * The model never receives database access, shell access, or a URL it did not
 * obtain from a tool. Every tool:
 *   - declares a Zod input schema and is refused if the input does not validate
 *   - receives the AuthContext and re-derives organization scope itself
 *   - returns JSON that includes the citations for anything it surfaced
 *
 * Write tools are a deliberately short list (create_task, save_note,
 * create_draft_reply, generate_deal_analysis) and none of them can record a
 * decision, mark a deal invested, or send anything.
 */

export interface ToolContext {
  auth: AuthContext;
  registry: CitationRegistry;
  /** Restricts every read to one deal when the chat is scoped to a deal. */
  scopeDealId: string | null;
}

interface ToolSpec<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  /** Write tools are gated separately and audited. */
  mutates: boolean;
  run: (input: z.infer<T>, ctx: ToolContext) => Promise<{ result: unknown; summary: string }>;
}

/* --------------------------------------------------------------- helpers */

function addCitation(ctx: ToolContext, citation: Citation): string {
  ctx.registry.add(citation);
  return citation.id;
}

function emailCitation(ctx: ToolContext, m: EmailMessage): string {
  return addCitation(ctx, {
    id: `email:${m.id}`,
    kind: 'email',
    ref_id: m.id,
    label: m.subject ?? '(no subject)',
    page: null,
    section: null,
    url: null,
    occurred_at: m.sent_at,
    retrieved_at: m.body_fetched_at,
    publisher: m.from_address,
    excerpt: truncate(m.body_text ?? m.snippet, 240),
  });
}

function dealCitation(ctx: ToolContext, d: Deal): string {
  return addCitation(ctx, {
    id: `deal:${d.id}`,
    kind: 'deal',
    ref_id: d.id,
    label: d.company_name,
    page: null,
    section: null,
    url: null,
    occurred_at: d.received_at,
    retrieved_at: null,
    publisher: null,
    excerpt: d.product_summary,
  });
}

/** Enforced on every deal-scoped read when the chat is pinned to one deal. */
function inScope(ctx: ToolContext, dealId: string): boolean {
  return ctx.scopeDealId === null || ctx.scopeDealId === dealId;
}

/* ----------------------------------------------------------------- tools */

const getDailyOutlook: ToolSpec<z.ZodObject<Record<string, never>>> = {
  name: 'get_daily_outlook',
  description:
    "Today's meetings, important emails, new deals, overdue follow-ups and open portfolio requests, assembled from stored records.",
  schema: z.object({}),
  mutates: false,
  async run(_input, ctx) {
    const data = await gatherTodayData(ctx.auth);
    const citations: { id: string; label: string }[] = [];
    for (const m of data.importantEmails)
      citations.push({ id: emailCitation(ctx, m), label: m.subject ?? '' });
    for (const d of data.newDeals)
      citations.push({ id: dealCitation(ctx, d), label: d.company_name });

    return {
      result: {
        date: data.dateKey,
        timezone: data.timezone,
        meetings: data.meetingPrep.map((p) => ({
          title: p.event.title,
          starts_at: p.event.starts_at,
          attendees: p.event.attendees.map((a) => a.email),
          related_deal: p.relatedDeal?.company_name ?? null,
          related_portfolio: p.relatedPortfolio?.name ?? null,
          suggested_prep: p.suggestedPrep,
        })),
        important_emails: data.importantEmails.map((m) => ({
          from: m.from_address,
          subject: m.subject,
          importance: m.importance,
          category: m.category,
          source_id: `email:${m.id}`,
        })),
        new_deals: data.newDeals.map((d) => ({
          company: d.company_name,
          summary: d.product_summary,
          source_id: `deal:${d.id}`,
        })),
        overdue_follow_ups: data.overdueTasks.map((t) => ({ title: t.title, due_at: t.due_at })),
        open_portfolio_requests: data.portfolioRequests.map((r) => ({
          company: r.company?.name ?? null,
          request_type: r.update.request_type,
          detail: r.update.request_detail,
        })),
        research_available: data.researchAvailable,
        citations,
      },
      summary: `${data.meetings.length} meeting(s), ${data.importantEmails.length} important email(s), ${data.newDeals.length} new deal(s), ${data.overdueTasks.length} overdue follow-up(s).`,
    };
  },
};

const searchRecentEmail: ToolSpec<
  z.ZodObject<{
    query: z.ZodString;
    days: z.ZodOptional<z.ZodNumber>;
    category: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: 'search_recent_email',
  description:
    'Search synchronised email by keyword. Optionally restrict to the last N days or to a category.',
  schema: z.object({
    query: z.string().max(200),
    days: z.number().int().min(1).max(365).optional(),
    category: z.string().max(50).optional(),
  }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const filter: Record<string, unknown> = { eq: { is_ignored: false } };
    if (input.category) {
      (filter.eq as Record<string, unknown>).category = input.category;
    }
    if (input.days) {
      filter.gte = { sent_at: new Date(Date.now() - input.days * 86_400_000).toISOString() };
    }
    const hits = input.query.trim()
      ? await store.search(
          'email_messages',
          ctx.auth.organizationId,
          input.query,
          ['subject', 'snippet', 'body_text', 'from_address', 'from_name'],
          filter,
          12,
        )
      : (
          await store.list('email_messages', ctx.auth.organizationId, filter, {
            orderBy: [{ field: 'sent_at', direction: 'desc' }],
            limit: 12,
          })
        ).map((row, i) => ({ row: row as EmailMessage, rank: 1 - i / 12 }));

    const messages = hits.map((h) => h.row as EmailMessage);
    const citations = messages.map((m) => ({ id: emailCitation(ctx, m), label: m.subject ?? '' }));

    return {
      result: {
        count: messages.length,
        messages: messages.map((m) => ({
          source_id: `email:${m.id}`,
          from: `${m.from_name ?? ''} <${m.from_address}>`.trim(),
          subject: m.subject,
          sent_at: m.sent_at,
          category: m.category,
          importance: m.importance,
          unread: m.is_unread,
          snippet: truncate(m.body_text ?? m.snippet, 600),
          injection_flagged: m.injection_flagged,
        })),
        citations,
      },
      summary:
        messages.length === 0
          ? `No email matched "${input.query}".`
          : `${messages.length} email(s) matched "${input.query}". Most recent: ${messages[0]?.subject ?? ''}.`,
    };
  },
};

const getEmailThread: ToolSpec<z.ZodObject<{ message_id: z.ZodString }>> = {
  name: 'get_email_thread',
  description: 'Fetch the full thread containing a message, in chronological order.',
  schema: z.object({ message_id: z.string().max(120) }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const id = input.message_id.replace(/^email:/, '');
    const message = (await store.get(
      'email_messages',
      ctx.auth.organizationId,
      id,
    )) as EmailMessage | null;
    if (!message)
      return {
        result: { error: 'No such message in this organization.' },
        summary: 'Message not found.',
      };

    const thread = (await store.list(
      'email_messages',
      ctx.auth.organizationId,
      { eq: { thread_id: message.thread_id } },
      { orderBy: [{ field: 'sent_at', direction: 'asc' }] },
    )) as EmailMessage[];

    const citations = thread.map((m) => ({ id: emailCitation(ctx, m), label: m.subject ?? '' }));
    return {
      result: {
        subject: message.subject,
        messages: thread.map((m) => ({
          source_id: `email:${m.id}`,
          from: m.from_address,
          sent_at: m.sent_at,
          body: truncate(m.body_text ?? m.snippet, 4_000),
        })),
        citations,
      },
      summary: `Thread "${message.subject ?? '(no subject)'}" has ${thread.length} message(s).`,
    };
  },
};

const searchDeals: ToolSpec<
  z.ZodObject<{ query: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>
> = {
  name: 'search_deals',
  description: 'Search the deal pipeline by company name, product, industry or team.',
  schema: z.object({
    query: z.string().max(200),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const hits = input.query.trim()
      ? await store.search(
          'deals',
          ctx.auth.organizationId,
          input.query,
          ['company_name', 'product_summary', 'industry', 'vertical', 'team', 'competition'],
          { eq: { is_archived: false } },
          input.limit ?? 8,
        )
      : (
          await store.list(
            'deals',
            ctx.auth.organizationId,
            { eq: { is_archived: false } },
            {
              orderBy: [{ field: 'received_at', direction: 'desc' }],
              limit: input.limit ?? 8,
            },
          )
        ).map((row, i) => ({ row: row as Deal, rank: 1 - i / 8 }));

    const deals = (hits.map((h) => h.row) as Deal[]).filter((d) => inScope(ctx, d.id));
    const citations = deals.map((d) => ({ id: dealCitation(ctx, d), label: d.company_name }));

    return {
      result: {
        count: deals.length,
        deals: deals.map((d) => ({
          deal_id: d.id,
          source_id: `deal:${d.id}`,
          company: d.company_name,
          stage: d.stage,
          industry: d.industry,
          vertical: d.vertical,
          revenue: d.revenue,
          traction: d.traction,
          summary: d.product_summary,
          received_at: d.received_at,
        })),
        citations,
      },
      summary:
        deals.length === 0
          ? `No deals matched "${input.query}".`
          : `${deals.length} deal(s) matched: ${deals.map((d) => d.company_name).join(', ')}.`,
    };
  },
};

const getDeal: ToolSpec<z.ZodObject<{ deal_id: z.ZodString }>> = {
  name: 'get_deal',
  description:
    'Full record for one deal: extracted fields, people, latest analysis, decisions and open questions.',
  schema: z.object({ deal_id: z.string().max(120) }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const id = input.deal_id.replace(/^deal:/, '');
    if (!inScope(ctx, id)) {
      return {
        result: { error: 'This conversation is scoped to a different deal.' },
        summary: 'Out of scope.',
      };
    }
    const deal = (await store.get('deals', ctx.auth.organizationId, id)) as Deal | null;
    if (!deal)
      return {
        result: { error: 'No such deal in this organization.' },
        summary: 'Deal not found.',
      };

    const [people, analyses, decisions] = await Promise.all([
      store.list('deal_people', ctx.auth.organizationId, { eq: { deal_id: id } }),
      store.list(
        'deal_analyses',
        ctx.auth.organizationId,
        { eq: { deal_id: id } },
        { orderBy: [{ field: 'version', direction: 'desc' }], limit: 1 },
      ) as Promise<DealAnalysis[]>,
      store.list(
        'deal_decisions',
        ctx.auth.organizationId,
        { eq: { deal_id: id } },
        { orderBy: [{ field: 'decided_at', direction: 'desc' }] },
      ) as Promise<DealDecision[]>,
    ]);
    const analysis = analyses[0];

    return {
      result: {
        source_id: dealCitation(ctx, deal),
        deal,
        people,
        latest_analysis: analysis
          ? {
              recommendation: analysis.human_override?.recommendation ?? analysis.recommendation,
              was_overridden: Boolean(analysis.human_override),
              quality_score: analysis.quality_score,
              data_completeness: analysis.data_completeness,
              confidence: analysis.confidence,
              thirty_second_overview: analysis.thirty_second_overview,
              missing_information: analysis.missing_information,
              diligence_questions: analysis.diligence_questions,
              red_flags: analysis.red_flags,
            }
          : null,
        decisions: decisions.map((d) => ({
          decision: d.decision,
          rationale: d.rationale,
          decided_at: d.decided_at,
        })),
        citations: [{ id: `deal:${deal.id}`, label: deal.company_name }],
      },
      summary: `${deal.company_name}: stage ${deal.stage}${
        analysis
          ? `, ${analysis.recommendation.replace(/_/g, ' ')} at ${analysis.confidence}% confidence`
          : ', not yet analysed'
      }.`,
    };
  },
};

const listDealsByStage: ToolSpec<z.ZodObject<{ stage: z.ZodOptional<z.ZodString> }>> = {
  name: 'list_deals_by_stage',
  description: 'List deals grouped by pipeline stage, or all deals in one stage.',
  schema: z.object({ stage: z.string().max(60).optional() }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const deals = (await store.list(
      'deals',
      ctx.auth.organizationId,
      input.stage
        ? { eq: { is_archived: false, stage: input.stage } }
        : { eq: { is_archived: false } },
      { orderBy: [{ field: 'received_at', direction: 'desc' }] },
    )) as Deal[];

    const grouped: Record<string, string[]> = {};
    for (const d of deals) {
      grouped[d.stage] = grouped[d.stage] ?? [];
      grouped[d.stage]!.push(d.company_name);
    }
    return {
      result: {
        total: deals.length,
        by_stage: grouped,
        citations: deals
          .slice(0, 10)
          .map((d) => ({ id: dealCitation(ctx, d), label: d.company_name })),
      },
      summary: `${deals.length} deal(s) across ${Object.keys(grouped).length} stage(s).`,
    };
  },
};

const getDealSources: ToolSpec<z.ZodObject<{ deal_id: z.ZodString }>> = {
  name: 'get_deal_sources',
  description: 'The emails and attachments a deal was built from, with their text.',
  schema: z.object({ deal_id: z.string().max(120) }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const id = input.deal_id.replace(/^deal:/, '');
    if (!inScope(ctx, id)) {
      return {
        result: { error: 'This conversation is scoped to a different deal.' },
        summary: 'Out of scope.',
      };
    }
    const sources = (await store.list('deal_sources', ctx.auth.organizationId, {
      eq: { deal_id: id },
    })) as DealSource[];

    const out: unknown[] = [];
    const citations: { id: string; label: string }[] = [];

    for (const source of sources) {
      if (!source.ref_id) continue;
      if (source.kind === 'email_message') {
        const m = (await store.get(
          'email_messages',
          ctx.auth.organizationId,
          source.ref_id,
        )) as EmailMessage | null;
        if (!m) continue;
        citations.push({ id: emailCitation(ctx, m), label: m.subject ?? '' });
        out.push({
          source_id: `email:${m.id}`,
          kind: 'email',
          from: m.from_address,
          sent_at: m.sent_at,
          subject: m.subject,
          text: truncate(m.body_text ?? m.snippet, 6_000),
        });
      } else if (source.kind === 'attachment') {
        const a = (await store.get(
          'email_attachments',
          ctx.auth.organizationId,
          source.ref_id,
        )) as EmailAttachment | null;
        if (!a) continue;
        const citationId = `attachment:${a.id}:p1`;
        addCitation(ctx, {
          id: citationId,
          kind: 'attachment',
          ref_id: a.id,
          label: a.filename,
          page: 1,
          section: null,
          url: null,
          occurred_at: a.created_at,
          retrieved_at: a.updated_at,
          publisher: null,
          excerpt: truncate(a.extracted_text ?? '', 240),
        });
        citations.push({ id: citationId, label: a.filename });
        out.push({
          source_id: citationId,
          kind: 'attachment',
          filename: a.filename,
          pages: a.page_count,
          extraction_confidence: a.extraction_confidence,
          text: truncate(a.extracted_text ?? '(no text extracted)', 8_000),
        });
      }
    }

    return {
      result: { count: out.length, sources: out, citations },
      summary: `${out.length} source(s) attached to this deal.`,
    };
  },
};

const searchPriorDecisions: ToolSpec<z.ZodObject<{ query: z.ZodOptional<z.ZodString> }>> = {
  name: 'search_prior_decisions',
  description:
    'Past pass/monitor/advance decisions with their rationale. Use to check consistency with how similar companies were treated.',
  schema: z.object({ query: z.string().max(200).optional() }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const decisions = (await store.list(
      'deal_decisions',
      ctx.auth.organizationId,
      {},
      { orderBy: [{ field: 'decided_at', direction: 'desc' }], limit: 40 },
    )) as DealDecision[];

    const out: unknown[] = [];
    const citations: { id: string; label: string }[] = [];
    const q = input.query?.toLowerCase().trim();

    for (const decision of decisions) {
      const deal = (await store.get(
        'deals',
        ctx.auth.organizationId,
        decision.deal_id,
      )) as Deal | null;
      if (!deal) continue;
      const haystack =
        `${deal.company_name} ${deal.industry ?? ''} ${deal.vertical ?? ''} ${decision.rationale}`.toLowerCase();
      if (q && !q.split(/\s+/).some((term) => haystack.includes(term))) continue;

      const citationId = `decision:${decision.id}`;
      addCitation(ctx, {
        id: citationId,
        kind: 'prior_decision',
        ref_id: deal.id,
        label: `${deal.company_name} — ${decision.decision}`,
        page: null,
        section: null,
        url: null,
        occurred_at: decision.decided_at,
        retrieved_at: null,
        publisher: null,
        excerpt: truncate(decision.rationale, 240),
      });
      citations.push({ id: citationId, label: `${deal.company_name} — ${decision.decision}` });
      out.push({
        source_id: citationId,
        company: deal.company_name,
        industry: deal.industry,
        decision: decision.decision,
        rationale: decision.rationale,
        decided_at: decision.decided_at,
      });
      if (out.length >= 8) break;
    }

    return {
      result: {
        count: out.length,
        decisions: out,
        note: 'These are judgements made at a point in time, not objective facts. Cite them explicitly if they inform an answer.',
        citations,
      },
      summary:
        out.length === 0
          ? 'No prior decisions matched.'
          : `${out.length} prior decision(s): ${out.map((d) => (d as { company: string }).company).join(', ')}.`,
    };
  },
};

const searchKnowledgeTool: ToolSpec<
  z.ZodObject<{ query: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>
> = {
  name: 'search_knowledge',
  description:
    'Search uploaded documents — thesis, memos, pass notes, IC notes, market maps, playbooks — with page-level results.',
  schema: z.object({
    query: z.string().max(300),
    limit: z.number().int().min(1).max(15).optional(),
  }),
  mutates: false,
  async run(input, ctx) {
    const hits = await searchKnowledge(ctx.auth.organizationId, input.query, input.limit ?? 6);
    const citations: { id: string; label: string }[] = [];
    for (const hit of hits) {
      const citationId = `document:${hit.documentId}:${hit.chunkId}`;
      addCitation(ctx, {
        id: citationId,
        kind: 'document',
        ref_id: hit.documentId,
        label: hit.documentTitle,
        page: hit.page,
        section: hit.section,
        url: null,
        occurred_at: null,
        retrieved_at: null,
        publisher: null,
        excerpt: truncate(hit.text, 240),
      });
      citations.push({
        id: citationId,
        label: `${hit.documentTitle}${hit.page ? ` p.${hit.page}` : ''}`,
      });
    }
    return {
      result: {
        count: hits.length,
        results: hits.map((h) => ({
          source_id: `document:${h.documentId}:${h.chunkId}`,
          document: h.documentTitle,
          doc_type: h.docType,
          page: h.page,
          section: h.section,
          text: truncate(h.text, 2_000),
        })),
        citations,
      },
      summary:
        hits.length === 0
          ? `Nothing in the knowledge base matched "${input.query}".`
          : `${hits.length} passage(s) from ${new Set(hits.map((h) => h.documentTitle)).size} document(s).`,
    };
  },
};

const listCalendarEvents: ToolSpec<z.ZodObject<{ days: z.ZodOptional<z.ZodNumber> }>> = {
  name: 'list_calendar_events',
  description: 'Calendar events for today or the next N days, with attendees.',
  schema: z.object({ days: z.number().int().min(1).max(14).optional() }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const window = todayWindow(ctx.auth.profile.timezone);
    const end = new Date(window.start.getTime() + (input.days ?? 1) * 86_400_000);
    const events = (await store.list(
      'calendar_events',
      ctx.auth.organizationId,
      { gte: { starts_at: window.start.toISOString() }, lt: { starts_at: end.toISOString() } },
      { orderBy: [{ field: 'starts_at', direction: 'asc' }] },
    )) as CalendarEvent[];

    const citations = events.map((e) => {
      const id = `event:${e.id}`;
      addCitation(ctx, {
        id,
        kind: 'calendar_event',
        ref_id: e.id,
        label: e.title,
        page: null,
        section: null,
        url: null,
        occurred_at: e.starts_at,
        retrieved_at: null,
        publisher: null,
        excerpt: null,
      });
      return { id, label: e.title };
    });

    return {
      result: {
        count: events.length,
        events: events.map((e) => ({
          source_id: `event:${e.id}`,
          title: e.title,
          starts_at: e.starts_at,
          ends_at: e.ends_at,
          // Attendee list only; private descriptions are not surfaced here.
          attendees: e.attendees.map((a) => a.email),
        })),
        citations,
      },
      summary: `${events.length} calendar event(s) in the window.`,
    };
  },
};

const listDueTasks: ToolSpec<z.ZodObject<{ include_overdue: z.ZodOptional<z.ZodBoolean> }>> = {
  name: 'list_due_tasks',
  description: 'Open follow-ups and tasks that are due or overdue.',
  schema: z.object({ include_overdue: z.boolean().optional() }),
  mutates: false,
  async run(_input, ctx) {
    const store = getStore();
    const tasks = (await store.list(
      'tasks',
      ctx.auth.organizationId,
      { eq: { status: 'open' } },
      { orderBy: [{ field: 'due_at', direction: 'asc' }] },
    )) as Task[];
    const now = Date.now();
    const overdue = tasks.filter((t) => t.due_at && Date.parse(t.due_at) < now);
    return {
      result: {
        overdue: overdue.map((t) => ({
          title: t.title,
          due_at: t.due_at,
          detail: t.detail,
          deal_id: t.deal_id,
        })),
        upcoming: tasks
          .filter((t) => !t.due_at || Date.parse(t.due_at) >= now)
          .map((t) => ({ title: t.title, due_at: t.due_at, detail: t.detail })),
        citations: [],
      },
      summary: `${overdue.length} overdue, ${tasks.length - overdue.length} upcoming.`,
    };
  },
};

const searchPortfolioUpdates: ToolSpec<
  z.ZodObject<{ open_only: z.ZodOptional<z.ZodBoolean>; query: z.ZodOptional<z.ZodString> }>
> = {
  name: 'search_portfolio_updates',
  description: 'Portfolio company updates and their open requests for help.',
  schema: z.object({ open_only: z.boolean().optional(), query: z.string().max(200).optional() }),
  mutates: false,
  async run(input, ctx) {
    const store = getStore();
    const updates = (await store.list(
      'portfolio_updates',
      ctx.auth.organizationId,
      input.open_only === false ? {} : { eq: { status: 'open' } },
      { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 15 },
    )) as PortfolioUpdate[];

    const companies = (await store.list(
      'portfolio_companies',
      ctx.auth.organizationId,
      {},
    )) as PortfolioCompany[];

    const citations: { id: string; label: string }[] = [];
    const rows = updates.map((u) => {
      const company = companies.find((c) => c.id === u.portfolio_company_id);
      const id = `portfolio_update:${u.id}`;
      addCitation(ctx, {
        id,
        kind: 'portfolio_update',
        ref_id: u.id,
        label: `${company?.name ?? 'Portfolio'} — ${u.request_type ?? 'update'}`,
        page: null,
        section: null,
        url: null,
        occurred_at: u.occurred_at,
        retrieved_at: null,
        publisher: null,
        excerpt: truncate(u.summary, 240),
      });
      citations.push({
        id,
        label: `${company?.name ?? 'Portfolio'} — ${u.request_type ?? 'update'}`,
      });
      return {
        source_id: id,
        company: company?.name ?? null,
        request_type: u.request_type,
        urgency: u.urgency,
        summary: u.summary,
        request_detail: u.request_detail,
        suggested_action: u.suggested_action,
        status: u.status,
        occurred_at: u.occurred_at,
      };
    });

    return {
      result: { count: rows.length, updates: rows, citations },
      summary:
        rows.length === 0
          ? 'No portfolio updates matched.'
          : `${rows.length} portfolio update(s); ${rows.filter((r) => r.request_type && r.request_type !== 'general_update').length} carry an explicit ask.`,
    };
  },
};

const compareDealsTool: ToolSpec<z.ZodObject<{ deal_ids: z.ZodArray<z.ZodString> }>> = {
  name: 'compare_deals',
  description: 'Compare two to four deals across the dimensions that would change a decision.',
  schema: z.object({ deal_ids: z.array(z.string().max(120)).min(2).max(4) }),
  mutates: false,
  async run(input, ctx) {
    const ids = input.deal_ids.map((i) => i.replace(/^deal:/, ''));
    const result = await compareDeals(ctx.auth, ids);
    if (!result.ok) {
      return { result: { error: result.error.message }, summary: result.error.message };
    }
    for (const c of result.value.citations) ctx.registry.add(c);
    return {
      result: {
        answer: result.value.answer,
        dimensions: result.value.dimensions,
        what_would_change_the_answer: result.value.whatWouldChange,
        citations: result.value.citations.map((c) => ({ id: c.id, label: c.label })),
      },
      summary: truncate(result.value.answer, 240),
    };
  },
};

const generateDealAnalysis: ToolSpec<
  z.ZodObject<{ deal_id: z.ZodString; force: z.ZodOptional<z.ZodBoolean> }>
> = {
  name: 'generate_deal_analysis',
  description:
    'Run or re-run the scorecard analysis for a deal. Returns the recommendation, scores and diligence questions.',
  schema: z.object({ deal_id: z.string().max(120), force: z.boolean().optional() }),
  mutates: true,
  async run(input, ctx) {
    const id = input.deal_id.replace(/^deal:/, '');
    if (!inScope(ctx, id)) {
      return {
        result: { error: 'This conversation is scoped to a different deal.' },
        summary: 'Out of scope.',
      };
    }
    const result = await analyzeDeal(ctx.auth, id, { force: input.force });
    if (!result.ok)
      return { result: { error: result.error.message }, summary: result.error.message };
    const a = result.value;
    for (const c of a.citations) ctx.registry.add(c);
    return {
      result: {
        recommendation: a.recommendation,
        quality_score: a.quality_score,
        data_completeness: a.data_completeness,
        confidence: a.confidence,
        thirty_second_overview: a.thirty_second_overview,
        missing_information: a.missing_information,
        diligence_questions: a.diligence_questions,
        red_flags: a.red_flags,
        citations: a.citations.map((c) => ({ id: c.id, label: c.label })),
      },
      summary: `Analysis v${a.version}: ${a.recommendation.replace(/_/g, ' ')} at ${a.confidence}% confidence on ${a.data_completeness}% data completeness.`,
    };
  },
};

const createTaskTool: ToolSpec<
  z.ZodObject<{
    title: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
    due_at: z.ZodOptional<z.ZodString>;
    deal_id: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: 'create_task',
  description: 'Create a follow-up task. Returns the created task.',
  schema: z.object({
    title: z.string().max(200),
    detail: z.string().max(1000).optional(),
    due_at: z.string().max(40).optional(),
    deal_id: z.string().max(120).optional(),
  }),
  mutates: true,
  async run(input, ctx) {
    const result = await createTask(ctx.auth, {
      title: input.title,
      detail: input.detail ?? null,
      dueAt: input.due_at ?? null,
      dealId: input.deal_id?.replace(/^deal:/, '') ?? null,
      source: 'suggested',
    });
    if (!result.ok)
      return { result: { error: result.error.message }, summary: result.error.message };
    return {
      result: { created: true, task_id: result.value.id, title: result.value.title },
      summary: `Created task: "${result.value.title}".`,
    };
  },
};

const saveNote: ToolSpec<z.ZodObject<{ deal_id: z.ZodString; body: z.ZodString }>> = {
  name: 'save_note',
  description: 'Save a note against a deal.',
  schema: z.object({ deal_id: z.string().max(120), body: z.string().max(4000) }),
  mutates: true,
  async run(input, ctx) {
    const id = input.deal_id.replace(/^deal:/, '');
    if (!inScope(ctx, id)) {
      return {
        result: { error: 'This conversation is scoped to a different deal.' },
        summary: 'Out of scope.',
      };
    }
    const result = await addNote(ctx.auth, id, input.body);
    if (!result.ok)
      return { result: { error: result.error.message }, summary: result.error.message };
    return {
      result: { created: true, note_id: result.value.id },
      summary: 'Note saved to the deal.',
    };
  },
};

const createDraftReply: ToolSpec<
  z.ZodObject<{
    kind: z.ZodEnum<{
      missing_information: 'missing_information';
      pass: 'pass';
      follow_up: 'follow_up';
      meeting_request: 'meeting_request';
      portfolio_reply: 'portfolio_reply';
      generic_reply: 'generic_reply';
    }>;
    deal_id: z.ZodOptional<z.ZodString>;
    portfolio_company_id: z.ZodOptional<z.ZodString>;
    email_message_id: z.ZodOptional<z.ZodString>;
    guidance: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: 'create_draft_reply',
  description:
    'Create an email DRAFT for Nick to review and send himself. This product cannot send email; nothing is transmitted.',
  schema: z.object({
    kind: z.enum([
      'missing_information',
      'pass',
      'follow_up',
      'meeting_request',
      'portfolio_reply',
      'generic_reply',
    ]),
    deal_id: z.string().max(120).optional(),
    portfolio_company_id: z.string().max(120).optional(),
    email_message_id: z.string().max(120).optional(),
    guidance: z.string().max(1000).optional(),
  }),
  mutates: true,
  async run(input, ctx) {
    const result = await createDraft(ctx.auth, {
      kind: input.kind,
      dealId: input.deal_id?.replace(/^deal:/, '') ?? null,
      portfolioCompanyId: input.portfolio_company_id ?? null,
      emailMessageId: input.email_message_id?.replace(/^email:/, '') ?? null,
      guidance: input.guidance,
    });
    if (!result.ok)
      return { result: { error: result.error.message }, summary: result.error.message };
    return {
      result: {
        created: true,
        draft_id: result.value.id,
        subject: result.value.subject,
        sent: false,
        note: 'This is a draft only. Nothing has been sent.',
      },
      summary: `Draft created: "${result.value.subject}". Not sent — the product has no send capability.`,
    };
  },
};

const optionalWebResearch: ToolSpec<
  z.ZodObject<{
    query: z.ZodString;
    purpose: z.ZodEnum<{
      company_background: 'company_background';
      founder_background: 'founder_background';
      competitors: 'competitors';
      market_context: 'market_context';
      funding_announcements: 'funding_announcements';
      product_claims: 'product_claims';
      industry_developments: 'industry_developments';
    }>;
  }>
> = {
  name: 'optional_web_research',
  description:
    'Search the public web. May be unavailable; if it is, say so rather than answering from memory.',
  schema: z.object({
    query: z.string().max(300),
    purpose: z.enum([
      'company_background',
      'founder_background',
      'competitors',
      'market_context',
      'funding_announcements',
      'product_claims',
      'industry_developments',
    ]),
  }),
  mutates: false,
  async run(input, ctx) {
    const provider = getResearchProvider();
    if (!provider.available()) {
      return {
        result: {
          available: false,
          reason: provider.unavailableReason(),
          note: 'Tell the user research is unavailable. Do not substitute recalled information.',
        },
        summary: 'Web research is not configured.',
      };
    }
    const result = await provider.research({ query: input.query, purpose: input.purpose });
    if (!result.ok) {
      return {
        result: { available: false, reason: result.error.message },
        summary: result.error.message,
      };
    }
    const citations = result.value.sources.map((s) => {
      const id = `web:${s.url}`;
      addCitation(ctx, {
        id,
        kind: 'web',
        ref_id: s.url,
        label: s.title,
        page: null,
        section: null,
        url: s.url,
        occurred_at: s.publishedAt,
        retrieved_at: s.retrievedAt,
        publisher: s.publisher,
        excerpt: s.excerpt,
      });
      return { id, label: s.title };
    });
    return {
      result: {
        available: true,
        summary: result.value.summary,
        sources: result.value.sources.map((s) => ({
          source_id: `web:${s.url}`,
          title: s.title,
          url: s.url,
          publisher: s.publisher,
          published_at: s.publishedAt,
          retrieved_at: s.retrievedAt,
          excerpt: s.excerpt,
        })),
        note: 'Public web information. Label it separately from private email and documents, and state the publication date.',
        citations,
      },
      summary: truncate(result.value.summary, 200),
    };
  },
};

/* -------------------------------------------------------------- registry */

/* eslint-disable @typescript-eslint/no-explicit-any -- the specs are a
   heterogeneous list of differently-shaped Zod schemas; each one validates its
   own input inside `executeTool` before the handler ever sees it. */
const ALL_TOOLS: ToolSpec<any>[] = [
  getDailyOutlook,
  searchRecentEmail,
  getEmailThread,
  searchDeals,
  getDeal,
  compareDealsTool,
  listDealsByStage,
  getDealSources,
  searchKnowledgeTool,
  searchPriorDecisions,
  listCalendarEvents,
  listDueTasks,
  searchPortfolioUpdates,
  generateDealAnalysis,
  createDraftReply,
  createTaskTool,
  saveNote,
  optionalWebResearch,
];
/* eslint-enable @typescript-eslint/no-explicit-any */

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

export function toolDefinitions(options: { allowWrites?: boolean } = {}): ToolDefinition[] {
  const allowWrites = options.allowWrites ?? true;
  return ALL_TOOLS.filter((t) => allowWrites || !t.mutates).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toModelJsonSchema(t.schema),
  }));
}

/**
 * Execute one model-requested tool call.
 *
 * An unknown name, an input that fails validation, or a write attempted while
 * writes are disabled all return an error *to the model* rather than throwing —
 * the model can then correct itself, and the failure is visible in the
 * transcript instead of collapsing the whole answer.
 */
export async function executeTool(
  invocation: ToolInvocation,
  ctx: ToolContext,
  options: { allowWrites?: boolean } = {},
): Promise<ToolOutcome> {
  const allowWrites = options.allowWrites ?? true;
  const spec = ALL_TOOLS.find((t) => t.name === invocation.name);

  if (!spec) {
    return {
      name: invocation.name,
      ok: false,
      content: JSON.stringify({
        error: `"${invocation.name}" is not an available tool. Available tools: ${TOOL_NAMES.join(', ')}.`,
      }),
      summary: `Refused unknown tool "${invocation.name}".`,
      input: invocation.input,
    };
  }

  if (spec.mutates && !allowWrites) {
    return {
      name: spec.name,
      ok: false,
      content: JSON.stringify({ error: 'Write tools are disabled for this request.' }),
      summary: `Refused write tool "${spec.name}".`,
      input: invocation.input,
    };
  }

  const parsed = spec.schema.safeParse(invocation.input);
  if (!parsed.success) {
    return {
      name: spec.name,
      ok: false,
      content: JSON.stringify({
        error: 'Invalid input.',
        issues: parsed.error.issues
          .slice(0, 4)
          .map(
            (issue: z.core.$ZodIssue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          ),
      }),
      summary: `Rejected invalid input for "${spec.name}".`,
      input: invocation.input,
    };
  }

  try {
    const { result, summary } = await spec.run(parsed.data, ctx);
    return {
      name: spec.name,
      ok: true,
      content: JSON.stringify(result),
      summary,
      input: parsed.data as Record<string, unknown>,
    };
  } catch (error) {
    log.error('Tool execution failed', {
      tool: spec.name,
      reason: (error as Error)?.message,
    });
    return {
      name: spec.name,
      ok: false,
      content: JSON.stringify({ error: 'The tool failed to run. Do not retry it more than once.' }),
      summary: `"${spec.name}" failed.`,
      input: parsed.data as Record<string, unknown>,
    };
  }
}
