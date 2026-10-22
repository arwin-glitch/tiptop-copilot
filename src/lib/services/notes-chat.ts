import 'server-only';
import { env } from '@/lib/config/env';
import { formatOffset } from '@/lib/notes/api';
import {
  pickExcerpts,
  rankTexts,
  resolveBridgeCitations,
  type RetrievalLine,
} from '@/lib/notes/chat-retrieval';
import { clip } from '@/lib/notes/draft';
import { noBackticks } from '@/lib/notes/bridge-protocol';
import { demoBridgeOn, readRelay } from '@/lib/notes/relay';
import { isTeamVisibleNote } from '@/lib/notes/visibility';
import { assemblySpeakers } from '@/lib/notes/voices';
import { recordAudit } from '@/lib/security/audit';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import type { ChatMessage, MeetingNote } from '@/lib/types/domain';
import type {
  ChatCitation,
  Meeting,
  MeetingParticipant,
  MeetingSpeaker,
  NotesChatRequest,
  NotesRequest,
  TranscriptSegment,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import type { AskBridgeContext } from './ask-bridge';
import { answerBridgeQuestion } from './ask-bridge';
import { parseAnswerMessage, queueBridgeQuestion, settleAnswersFromSlack } from './ask-routine';
import { allLinesOf, canSeeMeeting, guard, loadMeeting, type NotesContext } from './notes';

/**
 * Chat over meetings (D-076), at zero spend: a question about this meeting,
 * a person, a company or every meeting goes to Arwin's Claude routine as an
 * ordinary Ask question, with the material it needs in an optional `context`
 * (the routine cannot read the app): the meetings in scope, their notes, and
 * the transcript lines a small BM25 ranking picked for the question
 * (lib/notes/chat-retrieval.ts). The answer comes back like every Ask answer,
 * through the Slack relay, and its "[M1.152]" citations become "[12:31 Dana
 * Reyes]" links to the moment. It also shows in Ask Arwin's history.
 *
 * Without the Ask bridge (ASK_BRIDGE_TOKEN unset) the matching lines are
 * quoted at once instead. Never an in-app model call.
 */

const CHAT_MAX_MEETINGS = 12;
const NOTES_TEXT_MAX = 5_000;
const NOTE_EXCERPT = 1_500;
const GRANOLA_EXCERPT = 1_000;
const SEARCH_CANDIDATES = 300;
/** A chat request's line map is kept this long; the answer itself stays in Ask. */
const CHAT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface MeetingChatAnswer {
  status: 'answered' | 'pending';
  answer: string;
  citations: ChatCitation[];
  threadId: string | null;
  messageId: string | null;
}

const answered = (answer: string, citations: ChatCitation[] = []): MeetingChatAnswer => ({
  status: 'answered',
  answer,
  citations,
  threadId: null,
  messageId: null,
});

/* ============================================================ scope == */

function inScope(request: NotesChatRequest, email: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  if (request.scope === 'person') return e === request.personEmail?.toLowerCase();
  if (request.scope === 'company') return e.endsWith(`@${request.companyDomain?.toLowerCase()}`);
  return true;
}

/** The Copilot meetings a question covers, newest first, only the ones this person may see. */
async function meetingsInScope(
  ctx: NotesContext,
  meeting: Meeting,
  request: NotesChatRequest,
): Promise<Meeting[]> {
  if (request.scope === 'meeting') return [meeting];
  const org = ctx.auth.organizationId;
  const all = (
    (await ctx.store.list(
      'meetings',
      org,
      { isNull: ['deleted_at'] },
      { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 500 },
    )) as Meeting[]
  ).filter((m) => canSeeMeeting(m, ctx.auth.userId));
  if (request.scope === 'all') return all;
  const participants = (await ctx.store.list('meeting_participants', org, {
    in: { meeting_id: all.map((m) => m.id) },
    notNull: ['email'],
  })) as MeetingParticipant[];
  const ids = new Set(
    participants.filter((p) => inScope(request, p.email)).map((p) => p.meeting_id),
  );
  return all.filter((m) => ids.has(m.id));
}

/** Granola notes in a person, company or all-meetings scope (summaries, no transcript). */
async function granolaInScope(
  ctx: NotesContext,
  request: NotesChatRequest,
): Promise<MeetingNote[]> {
  if (request.scope === 'meeting') return [];
  const rows = (await ctx.store.list(
    'meeting_notes',
    ctx.auth.organizationId,
    { eq: { provider: 'granola' } },
    { orderBy: [{ field: 'occurred_at', direction: 'desc' }], limit: 300 },
  )) as MeetingNote[];
  return rows.filter(
    (n) =>
      isTeamVisibleNote(n, ctx.auth.userId) &&
      (request.scope === 'all' || n.attendees.some((a) => inScope(request, a.email))),
  );
}

/* ======================================================== fallback == */

/** The answer without the bridge: the lines that match, quoted and cited. */
async function retrievalAnswer(
  ctx: NotesContext,
  meetings: Meeting[],
  request: NotesChatRequest,
): Promise<MeetingChatAnswer> {
  const org = ctx.auth.organizationId;
  const where = request.scope === 'meeting' ? 'this meeting' : `${meetings.length} meetings`;
  const hits = meetings.length
    ? await ctx.store.search(
        'transcript_segments',
        org,
        request.question,
        ['text', 'edited_text'],
        { in: { meeting_id: meetings.map((m) => m.id) } },
        3,
      )
    : [];
  if (hits.length === 0) return answered(`I couldn't find anything about that in ${where}.`);
  const speakerRows = (await ctx.store.list('meeting_speakers', org, {
    in: { meeting_id: [...new Set(hits.map((h) => h.row.meeting_id))] },
  })) as MeetingSpeaker[];
  const name = (meetingKey: string, key: string) => {
    const row = speakerRows.find((s) => s.meeting_id === meetingKey && s.cluster_key === key);
    return row ? speakerDisplayName(row) : 'Guest';
  };
  const citations: ChatCitation[] = hits.map(({ row }) => {
    const speaker = name(row.meeting_id, row.cluster_key);
    return {
      meetingId: row.meeting_id,
      seq: row.seq,
      startMs: row.start_ms,
      speaker,
      label: `[${formatOffset(row.start_ms)} ${speaker}]`,
    };
  });
  const quotes = hits.map(
    ({ row }, i) => `${citations[i]?.label ?? ''} "${clip(row.edited_text ?? row.text, 300)}"`,
  );
  return answered(`Here's what I found in ${where}:\n${quotes.join('\n')}`, citations);
}

/* ========================================================= context == */

/**
 * What the routine is sent for a question: the meetings in scope as "M1:
 * Title (date)", their notes (and Granola's) ranked against the question,
 * and the transcript lines picked for it, with the map from each line id to
 * the moment it names.
 */
async function contextFor(
  ctx: NotesContext,
  meetings: Meeting[],
  granola: MeetingNote[],
  request: NotesChatRequest,
): Promise<{ context: AskBridgeContext; lineMap: NotesRequest['line_map'] }> {
  const org = ctx.auth.organizationId;
  const shown = meetings.slice(0, CHAT_MAX_MEETINGS);
  const ids = shown.map((m) => m.id);
  const [speakerRows, notes] = await Promise.all([
    ids.length
      ? (ctx.store.list('meeting_speakers', org, { in: { meeting_id: ids } }) as Promise<
          MeetingSpeaker[]
        >)
      : Promise.resolve([] as MeetingSpeaker[]),
    ids.length
      ? (ctx.store.list('meeting_notes', org, {
          eq: { provider: 'copilot' },
          in: { external_id: ids },
        }) as Promise<MeetingNote[]>)
      : Promise.resolve([] as MeetingNote[]),
  ]);

  let lines: TranscriptSegment[] = [];
  if (request.scope === 'meeting' && shown[0]) {
    lines = await allLinesOf(ctx, shown[0].id, { finalOnly: true });
  } else if (ids.length) {
    // Candidates by the store's own text search, ranked again below.
    const hits = await ctx.store.search(
      'transcript_segments',
      org,
      request.question,
      ['text', 'edited_text'],
      { in: { meeting_id: ids } },
      SEARCH_CANDIDATES,
    );
    lines = hits.map((h) => h.row);
  }

  const index = new Map(shown.map((m, i) => [m.id, i + 1]));
  const names = new Map<string, Map<string, string>>();
  for (const m of shown) {
    const own = speakerRows.filter((s) => s.meeting_id === m.id);
    const voices = assemblySpeakers(own, m, { principalId: null, principalEmail: null });
    names.set(m.id, new Map([...voices].map(([k, s]) => [k, s.name])));
  }
  const candidates: RetrievalLine[] = lines
    .filter((l) => index.has(l.meeting_id))
    .map((l) => ({
      meetingId: l.meeting_id,
      meetingIndex: index.get(l.meeting_id) as number,
      seq: l.seq,
      speaker: names.get(l.meeting_id)?.get(l.cluster_key) ?? 'Guest',
      startMs: l.start_ms,
      text: l.edited_text ?? l.text,
    }))
    .sort((a, b) => a.meetingIndex - b.meetingIndex || a.seq - b.seq);
  const picked = pickExcerpts(candidates, request.question, {
    fillEvenly: request.scope === 'meeting',
  });

  const dateOf = (m: Meeting) => (m.started_at ?? m.scheduled_start ?? m.created_at).slice(0, 10);
  const titles = shown.map((m, i) => `M${i + 1}: ${noBackticks(m.title)} (${dateOf(m)})`);
  const noteTexts = rankTexts(
    [
      ...shown.flatMap((m, i) => {
        const note = notes.find((n) => n.external_id === m.id);
        return note?.content?.trim()
          ? [{ text: `M${i + 1} notes: ${clip(note.content, NOTE_EXCERPT)}` }]
          : [];
      }),
      ...granola.slice(0, 20).map((n) => ({
        text: `Granola notes, ${noBackticks(n.title)} (${n.occurred_at.slice(0, 10)}): ${clip(
          n.content,
          GRANOLA_EXCERPT,
        )}`,
      })),
    ],
    request.question,
  );
  let notesText = '';
  for (const { text } of noteTexts) {
    const next = notesText ? `${notesText}\n\n${text}` : text;
    if (next.length > NOTES_TEXT_MAX) break;
    notesText = next;
  }
  for (const n of granola.slice(0, 10)) {
    titles.push(`Granola: ${noBackticks(n.title)} (${n.occurred_at.slice(0, 10)})`);
  }
  return {
    context: {
      scope: request.scope,
      meeting_titles: titles.slice(0, 25),
      notes_text: noBackticks(notesText),
      excerpts: picked.excerpts,
    },
    lineMap: picked.lineMap,
  };
}

/* ============================================================= ask == */

/**
 * Ask about this meeting, a person, a company or every meeting, as Arwin.
 * With the Ask bridge, the answer is on its way ('pending', with the Ask
 * message to poll); without it, the matching lines are quoted at once.
 */
export async function askAboutMeetings(
  ctx: NotesContext,
  meetingId: string,
  request: NotesChatRequest,
  fetchImpl?: typeof fetch,
): Promise<Result<MeetingChatAnswer>> {
  return guard<MeetingChatAnswer>('answer that', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const [meetings, granola] = await Promise.all([
      meetingsInScope(ctx, found.value, request),
      granolaInScope(ctx, request),
    ]);
    const org = ctx.auth.organizationId;
    const viaBridge = Boolean(env().askBridgeToken) || demoBridgeOn();
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.chat_asked',
      entityType: 'meeting',
      entityId: meetingId,
      metadata: {
        scope: request.scope,
        meetings: meetings.length,
        granola: granola.length,
        via: viaBridge ? 'ask_bridge' : 'quotes',
      },
    });
    if (meetings.length === 0 && granola.length === 0) {
      return ok(answered(`I couldn't find any meetings to look through for that.`));
    }
    if (!viaBridge) return ok(await retrievalAnswer(ctx, meetings, request));

    const { context, lineMap } = await contextFor(ctx, meetings, granola, request);
    const queued = await queueBridgeQuestion(
      ctx.store,
      { organizationId: org, userId: ctx.auth.userId },
      { question: request.question, threadId: request.threadId ?? null, context },
      { force: demoBridgeOn(), fetchImpl },
    );
    if (!queued.ok) return queued;
    const now = ctx.now ?? new Date();
    const at = now.toISOString();
    const row: NotesRequest = {
      id: newId(),
      organization_id: org,
      meeting_id: found.value.id,
      kind: 'chat',
      status: 'pending',
      reason: null,
      message_id: queued.value.assistantMessage.id,
      thread_id: queued.value.thread.id,
      template_id: null,
      meeting_day: null,
      requested_by: ctx.auth.userId,
      fired_at: queued.value.fired ? at : null,
      fire_attempts: 1,
      last_fire_at: at,
      line_map: lineMap,
      parts: {},
      payload_chars: JSON.stringify(context).length,
      omitted_lines: 0,
      error: null,
      completed_at: null,
      expires_at: new Date(now.getTime() + CHAT_REQUEST_TTL_MS).toISOString(),
      created_at: at,
      updated_at: at,
    };
    await ctx.store.insert('notes_requests', row);
    return ok({
      status: 'pending',
      answer: '',
      citations: [],
      threadId: queued.value.thread.id,
      messageId: queued.value.assistantMessage.id,
    });
  });
}

