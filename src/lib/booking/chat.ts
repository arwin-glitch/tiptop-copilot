import 'server-only';
import { z } from 'zod';
import { estimateCostUsd, modelFor } from '@/lib/ai/models';
import type {
  AIProvider,
  ToolDefinition,
  ToolInvocation,
  ToolOutcome,
  UsageInfo,
} from '@/lib/ai/provider';
import { envLimits } from '@/lib/config/env';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { getAI } from '@/lib/runtime';
import { rateLimit, recordAiUsage } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import {
  engineInputFor,
  readHost,
  resolveOpenLink,
  type BookingDeps,
  type OpenLink,
} from '@/lib/services/booking';
import { principalTimeZone } from '@/lib/services/push-alerts';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type AppError, type Result } from '@/lib/util/result';
import {
  BOOKING_CHAT_PROMPT_VERSION,
  bookingChatSystemPrompt,
  fenceConversation,
} from './chat-prompt';
import {
  firstName,
  inPersonOffered,
  KIND_LABEL,
  MEETING_KINDS,
  TYPE_LABEL,
  type MeetingKind,
  type MeetingType,
} from './config';
import { openSlots, type EngineInput, type OpenSlot } from './engine';
import { callOptionLabel, dayKeyIn, knownZone, slotLabel, videoProviderLabel } from './public';
import { CHAT_FORM_FILL, type ChatFormFill } from './request';

/**
 * The public booking page's chatbot, "Arwin" (D-074).
 *
 * Its whole world is three tools: open times (start and end instants, read
 * through the same engine as the page), the public FAQ text from Settings,
 * and a form fill the visitor still has to send. It is never handed a
 * calendar entry, a mailbox, a contact or a record, so it cannot leak one.
 *
 * Live (the model) only when all of these hold: the chatbot is on in
 * Settings, a real API key is set, this month's chatbot spend is under the
 * Settings cap ($20 by default), the organization's daily AI budget has room,
 * and this visitor's address is under its message limit. Otherwise it is the
 * guided helper: three buttons (Find a time, About TipTop, Leave a message)
 * that use the same tools with no model at all.
 */

export const BOOKING_CHAT_OPERATION = 'booking.chat';
const CHAT_MAX_TOKENS = 600;
const CHAT_MAX_ITERATIONS = 3;
/**
 * The most input one model round can take: the system prompt and tools, the
 * fenced conversation (lib/booking/chat-prompt.ts caps it) and the tool
 * answers of earlier rounds, with room for text that costs several tokens a
 * character.
 */
const CHAT_INPUT_TOKENS_CEILING = 20_000;

/**
 * What a failed turn is counted as against the monthly cap and the daily
 * budget when the provider could not say what it spent: every round at its
 * ceiling. Counting a failure as free, or as a token amount, would let a
 * stream of failures run past the cap unseen.
 */
export function unreportedTurnCostUsd(model: string = modelFor('fast')): number {
  return (
    CHAT_MAX_ITERATIONS * estimateCostUsd(model, CHAT_INPUT_TOKENS_CEILING, CHAT_MAX_TOKENS, 0)
  );
}

/** Slots one answer offers at most. */
const SLOTS_PER_ANSWER = 8;

/** Per visitor address: the model's messages, then any chatbot request at all. */
const LIVE_PER_10_MIN = 10;
const LIVE_PER_DAY = 40;
const ANY_PER_10_MIN = 60;
/** The whole link's live messages an hour, whoever sends them (in memory: resets on a deploy). */
const LIVE_ORG_PER_HOUR = 60;
/** The whole link's model turns in a day, counted from ai_usage (holds across deploys). */
export const LIVE_LINK_PER_DAY = 400;

export const GUIDED_ACTIONS = ['find_time', 'about', 'message'] as const;
export type GuidedAction = (typeof GUIDED_ACTIONS)[number];

