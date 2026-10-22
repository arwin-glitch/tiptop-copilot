import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import {
  BOOKING_NOT_SET_UP,
  engineInputFor,
  readHost,
  resolveOpenLink,
  type BookingDeps,
  type OpenLink,
} from '@/lib/services/booking';
import { principalTimeZone } from '@/lib/services/push-alerts';
import { err, ok, type Result } from '@/lib/util/result';
import {
  askBookingRoutine,
  bookingChatConfigured,
  buildQuestionFacts,
  cleanQuestion,
  bookingChatStatus,
  readBookingAnswer,
  type AskUnavailable,
  type BookingChatStatus,
  type BookingAnswerView,
  type BookingQuestionFacts,
} from './chat-bridge';
import {
  CHATBOT_CONFIG_PATCH,
  CHATBOT_CONFIG_SCHEMA,
  readChatbotConfig,
  readGuestRules,
  type ChatbotConfig,
  type ChatbotConfigPatch,
} from './chatbot-config';
import {
  firstName,
  parseBookingConfig,
  inPersonOffered,
  KIND_LABEL,
  MEETING_KINDS,
  type MeetingKind,
  type MeetingType,
} from './config';
import { openSlots, type EngineInput } from './engine';
import {
  builtInEntries,
  detectIntent,
  faqEntries,
  matchFaq,
  type ChatIntent,
  type FaqEntry,
  type PublicFacts,
} from './faq';
import { dayKeyIn, knownZone, slotLabel, zoneName } from './public';

/**
 * The public booking page's assistant, "Arwin" (D-078): no paid AI at all.
 *
 * - A guided helper: buttons for a 30-minute call, meeting in person, a
 *   question, or a message. It offers the engine's next open times and the
 *   listed places; the widget books through the same public request route
 *   as the form (`/api/meet/[slug]/request`), so every rule, cap and brake
 *   applies the same way.
 * - Answers without AI: the visitor's words are matched, here, against the
 *   questions Arwin wrote in the Booking tab and a few built from the public
 *   card (lib/booking/faq.ts), and the best answer is given word for word.
 * - Optionally, a question nothing matches goes to the booking assistant
 *   routine on Arwin's own Claude plan (lib/booking/chat-bridge.ts): no API
 *   key, nothing billed, capped. The widget polls for its answer.
 *
 * It never sees a calendar entry, a mailbox, a contact or a record: open
 * times are start and end instants, and the facts are the public card, the
 * written answers and the offers. Visitor text is data, never instructions.
 */

/** Open times one answer offers at most, and per day when spread over days. */
const SLOTS_PER_PAGE = 8;
const SLOTS_PER_DAY = 2;
const MAX_PAGES = 4;
/** Free-text questions per visitor address, before anything is read. */
const ASKS_PER_10_MIN = 30;

const ZONE = z.string().max(64).optional();

export const CHAT_REQUEST = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), timeZone: ZONE }).strict(),
  z
    .object({
      action: z.literal('times'),
      type: z.enum(['call', 'in_person']),
      kind: z.enum(MEETING_KINDS).optional(),
      page: z.number().int().min(0).max(MAX_PAGES).default(0),
      timeZone: ZONE,
    })
    .strict(),
  z
    .object({
      action: z.literal('ask'),
      question: z.string().trim().min(1).max(600),
      /** The widget's own random id for this visit (the per-session AI cap). */
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
      timeZone: ZONE,
    })
    .strict(),
]);
export type ChatRequest = z.infer<typeof CHAT_REQUEST>;

export interface ChatSlot {
  start: string;
  end: string;
  label: string;
}

export interface ChatPlace {
  id: string;
  name: string;
  area: string;
}

export interface ChatStart {
  action: 'start';
  hostName: string;
  hostFirst: string;
  firmName: string;
  greeting: string;
  offers: { call: boolean; inPerson: boolean };
  kinds: MeetingKind[];
  places: ChatPlace[];
  allowCustomPlace: boolean;
  guests: { allowed: boolean; max: number };
  /** A few written questions, as chips. */
  suggestions: string[];
  /** A question nothing matches may go to the booking assistant routine. */
  aiAnswers: boolean;
  zoneLabel: string;
}

export interface ChatTimes {
  action: 'times';
  query: { type: MeetingType; kind: MeetingKind | null };
  slots: ChatSlot[];
  /** Another page of times exists. */
  more: boolean;
  zoneLabel: string;
  reply: string;
}