/**
 * Demo mode's stand-in for the relay: ASK_ANSWER_V1 posts to the demo
 * channel complete the waiting meeting-chat answers they name.
 */
async function settleDemoAnswers(ctx: NotesContext, waiting: string): Promise<void> {
  const messages = await readRelay({ channel: env().askRelayChannelId });
  for (const message of messages ?? []) {
    const answer = parseAnswerMessage(message.text);
    if (answer?.message_id === waiting) {
      await answerBridgeQuestion(
        ctx.store,
        ctx.auth.organizationId,
        answer.message_id,
        answer.answer,
      );
      return;
    }
  }
}

/**
 * A meeting-chat answer on its way: looked for in the relay (throttled, as
 * the Ask page does), and once it is there, its citations turned into links.
 * The stored answer is rewritten with those labels, so Ask Arwin shows
 * "[12:31 Dana Reyes]" too. Only the person who asked reads it here.
 */
export async function readMeetingChatAnswer(
  ctx: NotesContext,
  meetingId: string,
  messageId: string,
  fetchImpl?: typeof fetch,
): Promise<Result<MeetingChatAnswer>> {
  return guard<MeetingChatAnswer>('read the answer', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const org = ctx.auth.organizationId;
    const request = (await ctx.store.findOne('notes_requests', org, {
      eq: { kind: 'chat', meeting_id: meetingId, message_id: messageId },
    })) as NotesRequest | null;
    if (!request || request.requested_by !== ctx.auth.userId) {
      return err('not_found', 'That answer was not found.');
    }
    let message = (await ctx.store.get('chat_messages', org, messageId)) as ChatMessage | null;
    if (!message) return err('not_found', 'That answer was not found.');
    if (message.status === 'pending') {
      if (env().askRelaySlackToken) await settleAnswersFromSlack(ctx.store, org, fetchImpl);
      else if (env().demoMode) await settleDemoAnswers(ctx, messageId);
      message = (await ctx.store.get('chat_messages', org, messageId)) as ChatMessage | null;
      if (!message) return err('not_found', 'That answer was not found.');
    }
    const base = { threadId: request.thread_id, messageId };
    if (message.status === 'pending') {
      return ok({ status: 'pending', answer: '', citations: [], ...base });
    }
    const resolved = resolveBridgeCitations(message.content, request.line_map);
    if (resolved.answer !== message.content) {
      await ctx.store.update('chat_messages', org, messageId, { content: resolved.answer });
    }
    if (request.status === 'pending') {
      await ctx.store.update('notes_requests', org, request.id, {
        status: 'ready',
        completed_at: (ctx.now ?? new Date()).toISOString(),
      });
    }
    return ok({
      status: 'answered',
      answer: resolved.answer,
      citations: resolved.citations,
      ...base,
    });
  });
}