export const CHAT_REQUEST = z
  .object({
    mode: z.enum(['live', 'guided']).default('live'),
    action: z.enum(GUIDED_ACTIONS).optional(),
    type: z.enum(['call', 'in_person']).optional(),
    kind: z.enum(MEETING_KINDS).optional(),
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), content: z.string().trim().max(600) })
          .strict(),
      )
      .max(12)
      .default([]),
    timeZone: z.string().max(64).optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof CHAT_REQUEST>;

export interface ChatSlot {
  start: string;
  end: string;
  label: string;
}

export interface ChatReply {
  mode: 'live' | 'guided';
  reply: string;
  /** Times to offer as buttons; a tap puts one in the form. */
  slots: ChatSlot[];
  /** The meeting the slots are for, so a tap fills the right kind. */
  query?: { type: MeetingType; kind: MeetingKind | null };
  /** What to put in the form. The visitor still reviews it and presses Send. */
  fill: ChatFormFill | null;
  /** Why the helper is guided right now, in plain words, when it fell back. */
  notice?: string;
}

/* ------------------------------------------------------------------ tools */

export const BOOKING_CHAT_TOOLS: ToolDefinition[] = [
  {
    name: 'find_open_slots',
    description:
      'Open times on the booking page. Returns only start and end times and a label in the visitor time zone. Nothing else about the calendar is available.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        meeting_type: { type: 'string', enum: ['call', 'in_person'] },
        kind: { type: 'string', enum: ['coffee', 'lunch', 'dinner'] },
        date: {
          type: 'string',
          description: 'Optional day in the visitor time zone, YYYY-MM-DD.',
        },
      },
      required: ['meeting_type'],
    },
  },
  {
    name: 'get_faq',
    description:
      'The public FAQ about the firm, written by the host’s team. The only source for questions about the firm.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'fill_form',
    description:
      'Fill in the request form on the page for the visitor. It is never sent: the visitor reviews it and presses Send. Use a start time only from find_open_slots.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        company: { type: 'string' },
        type: { type: 'string', enum: ['call', 'in_person', 'message'] },
        kind: { type: 'string', enum: ['coffee', 'lunch', 'dinner'] },
        start: { type: 'string', description: 'A start time exactly as find_open_slots gave it.' },
        placeId: { type: 'string', description: 'The id of one of the listed places.' },
        customPlace: { type: 'string', description: 'A place the visitor suggested.' },
        note: { type: 'string', description: 'The reason for the meeting, or the message.' },
        deckUrl: { type: 'string', description: 'An http or https link to a deck.' },
      },
    },
  },
];

export interface OfferedSlot extends ChatSlot {
  /** The meeting it was found for: a fill that uses it takes this type and kind. */
  query: { type: MeetingType; kind: MeetingKind | null };
}

export interface ToolScope {
  link: OpenLink;
  /** The engine input, read once per chat turn. */
  input: () => Promise<EngineInput | null>;
  visitorZone: string;
  /** Starts the find tool offered this turn, which a fill may use. */
  offered: Map<string, OfferedSlot>;
  /** The meeting the last find was for. */
  lastQuery: { type: MeetingType; kind: MeetingKind | null } | null;
  fills: ChatFormFill[];
}

function outcome(
  invocation: ToolInvocation,
  okFlag: boolean,
  content: unknown,
  summary: string,
): ToolOutcome {
  return {
    name: invocation.name,
    ok: okFlag,
    content: JSON.stringify(content),
    summary,
    input: invocation.input,
  };
}

/** Times per day in an answer that is not for one day, so a few days are offered. */
const SLOTS_PER_DAY = 2;

/**
 * Open times for a query, labelled for the visitor: start, end and a label,
 * nothing more. For one day, that day's first eight; otherwise at most two a
 * day, soonest first, so the answer spreads over several days.
 */