export type ChatAnswer =
  | {
      action: 'ask';
      kind: 'answer';
      answer: string;
      /** The written question that answered. */
      matched: string;
      suggestions: string[];
    }
  | { action: 'ask'; kind: 'intent'; intent: ChatIntent; reply: string; suggestions: string[] }
  | { action: 'ask'; kind: 'pending'; questionId: string; reply: string; suggestions: string[] }
  | {
      action: 'ask';
      kind: 'none';
      reply: string;
      suggestions: string[];
      reason: AskUnavailable | 'no_match';
    };

export type ChatReply = ChatStart | ChatTimes | ChatAnswer;

/* ------------------------------------------------------------------ times */

/**
 * Open times for a query, labelled for the visitor: start, end and a label,
 * nothing more. At most two a day, soonest first, eight to a page, so one
 * answer spreads over several days and "More times" goes further out.
 */
export function chatSlots(
  input: EngineInput,
  query: { type: MeetingType; kind: MeetingKind | null },
  visitorZone: string,
  page = 0,
): { slots: ChatSlot[]; more: boolean } {
  const perDay = new Map<string, number>();
  const picked: ChatSlot[] = [];
  const want = (page + 1) * SLOTS_PER_PAGE + 1;
  for (const slot of openSlots(input, query)) {
    if (picked.length >= want) break;
    const day = dayKeyIn(slot.start, visitorZone);
    const taken = perDay.get(day) ?? 0;
    if (taken >= SLOTS_PER_DAY) continue;
    perDay.set(day, taken + 1);
    picked.push({ start: slot.start, end: slot.end, label: slotLabel(slot.start, visitorZone) });
  }
  const from = page * SLOTS_PER_PAGE;
  return {
    slots: picked.slice(from, from + SLOTS_PER_PAGE),
    more: picked.length > from + SLOTS_PER_PAGE,
  };
}

/* -------------------------------------------------------------- the link */

interface ChatContextData {
  link: OpenLink;
  chatbot: ChatbotConfig;
  hostName: string;
  hostFirst: string;
  hostZone: string;
  visitorZone: string;
  inPerson: boolean;
  kinds: MeetingKind[];
  guests: { allowed: boolean; max: number };
  bookingUrl: string;
}

/** The public facts the assistant may use: the card, the offers, the places. */
export function publicFactsFor(data: ChatContextData): PublicFacts {
  const { config } = data.link;
  return {
    hostName: data.hostName,
    hostFirst: data.hostFirst,
    title: config.title,
    bio: config.bio,
    firmName: config.firmName,
    offersCall: true,
    inPersonKinds: data.inPerson ? data.kinds.map((k) => KIND_LABEL[k]) : [],
    places: data.inPerson
      ? config.places.map((p) => (p.area ? `${p.name} (${p.area})` : p.name))
      : [],
    allowCustomPlace: data.inPerson && config.allowCustomPlace,
    guestsAllowed: data.guests.allowed,
    maxGuests: data.guests.max,
  };
}

/** Every answer the assistant may give: Arwin's written ones first, then the card's. */
export function answerEntries(data: ChatContextData): FaqEntry[] {
  return [...faqEntries(data.chatbot.faqItems), ...builtInEntries(publicFactsFor(data))];
}

/** The booking page's own address, the one link an AI answer may keep. */
export function bookingUrlFor(slug: string): string {
  return `${env().appUrl.replace(/\/+$/, '')}/meet/${slug}`;
}

/** The assistant's view of a link, open or not (the Booking tab reads it while off). */
async function contextOf(
  store: DataStore,
  link: OpenLink,
  timeZone: string | undefined,
): Promise<ChatContextData> {
  const chatbot = readChatbotConfig(link.row.settings);
  const [hostZone, host] = await Promise.all([
    principalTimeZone(store, link.organizationId),
    readHost(store, link.organizationId).catch(() => null),
  ]);
  const hostName = link.config.displayName || host?.fullName || '';
  const kinds = MEETING_KINDS.filter((k) => (link.config.kindWindows[k] ?? []).length > 0);
  const inPerson = inPersonOffered(link.config) && kinds.length > 0;
  return {
    link,
    chatbot,
    hostName,
    hostFirst: firstName(hostName),
    hostZone,
    visitorZone: knownZone(timeZone) ? timeZone : hostZone,
    inPerson,
    kinds: inPerson ? kinds : [],
    guests: readGuestRules(link.row.settings),
    bookingUrl: bookingUrlFor(link.row.slug),
  };
}