export function chatSlots(
  input: EngineInput,
  query: { type: MeetingType; kind: MeetingKind | null },
  visitorZone: string,
  date?: string | null,
): ChatSlot[] {
  const perDay = new Map<string, number>();
  const picked: OpenSlot[] = [];
  for (const slot of openSlots(input, query)) {
    if (picked.length >= SLOTS_PER_ANSWER) break;
    const day = dayKeyIn(slot.start, visitorZone);
    if (date && day !== date) continue;
    const taken = perDay.get(day) ?? 0;
    if (!date && taken >= SLOTS_PER_DAY) continue;
    perDay.set(day, taken + 1);
    picked.push(slot);
  }
  return picked.map((s) => ({
    start: s.start,
    end: s.end,
    label: slotLabel(s.start, visitorZone),
  }));
}

/**
 * Run one tool call. The only door between the model and the server: each
 * answer is built from the engine's open times, the FAQ text, or the fill's
 * own fields, and nothing else is in reach here.
 */
export async function runBookingTool(
  invocation: ToolInvocation,
  scope: ToolScope,
): Promise<ToolOutcome> {
  const { config } = scope.link;
  if (invocation.name === 'get_faq') {
    const faq = config.faq.trim();
    return outcome(
      invocation,
      true,
      {
        faq: faq || null,
        note: faq ? undefined : 'No FAQ has been written. Offer to take a message.',
      },
      'Read the public FAQ',
    );
  }
  if (invocation.name === 'find_open_slots') {
    const raw = invocation.input;
    const type: MeetingType = raw.meeting_type === 'in_person' ? 'in_person' : 'call';
    const kind = (MEETING_KINDS as readonly unknown[]).includes(raw.kind)
      ? (raw.kind as MeetingKind)
      : null;
    if (type === 'in_person' && !inPersonOffered(config)) {
      return outcome(
        invocation,
        true,
        { slots: [], note: 'Only calls are offered.' },
        'No in person',
      );
    }
    if (type === 'in_person' && !kind) {
      return outcome(
        invocation,
        false,
        { error: 'Ask whether they want coffee, lunch or dinner, then call again with kind.' },
        'Needs a kind',
      );
    }
    const input = await scope.input();
    if (!input) {
      return outcome(
        invocation,
        false,
        { error: 'Open times cannot be read right now. Offer to take a message.' },
        'Times unavailable',
      );
    }
    const date =
      typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
    const slots = chatSlots(input, { type, kind }, scope.visitorZone, date);
    for (const s of slots) scope.offered.set(s.start, { ...s, query: { type, kind } });
    scope.lastQuery = { type, kind };
    return outcome(
      invocation,
      true,
      {
        // What a call is on, by name only: the saved link goes in the invite alone.
        meeting:
          type === 'call'
            ? callOptionLabel(videoProviderLabel(config.callLink))
            : `${TYPE_LABEL.in_person}: ${KIND_LABEL[kind!]}`,
        visitor_time_zone: scope.visitorZone,
        slots: slots.map((s) => ({ start: s.start, label: s.label })),
      },
      `Found ${slots.length} open times`,
    );
  }
  if (invocation.name === 'fill_form') {
    const parsed = CHAT_FORM_FILL.safeParse(invocation.input);
    if (!parsed.success) {
      return outcome(invocation, false, { error: 'Those fields could not be used.' }, 'Bad fill');
    }
    const fill = { ...parsed.data };
    if (fill.start) {
      const at = Date.parse(fill.start);
      const offered = Number.isFinite(at)
        ? scope.offered.get(new Date(at).toISOString())
        : undefined;
      if (!offered) {
        return outcome(
          invocation,
          false,
          { error: 'Use a start time exactly as find_open_slots returned it this turn.' },
          'Time not offered',
        );
      }
      fill.start = offered.start;
      // The time was found for one meeting: the fill is for that one, never
      // a call's time with "coffee" (the page would show a time it cannot send).
      fill.type = offered.query.type;
      if (offered.query.kind) fill.kind = offered.query.kind;
      else delete fill.kind;
    }
    if (fill.placeId && !config.places.some((p) => p.id === fill.placeId)) delete fill.placeId;
    if (fill.customPlace && !config.allowCustomPlace) delete fill.customPlace;
    scope.fills.push(fill);
    return outcome(
      invocation,
      true,
      { filled: Object.keys(fill), note: 'The visitor reviews the form and presses Send.' },
      'Filled the form',
    );
  }
  return outcome(invocation, false, { error: 'Unknown tool.' }, 'Unknown tool');
}

/* ------------------------------------------------------------ live or guided */

function startOfMonthUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * This month's chatbot spend, the organization's spend over the last day,
 * and the chatbot's model turns over the last day. Every page of rows is
 * read (lib/db/paging.ts): a plain list stops at the database's first 1,000,
 * and a cap summed over part of the rows would never trip.
 */
async function spend(
  store: DataStore,
  organizationId: string,
  now: Date,
): Promise<{ month: number; day: number; turnsToday: number }> {
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const [month, day, turnsToday] = await Promise.all([
    listAllPages(store, 'ai_usage', organizationId, {
      eq: { operation: BOOKING_CHAT_OPERATION },
      gte: { created_at: startOfMonthUtc(now) },
    }),
    listAllPages(store, 'ai_usage', organizationId, { gte: { created_at: dayAgo } }),
    store.count('ai_usage', organizationId, {
      eq: { operation: BOOKING_CHAT_OPERATION },
      gte: { created_at: dayAgo },
    }),
  ]);
  const sum = (rows: { estimated_cost_usd: number | null }[]) =>
    rows.reduce((total, r) => total + (r.estimated_cost_usd ?? 0), 0);
  return { month: sum(month), day: sum(day), turnsToday };
}

export type ChatModeReason = 'off' | 'no_key' | 'monthly_cap' | 'daily_budget' | 'busy' | null;
type ChatMode = { mode: 'live' | 'guided'; reason: ChatModeReason };

/** The public page's answer, kept briefly per link so a burst of page views reads the spend once. */
const modeCache = processWide(
  'booking-chat-mode',
  () => new Map<string, { at: number; value: ChatMode }>(),
);

/**
 * Whether the chatbot may use the model now. Never throws: any doubt is
 * guided. `cacheMs` (the public page only) reuses an answer that young; a
 * chat turn always asks afresh.
 */
export async function chatModeFor(
  store: DataStore,
  link: OpenLink,
  options: { ai?: AIProvider; now?: Date; cacheMs?: number } = {},
): Promise<ChatMode> {
  if (!link.config.chatbotEnabled) return { mode: 'guided', reason: 'off' };
  const ai = options.ai ?? getAI();
  // The demo's offline stub writes about fictional deals; it is not a chatbot.
  if (ai.kind !== 'anthropic' || !ai.available()) return { mode: 'guided', reason: 'no_key' };
  const now = options.now ?? new Date();
  const key = `${link.organizationId}:${link.config.monthlyAiCapUsd}`;
  const cached = options.cacheMs ? modeCache.get(key) : undefined;
  if (cached && now.getTime() - cached.at < (options.cacheMs ?? 0)) return cached.value;
  let value: ChatMode = { mode: 'live', reason: null };
  try {
    const used = await spend(store, link.organizationId, now);
    if (used.month >= link.config.monthlyAiCapUsd) {
      value = { mode: 'guided', reason: 'monthly_cap' };
    } else if (used.day >= envLimits().dailyAiBudgetUsd || used.turnsToday >= LIVE_LINK_PER_DAY) {
      value = { mode: 'guided', reason: 'daily_budget' };
    }
  } catch {
    return { mode: 'guided', reason: 'busy' };
  }
  modeCache.set(key, { at: now.getTime(), value });
  return value;
}

/** Tests: forget the page's cached answers. */
export function resetChatModeCache(): void {
  modeCache.clear();
}

/**
 * What a failed turn is recorded as: what the provider says it spent before
 * failing (lib/ai/anthropic.ts puts it on the error), else the worst case.
 */
export function failedTurnUsage(error: AppError, model: string = modelFor('fast')): UsageInfo {
  const d = error.details ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const reported = num(d.usageCostUsd);
  return {
    model: typeof d.usageModel === 'string' ? d.usageModel : model,
    inputTokens: num(d.usageInputTokens),
    outputTokens: num(d.usageOutputTokens),
    cacheReadTokens: num(d.usageCacheReadTokens),
    estimatedCostUsd: reported ?? unreportedTurnCostUsd(model),
    durationMs: 0,
  };
}