async function contextFor(
  store: DataStore,
  slug: string,
  timeZone: string | undefined,
): Promise<Result<ChatContextData>> {
  const found = await resolveOpenLink(store, slug);
  if (!found.open) return err('forbidden', 'The assistant is not available on this page.');
  const data = await contextOf(store, found.link, timeZone);
  if (!data.chatbot.enabled)
    return err('forbidden', 'The assistant is not available on this page.');
  return ok(data);
}

/* ------------------------------------------------------------- the actions */

function startReply(data: ChatContextData): ChatStart {
  const who = data.hostFirst || 'the host';
  const { config } = data.link;
  return {
    action: 'start',
    hostName: data.hostName,
    hostFirst: data.hostFirst,
    firmName: config.firmName,
    greeting: `Hi, I'm Arwin, ${who}'s AI scheduling assistant. I can book a time with ${who}, answer a question, or pass on a message.`,
    offers: { call: true, inPerson: data.inPerson },
    kinds: data.kinds,
    places: data.inPerson
      ? config.places.map((p) => ({ id: p.id, name: p.name, area: p.area }))
      : [],
    allowCustomPlace: data.inPerson && config.allowCustomPlace,
    guests: data.guests,
    suggestions: data.chatbot.faqItems.slice(0, 4).map((item) => item.q),
    aiAnswers: data.chatbot.aiAnswers && bookingChatConfigured(),
    zoneLabel: zoneName(data.visitorZone),
  };
}

async function timesReply(
  store: DataStore,
  data: ChatContextData,
  request: Extract<ChatRequest, { action: 'times' }>,
  deps: BookingDeps,
): Promise<ChatTimes> {
  const type: MeetingType = request.type;
  const kind = type === 'in_person' ? (request.kind ?? null) : null;
  const query = { type, kind };
  const zoneLabel = zoneName(data.visitorZone);
  const empty = (reply: string): ChatTimes => ({
    action: 'times',
    query,
    slots: [],
    more: false,
    zoneLabel,
    reply,
  });
  if (type === 'in_person' && !data.inPerson) return empty('Only calls can be booked here.');
  if (type === 'in_person' && (!kind || !data.kinds.includes(kind))) {
    return empty('Coffee, lunch or dinner? Pick one below.');
  }
  const prepared = await engineInputFor(store, data.link, deps).catch(() => null);
  if (!prepared || !prepared.ok) {
    return empty('Open times cannot be shown right now. You can leave a message instead.');
  }
  const { slots, more } = chatSlots(prepared.value.input, query, data.visitorZone, request.page);
  const what =
    type === 'call' ? 'a 30-minute call' : `${KIND_LABEL[kind!].toLowerCase()} (1 hour, in person)`;
  return {
    action: 'times',
    query,
    slots,
    more,
    zoneLabel,
    reply: slots.length
      ? request.page > 0
        ? `More open times for ${what}.`
        : `Here are the next open times for ${what}. Pick one.`
      : request.page > 0
        ? 'There are no more open times right now.'
        : `There are no open times for ${what} right now. You can leave a message instead.`,
  };
}

/** The offers, as the routine is told them. */
function offersFor(data: ChatContextData): string[] {
  const facts = publicFactsFor(data);
  const out = ['30-min call (video)'];
  for (const kind of facts.inPersonKinds) out.push(`1-hour ${kind.toLowerCase()} in person`);
  if (facts.places.length) out.push(`In-person places: ${facts.places.join('; ')}`);
  if (facts.allowCustomPlace) out.push('Visitors may suggest a place of their own');
  out.push(
    facts.guestsAllowed
      ? `Visitors may add up to ${facts.maxGuests} guests by email`
      : 'Guests cannot be added on this page',
  );
  out.push('Booking from this page sends the calendar invitation straight away');
  out.push('Every booking confirmation has a link to reschedule or cancel');
  return out;
}

/** The facts block the routine gets: public card, written answers, offers, next calls. */
async function questionFacts(
  store: DataStore,
  data: ChatContextData,
  deps: BookingDeps,
): Promise<BookingQuestionFacts> {
  const prepared = await engineInputFor(store, data.link, deps).catch(() => null);
  const times =
    prepared && prepared.ok
      ? chatSlots(prepared.value.input, { type: 'call', kind: null }, data.visitorZone)
          .slots.slice(0, 6)
          .map((s) => `${s.label} (${zoneName(data.visitorZone, new Date(s.start))})`)
      : [];
  return buildQuestionFacts({
    hostName: data.hostName,
    firmName: data.link.config.firmName,
    title: data.link.config.title,
    bio: data.link.config.bio,
    faqItems: data.chatbot.faqItems,
    offers: offersFor(data),
    nextOpenTimes: times,
  });
}