const GUIDED_NOTICE: Record<Exclude<ChatModeReason, null>, string> = {
  off: 'The chatbot is off, so these buttons do the job.',
  no_key: 'I am in simple mode right now: tap a button below.',
  monthly_cap: 'I am in simple mode for the rest of the month: tap a button below.',
  daily_budget: 'I am in simple mode for today: tap a button below.',
  busy: 'I am in simple mode right now: tap a button below.',
};

function visitorZoneOf(zone: string | undefined, hostZone: string): string {
  return knownZone(zone) ? zone : hostZone;
}

/** The guided helper: the same tools, no model, one answer per button. */
export async function guidedReply(
  scope: ToolScope,
  request: Pick<ChatRequest, 'action' | 'type' | 'kind'>,
  hostFirst: string,
  notice?: string,
): Promise<ChatReply> {
  const who = hostFirst || 'the host';
  const base = { mode: 'guided' as const, slots: [], fill: null, ...(notice ? { notice } : {}) };
  if (request.action === 'about') {
    const faq = scope.link.config.faq.trim();
    return { ...base, reply: faq || `I can take a message for ${who}.` };
  }
  if (request.action === 'message') {
    return {
      ...base,
      reply: 'Write your message (and a deck link, if you like) in the form, then press Send.',
      fill: { type: 'message' },
    };
  }
  if (request.action === 'find_time') {
    const type: MeetingType = request.type === 'in_person' ? 'in_person' : 'call';
    const kind = type === 'in_person' ? (request.kind ?? null) : null;
    if (type === 'in_person' && !inPersonOffered(scope.link.config)) {
      return { ...base, reply: 'Only calls are offered on this page.' };
    }
    if (type === 'in_person' && !kind) {
      return { ...base, reply: 'Coffee, lunch or dinner? Pick one below.' };
    }
    const input = await scope.input();
    if (!input) {
      return {
        ...base,
        reply: 'Open times cannot be shown right now. You can leave a message instead.',
      };
    }
    const slots = chatSlots(input, { type, kind }, scope.visitorZone);
    const what =
      type === 'call'
        ? `a ${callOptionLabel(videoProviderLabel(scope.link.config.callLink))}`
        : `${KIND_LABEL[kind!].toLowerCase()} (1 hour, in person)`;
    return {
      ...base,
      slots,
      query: { type, kind },
      reply: slots.length
        ? `Here are the next open times for ${what}, in your time zone. Tap one to put it in the form.`
        : `There are no open times for ${what} in the next few weeks. You can leave a message instead.`,
    };
  }
  return {
    ...base,
    reply: `Hi, I'm Arwin, ${who}'s AI scheduling assistant. I can find a time, tell you about the firm, or take a message.`,
  };
}

export interface ChatContext extends BookingDeps {
  /** The visitor's address key (lib/security/client-address addressKey), for the brakes. */
  addressKey: string;
  ai?: AIProvider;
}

/**
 * One chatbot turn. Live when allowed, else guided; either way, the reply
 * carries at most a list of open times and a form fill, never a send.
 */
export async function runBookingChat(
  store: DataStore,
  slug: string,
  request: ChatRequest,
  context: ChatContext,
): Promise<Result<ChatReply>> {
  const now = context.now ?? new Date();
  const found = await resolveOpenLink(store, slug);
  if (!found.open || !found.link.config.chatbotEnabled) {
    return err('forbidden', 'The chatbot is not available on this page.');
  }
  const link = found.link;
  const any = rateLimit(`booking-chat-any:${context.addressKey}`, ANY_PER_10_MIN, 600_000);
  if (!any.ok) return any;

  const [hostZone, host] = await Promise.all([
    principalTimeZone(store, link.organizationId),
    readHost(store, link.organizationId).catch(() => null),
  ]);
  const hostName = link.config.displayName || host?.fullName || '';
  const hostFirst = firstName(hostName);
  let cached: Promise<EngineInput | null> | null = null;
  const scope: ToolScope = {
    link,
    visitorZone: visitorZoneOf(request.timeZone, hostZone),
    offered: new Map(),
    lastQuery: null,
    fills: [],
    input: () =>
      (cached ??= engineInputFor(store, link, { now, source: context.source })
        .then((r) => (r.ok ? r.value.input : null))
        .catch(() => null)),
  };

  const userTurns = request.messages.filter((m) => m.role === 'user' && m.content);
  if (request.mode === 'guided' || request.action || userTurns.length === 0) {
    return ok(await guidedReply(scope, request, hostFirst));
  }

  const mode = await chatModeFor(store, link, { ai: context.ai, now });
  if (mode.mode === 'guided') {
    return ok(await guidedReply(scope, {}, hostFirst, GUIDED_NOTICE[mode.reason ?? 'busy']));
  }
  const brakes = [
    rateLimit(`booking-chat-live:${context.addressKey}`, LIVE_PER_10_MIN, 600_000),
    rateLimit(`booking-chat-live-day:${context.addressKey}`, LIVE_PER_DAY, 86_400_000),
    rateLimit(`booking-chat-live-org:${link.organizationId}`, LIVE_ORG_PER_HOUR, 3_600_000),
  ];
  if (brakes.some((b) => !b.ok)) {
    return ok(
      await guidedReply(
        scope,
        {},
        hostFirst,
        'You have sent a lot of messages, so I am in simple mode for a while: tap a button below.',
      ),
    );
  }

  const ai = context.ai ?? getAI();
  const today = dayKeyIn(now.toISOString(), scope.visitorZone);
  const system = bookingChatSystemPrompt({
    hostName,
    hostFirstName: hostFirst,
    firmName: link.config.firmName,
    hostTimeZone: hostZone,
    visitorTimeZone: scope.visitorZone,
    today,
    offersInPerson: inPersonOffered(link.config),
    callProvider: videoProviderLabel(link.config.callLink),
  });
  // One visitor turn holding the whole conversation as fenced data: the page
  // keeps the history, so an "assistant" line from it is never trusted as one.
  const messages = [{ role: 'user' as const, content: fenceConversation(request.messages) }];

  const result = await ai.runToolConversation({
    tier: 'fast',
    operation: BOOKING_CHAT_OPERATION,
    promptVersion: BOOKING_CHAT_PROMPT_VERSION,
    system,
    messages,
    tools: BOOKING_CHAT_TOOLS,
    execute: (invocation) => runBookingTool(invocation, scope),
    finalSchema: z.object({ reply: z.string().max(1200) }),
    maxIterations: CHAT_MAX_ITERATIONS,
    maxTokens: CHAT_MAX_TOKENS,
  });
  await recordAiUsage(store, {
    organizationId: link.organizationId,
    userId: null,
    operation: BOOKING_CHAT_OPERATION,
    promptVersion: BOOKING_CHAT_PROMPT_VERSION,
    usage: result.ok ? result.value.usage : failedTurnUsage(result.error),
    ok: result.ok,
    errorCode: result.ok ? null : result.error.code,
  }).catch((error: unknown) => {
    log.warn('Booking chat usage could not be recorded', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
  if (!result.ok) {
    return ok(
      await guidedReply(scope, {}, hostFirst, 'I could not answer just now: tap a button below.'),
    );
  }
  const offered = [...scope.offered.values()].map(({ start, end, label }): ChatSlot => ({
    start,
    end,
    label,
  }));
  return ok({
    mode: 'live',
    reply: result.value.value.reply.trim().slice(0, 1200),
    slots: offered.slice(0, SLOTS_PER_ANSWER),
    ...(scope.lastQuery ? { query: scope.lastQuery } : {}),
    fill: scope.fills.length ? Object.assign({}, ...scope.fills) : null,
  });
}