function intentReply(intent: ChatIntent, data: ChatContextData): ChatIntent | null {
  if (intent.intent === 'in_person') {
    if (!data.inPerson) return { intent: 'call' };
    if (intent.kind && !data.kinds.includes(intent.kind))
      return { intent: 'in_person', kind: null };
  }
  return intent;
}

const NO_ANSWER: Record<AskUnavailable | 'no_match', string> = {
  no_match: 'I don’t have an answer for that one.',
  off: 'I don’t have an answer for that one.',
  not_set_up: 'I don’t have an answer for that one.',
  no_table: 'I don’t have an answer for that one.',
  fire_failed: 'I can’t look that up right now.',
  session_cap: 'I’ve looked up as many questions as I can for this visit.',
  address_cap: 'I’ve looked up as many questions as I can for you today.',
  daily_cap: 'I’ve looked up as many questions as I can today.',
};

async function askReply(
  store: DataStore,
  data: ChatContextData,
  request: Extract<ChatRequest, { action: 'ask' }>,
  context: ChatContext,
): Promise<ChatAnswer> {
  const question = cleanQuestion(request.question);
  const result = matchFaq(question, answerEntries(data));
  const suggestions = result.suggestions.map((m) => m.entry.q);
  const intent = detectIntent(question);
  const usable = intent ? intentReply(intent, data) : null;
  if (usable && !(result.best && result.best.score >= 0.9)) {
    const reply =
      usable.intent === 'message'
        ? 'Sure. Write your message below.'
        : usable.intent === 'call'
          ? 'Let’s find a time for a 30-minute call.'
          : usable.kind
            ? `Let’s find a time for ${KIND_LABEL[usable.kind].toLowerCase()}.`
            : 'Coffee, lunch or dinner? Pick one below.';
    return { action: 'ask', kind: 'intent', intent: usable, reply, suggestions: [] };
  }
  if (result.best) {
    return {
      action: 'ask',
      kind: 'answer',
      answer: result.best.entry.a,
      matched: result.best.entry.q,
      suggestions,
    };
  }
  const who = data.hostFirst || 'the host';
  const fallback = (reason: AskUnavailable | 'no_match'): ChatAnswer => ({
    action: 'ask',
    kind: 'none',
    reply: `${NO_ANSWER[reason]} You can leave it as a message for ${who}${suggestions.length ? ', or try one of these.' : '.'}`,
    suggestions,
    reason,
  });
  if (!data.chatbot.aiAnswers || !bookingChatConfigured()) return fallback('no_match');
  const asked = await askBookingRoutine(store, {
    organizationId: data.link.organizationId,
    chatbot: data.chatbot,
    question,
    sessionId: request.sessionId,
    ipHash: context.ipHash,
    facts: await questionFacts(store, data, context),
    now: context.now,
    fetchImpl: context.fetchImpl,
  });
  if (asked.kind === 'unavailable') return fallback(asked.reason);
  return {
    action: 'ask',
    kind: 'pending',
    questionId: asked.id,
    reply:
      'Arwin is looking into it - this can take a minute or two. You can keep booking meanwhile.',
    suggestions,
  };
}

export interface ChatContext extends BookingDeps {
  /** The visitor's address key (lib/security/client-address addressKey), for the brakes. */
  addressKey: string;
  /** A keyed hash of the visitor's address, for the per-address AI cap. */
  ipHash: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * One assistant request: the opening (offers, places, guests, chips), the
 * next open times, or a question. Never a booking: the widget books through
 * the public request route like the form.
 */
export async function runBookingChat(
  store: DataStore,
  slug: string,
  request: ChatRequest,
  context: ChatContext,
): Promise<Result<ChatReply>> {
  if (request.action === 'ask') {
    const limited = rateLimit(`booking-chat-ask:${context.addressKey}`, ASKS_PER_10_MIN, 600_000);
    if (!limited.ok) return limited;
  }
  const found = await contextFor(store, slug, request.timeZone);
  if (!found.ok) return found;
  const data = found.value;
  if (request.action === 'start') return ok(startReply(data));
  if (request.action === 'times') return ok(await timesReply(store, data, request, context));
  return ok(await askReply(store, data, request, context));
}

/** The widget's poll for a routine answer: where one question stands, or null. */
export async function readPublicAnswer(
  store: DataStore,
  slug: string,
  id: string,
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<Result<BookingAnswerView>> {
  const found = await resolveOpenLink(store, slug);
  if (!found.open || !readChatbotConfig(found.link.row.settings).enabled) {
    return err('forbidden', 'The assistant is not available on this page.');
  }
  const view = await readBookingAnswer(store, found.link.organizationId, id, {
    ...options,
    bookingUrl: bookingUrlFor(found.link.row.slug),
  });
  if (!view) return err('not_found', 'That question is not here any more.');
  return ok(view);
}

/**
 * The public page asks whether the assistant uses a live model. It never
 * does any more (D-078: no paid AI); kept so the page's data loader, which
 * still asks, gets the same answer every time without reading anything.
 */
export async function chatModeFor(
  _store: DataStore,
  _link: OpenLink,
  _options: { ai?: unknown; now?: Date; cacheMs?: number } = {},
): Promise<{ mode: 'guided'; reason: null }> {
  return { mode: 'guided', reason: null };
}

/* ------------------------------------------------------- the Booking tab */

export interface ChatbotPanelData {
  /** The booking tables exist. */
  available: boolean;
  /** The booking link has been saved once (the assistant's settings live in its row). */
  saved: boolean;
  config: ChatbotConfig;
  status: BookingChatStatus;
  /** The public card's facts, for the panel's "Test a question" box. */
  facts: PublicFacts;
}

const EMPTY_FACTS: PublicFacts = {
  hostName: '',
  hostFirst: '',
  title: '',
  bio: '',
  firmName: '',
  offersCall: true,
  inPersonKinds: [],
  places: [],
  allowCustomPlace: false,
  guestsAllowed: true,
  maxGuests: 5,
};

async function settingsRowOf(store: DataStore, organizationId: string) {
  try {
    return {
      available: true as const,
      row: await store.findOne('booking_settings', organizationId, {}),
    };
  } catch (error) {
    if (isMissingTableError(error)) return { available: false as const, row: null };
    throw error;
  }
}

/** What the Booking tab's assistant panel shows: the settings, the routine's state, the card. */
export async function readChatbotPanel(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<ChatbotPanelData> {
  const [found, status] = await Promise.all([
    settingsRowOf(store, organizationId),
    bookingChatStatus(store, organizationId, now),
  ]);
  if (!found.row) {
    return {
      available: found.available,
      saved: false,
      config: readChatbotConfig({}),
      status,
      facts: EMPTY_FACTS,
    };
  }
  const link: OpenLink = {
    organizationId,
    row: found.row,
    config: parseBookingConfig(found.row.settings),
  };
  const data = await contextOf(store, link, undefined);
  return {
    available: true,
    saved: true,
    config: data.chatbot,
    status,
    facts: publicFactsFor(data),
  };
}

/**
 * Save the assistant's settings from the Booking tab: the fields given,
 * merged onto what is stored, checked as a whole, and written into the
 * booking link's settings document as `chatbot` (and the old
 * `chatbotEnabled` switch, which earlier code still reads). Nothing else in
 * the document changes. Audited by counts only.
 */
export async function saveChatbotConfig(
  store: DataStore,
  organizationId: string,
  userId: string,
  patch: ChatbotConfigPatch,
  now: Date = new Date(),
): Promise<Result<ChatbotConfig>> {
  const input = CHATBOT_CONFIG_PATCH.safeParse(patch);
  if (!input.success) {
    const issue = input.error.issues[0];
    return err('invalid_input', issue?.message || 'Check the assistant settings.');
  }
  const found = await settingsRowOf(store, organizationId);
  if (!found.available) return err('not_configured', BOOKING_NOT_SET_UP);
  if (!found.row) {
    return err(
      'not_found',
      'Save the booking link once first, then the assistant’s answers can be saved.',
    );
  }
  const merged = CHATBOT_CONFIG_SCHEMA.safeParse({
    ...readChatbotConfig(found.row.settings),
    ...input.data,
  });
  if (!merged.success) {
    return err('invalid_input', merged.error.issues[0]?.message || 'Check the assistant settings.');
  }
  const next = merged.data;
  try {
    await store.update('booking_settings', organizationId, found.row.id, {
      settings: { ...found.row.settings, chatbot: next, chatbotEnabled: next.enabled },
      updated_by: userId,
      updated_at: now.toISOString(),
    });
  } catch (error) {
    if (isMissingTableError(error)) return err('not_configured', BOOKING_NOT_SET_UP);
    throw error;
  }
  await recordAudit(store, {
    organizationId,
    userId,
    action: 'booking.chatbot_updated',
    entityType: 'booking_settings',
    entityId: found.row.id,
    metadata: {
      enabled: next.enabled,
      answers: next.faqItems.length,
      ai_answers: next.aiAnswers,
      daily_ai_cap: next.dailyAiCap,
    },
  });
  return ok(next);
}
