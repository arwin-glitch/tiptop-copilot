import 'server-only';
import { env } from '@/lib/config/env';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import {
  ARWIN_NOTES_MODEL,
  NOTES_ROUTINE_VERSION,
  assembleRoutineNotes,
  buildNotesRequest,
  collectParts,
  mergeFragments,
  parseNotesResultMessage,
  readStoredParts,
  type NotesResultPart,
  type RoutineSpeaker,
  type StoredParts,
} from '@/lib/notes/bridge-protocol';
import { notesAsText } from '@/lib/notes/draft';
import { readRelay, relayReadable } from '@/lib/notes/relay';
import { assemblySpeakers } from '@/lib/notes/voices';
import { recordAudit } from '@/lib/security/audit';
import { scanForInjection } from '@/lib/security/injection';
import { log } from '@/lib/security/redact';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import type { MeetingNote, Task } from '@/lib/types/domain';
import {
  isBuiltinTemplateId,
  type ActionItem,
  type Meeting,
  type MeetingParticipant,
  type MeetingSpeaker,
  type NotesRequest,
  type NotesRequestReason,
  type TranscriptSegment,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { DEFAULT_TIMEZONE, localDateKey } from '@/lib/util/time';
import { directCallConfigured, fireRoutineText } from './ask-routine';
import { readTeamInfo, type TeamInfo } from './notes-context';
import { fireMeetingFollowUp } from './notes-followup';
import { templateViewFor, type NotesContext } from './notes';
import { ingestTasks, normalizeTitle } from './task-ingest';

/**
 * Arwin's notes (D-076, zero spend). Copilot never calls a paid model for a
 * meeting's notes: it hands the meeting to Arwin's Claude routine through the
 * Ask bridge and reads the notes back from the Slack relay.
 *
 *   Stop / Regenerate / another template
 *     → requestArwinNotes: a notes_requests row (pending) and the routine
 *       fired with NOTES_REQUEST_V1 (lib/notes/bridge-protocol.ts). The Quick
 *       notes (rules only) are already on the page meanwhile.
 *   the meeting page's poll, the daily job
 *     → settleNotesFromRelay: NOTES_RESULT_V1 parts read from the relay,
 *       put together, checked, stored as the notes; action items filed as
 *       tasks through the tasks service, once; the follow-up routine fired.
 *
 * A trigger that is missing or fails leaves the request pending (and a later
 * poll by someone who can see the meeting fires it again, with a back-off);
 * nothing posts the request to Slack, because the app has no posting path
 * there. A request with no answer within a day expires, and the Quick notes
 * stay.
 */

/** A request with no answer by then expires. */
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** Fire attempts for one request, the first included. */
const MAX_FIRE_ATTEMPTS = 6;
const MIN_SETTLE_INTERVAL_MS = 3_000;
/** Relay messages are read from a little before the oldest waiting request. */
const RELAY_LOOKBACK_MS = 2 * 60 * 1000;
const TASK_SOURCE = 'copilot-notes';

export type BridgeStore = { store: DataStore; organizationId: string; now?: Date };

const nowOf = (ctx: { now?: Date }) => ctx.now ?? new Date();

/* ============================================================ request == */

function roleOf(
  participant: MeetingParticipant,
  team: TeamInfo,
): 'principal' | 'recorder' | 'team' | 'organizer' | 'guest' {
  const email = participant.email?.toLowerCase() ?? null;
  if (email && team.principalEmail === email) return 'principal';
  if (participant.role === 'self') return 'recorder';
  if (email && (team.emails.has(email) || team.domains.has(email.split('@')[1] ?? ''))) {
    return 'team';
  }
  return participant.role === 'organizer' ? 'organizer' : 'guest';
}

interface RequestMaterial {
  meeting: Meeting;
  lines: TranscriptSegment[];
  speakers: MeetingSpeaker[];
  participants: MeetingParticipant[];
  team: TeamInfo;
  typedNotes: string | null;
}

async function materialFor(ctx: BridgeStore, meeting: Meeting): Promise<RequestMaterial> {
  const org = ctx.organizationId;
  const [lines, speakers, participants, team, note] = await Promise.all([
    listAllPages(
      ctx.store,
      'transcript_segments',
      org,
      { eq: { meeting_id: meeting.id, is_final: true } },
      [{ field: 'seq', direction: 'asc' }],
    ) as Promise<TranscriptSegment[]>,
    ctx.store.list('meeting_speakers', org, { eq: { meeting_id: meeting.id } }) as Promise<
      MeetingSpeaker[]
    >,
    ctx.store.list(
      'meeting_participants',
      org,
      { eq: { meeting_id: meeting.id } },
      { orderBy: [{ field: 'created_at', direction: 'asc' }] },
    ) as Promise<MeetingParticipant[]>,
    readTeamInfo(ctx.store, org),
    ctx.store.findOne('meeting_notes', org, {
      eq: { provider: 'copilot', external_id: meeting.id },
    }) as Promise<MeetingNote | null>,
  ]);
  return { meeting, lines, speakers, participants, team, typedNotes: note?.user_notes ?? null };
}

/** The NOTES_REQUEST_V1 text for a meeting, and the line ids in it. */
async function buildFor(
  ctx: NotesContext,
  material: RequestMaterial,
  requestId: string,
  templateId: string | null,
) {
  const { meeting, team } = material;
  const voices = assemblySpeakers(material.speakers, meeting, team);
  const name = (key: string) => voices.get(key)?.name ?? 'Guest';
  const timeZone = ctx.auth.profile.timezone || DEFAULT_TIMEZONE;
  const template = await templateViewFor(ctx, templateId);
  let instructions = '';
  if (template) {
    instructions = `${template.purpose} Length: ${template.length}.`;
    if (!isBuiltinTemplateId(template.id)) {
      const row = await ctx.store.get('note_templates', ctx.auth.organizationId, template.id);
      if (row?.prompt?.trim()) instructions = `${instructions} ${row.prompt.trim()}`;
    }
  }
  const attendees = material.participants
    .filter((p) => p.name || p.email)
    .map((p) => ({
      name: p.name ?? (p.email ?? '').split('@')[0] ?? 'Guest',
      role: roleOf(p, team),
    }));
  const principal = team.members.find((m) => m.userId === team.principalId);
  if (principal?.fullName && !attendees.some((a) => a.role === 'principal')) {
    attendees.push({ name: principal.fullName, role: 'principal' });
  }
  return buildNotesRequest(
    {
      requestId,
      meetingId: meeting.id,
      title: meeting.title,
      when: meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at,
      timezone: timeZone,
      attendees,
      template: template
        ? { name: template.name, sections: template.sections, instructions }
        : null,
      typedNotes: material.typedNotes,
      lines: material.lines.map((l) => ({
        seq: l.seq,
        speaker: name(l.cluster_key),
        startMs: l.start_ms,
        text: l.edited_text ?? l.text,
      })),
      relayChannel: env().notesRelayChannelId,
    },
    env().notesFireMaxChars,
  );
}

/** Demo mode never calls the trigger: the e2e tests play the routine through the demo relay. */
async function fire(text: string, fetchImpl?: typeof fetch): Promise<boolean> {
  if (env().demoMode) return false;
  return fireRoutineText(text, fetchImpl);
}

/**
 * Ask Arwin's routine for a meeting's notes. Earlier requests still waiting
 * are replaced (their answers, if they come, are ignored). Null when there is
 * nothing to write from: no transcript line and no typed note.
 */
export async function requestArwinNotes(
  ctx: NotesContext,
  meeting: Meeting,
  reason: NotesRequestReason,
  fetchImpl?: typeof fetch,
): Promise<NotesRequest | null> {
  const org = ctx.auth.organizationId;
  const now = nowOf(ctx);
  const bridge: BridgeStore = { store: ctx.store, organizationId: org, now };
  const material = await materialFor(bridge, meeting);
  if (material.lines.length === 0 && !material.typedNotes?.trim()) return null;

  const waiting = (await ctx.store.list('notes_requests', org, {
    eq: { meeting_id: meeting.id, kind: 'notes', status: 'pending' },
  })) as NotesRequest[];
  for (const old of waiting) {
    await ctx.store.update('notes_requests', org, old.id, {
      status: 'expired',
      error: 'Replaced by a newer request.',
      parts: {},
    });
  }

  const id = newId();
  const built = await buildFor(ctx, material, id, meeting.template_id);
  const timeZone = ctx.auth.profile.timezone || DEFAULT_TIMEZONE;
  const startedAt = new Date(meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at);
  const at = now.toISOString();
  const row: NotesRequest = {
    id,
    organization_id: org,
    meeting_id: meeting.id,
    kind: 'notes',
    status: 'pending',
    reason,
    message_id: null,
    thread_id: null,
    template_id: meeting.template_id,
    meeting_day: localDateKey(startedAt, timeZone),
    requested_by: ctx.auth.userId,
    fired_at: null,
    fire_attempts: 0,
    last_fire_at: null,
    line_map: built.lineMap,
    parts: {},
    payload_chars: built.text.length,
    omitted_lines: built.omitted,
    error: null,
    completed_at: null,
    expires_at: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
    created_at: at,
    updated_at: at,
  };
  await ctx.store.insert('notes_requests', row);
  const fired = await fire(built.text, fetchImpl);
  const saved = await ctx.store.update('notes_requests', org, id, {
    fire_attempts: 1,
    last_fire_at: at,
    fired_at: fired ? at : null,
  });
  await recordAudit(ctx.store, {
    organizationId: org,
    userId: ctx.auth.userId,
    action: 'notes.requested',
    entityType: 'meeting',
    entityId: meeting.id,
    metadata: {
      request_id: id,
      reason,
      lines_sent: built.sent,
      lines_omitted: built.omitted,
      chars: built.text.length,
      fired,
    },
  });
  return saved;
}

/** Minutes to wait before firing again after `attempts` tries: 1, 2, 4, 8, 16. */
const backoffMs = (attempts: number) => Math.min(16, 2 ** Math.max(0, attempts - 1)) * 60_000;

/**
 * Fire again the waiting requests whose trigger failed, for meetings this
 * person can see, after a back-off. Rebuilt from the meeting as it is now.
 */
async function refireWaiting(
  ctx: NotesContext,
  waiting: readonly NotesRequest[],
  fetchImpl?: typeof fetch,
): Promise<number> {
  if (!directCallConfigured() || env().demoMode) return 0;
  const now = nowOf(ctx);
  let fired = 0;
  for (const request of waiting) {
    if (request.fired_at || request.fire_attempts >= MAX_FIRE_ATTEMPTS) continue;
    const last = request.last_fire_at ? Date.parse(request.last_fire_at) : 0;
    if (now.getTime() - last < backoffMs(request.fire_attempts)) continue;
    const meeting = await ctx.store.get('meetings', ctx.auth.organizationId, request.meeting_id);
    if (!meeting || meeting.deleted_at) continue;
    const visible =
      meeting.visibility === 'team' ||
      meeting.recorded_by === ctx.auth.userId ||
      (meeting.shared_with ?? []).includes(ctx.auth.userId);
    if (!visible) continue;
    const material = await materialFor(
      { store: ctx.store, organizationId: ctx.auth.organizationId, now },
      meeting,
    );
    const built = await buildFor(ctx, material, request.id, request.template_id);
    const ok = await fire(built.text, fetchImpl);
    const at = now.toISOString();
    await ctx.store.update('notes_requests', ctx.auth.organizationId, request.id, {
      fire_attempts: request.fire_attempts + 1,
      last_fire_at: at,
      fired_at: ok ? at : null,
      line_map: built.lineMap,
      payload_chars: built.text.length,
      omitted_lines: built.omitted,
    });
    if (ok) {
      fired += 1;
      await recordAudit(ctx.store, {
        organizationId: ctx.auth.organizationId,
        userId: ctx.auth.userId,
        action: 'notes.request_fired',
        entityType: 'meeting',
        entityId: meeting.id,
        metadata: { request_id: request.id, attempt: request.fire_attempts + 1 },
      });
    }
  }
  return fired;
}

/* ============================================================= settle == */

export interface SettleOutcome {
  /** Requests whose notes were stored. */
  settled: number;
  /** Requests the routine said it could not do. */
  failed: number;
  expired: number;
  refired: number;
}

const NONE: SettleOutcome = { settled: 0, failed: 0, expired: 0, refired: 0 };

const settleState = processWide('notes-bridge-settle', () => ({
  last: new Map<string, number>(),
  inFlight: new Map<string, Promise<SettleOutcome>>(),
}));

/** Test hook: the throttle is process-wide. */
export function resetNotesSettleThrottle(): void {
  settleState.last.clear();
  settleState.inFlight.clear();
}

/**
 * Look for Arwin's notes in the relay and store the ones that came back;
 * expire what waited too long; with a signed-in `ctx`, fire again what never
 * started. Throttled per organization (pages poll every few seconds) unless
 * `force`. Never throws; a migration not yet applied reads as nothing to do.
 */
export async function settleNotesFromRelay(
  store: DataStore,
  organizationId: string,
  options: { ctx?: NotesContext; fetchImpl?: typeof fetch; now?: Date; force?: boolean } = {},
): Promise<SettleOutcome> {
  const running = settleState.inFlight.get(organizationId);
  if (running) return running;
  const now = options.now ?? new Date();
  const last = settleState.last.get(organizationId) ?? 0;
  if (!options.force && now.getTime() - last < MIN_SETTLE_INTERVAL_MS) return NONE;

  const job = (async (): Promise<SettleOutcome> => {
    try {
      return await settleOnce({ store, organizationId, now }, options);
    } catch (error) {
      if (!isMissingTableError(error) && !isMissingColumnError(error)) {
        log.warn('Copilot Notes: settling notes from the relay failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
      return NONE;
    } finally {
      settleState.last.set(organizationId, Date.now());
      settleState.inFlight.delete(organizationId);
    }
  })();
  settleState.inFlight.set(organizationId, job);
  return job;
}

async function settleOnce(
  ctx: Required<BridgeStore>,
  options: { ctx?: NotesContext; fetchImpl?: typeof fetch },
): Promise<SettleOutcome> {
  const outcome: SettleOutcome = { ...NONE };
  const pending = (await ctx.store.list(
    'notes_requests',
    ctx.organizationId,
    { eq: { kind: 'notes', status: 'pending' } },
    { orderBy: [{ field: 'created_at', direction: 'asc' }] },
  )) as NotesRequest[];
  if (pending.length === 0) return outcome;

  const waiting: NotesRequest[] = [];
  for (const request of pending) {
    if (Date.parse(request.expires_at) <= ctx.now.getTime()) {
      await expire(ctx, request, 'No notes came back within a day.');
      outcome.expired += 1;
    } else waiting.push(request);
  }
  if (waiting.length === 0) return outcome;
  if (options.ctx) outcome.refired = await refireWaiting(options.ctx, waiting, options.fetchImpl);
  if (!relayReadable()) return outcome;

  const oldest = Math.min(...waiting.map((r) => Date.parse(r.created_at))) - RELAY_LOOKBACK_MS;
  const messages = await readRelay(
    { channel: env().notesRelayChannelId, oldest: Math.max(0, oldest) / 1000 },
    options.fetchImpl,
  );
  if (!messages) return outcome;

  const byRequest = new Map<string, NotesResultPart[]>();
  const ids = new Set(waiting.map((r) => r.id));
  // Oldest first, so a part posted twice keeps its first copy.
  for (const message of [...messages].reverse()) {
    const part = parseNotesResultMessage(message.text);
    if (!part || !ids.has(part.request_id)) continue;
    byRequest.set(part.request_id, [...(byRequest.get(part.request_id) ?? []), part]);
  }
  for (const request of waiting) {
    const incoming = byRequest.get(request.id);
    if (!incoming?.length) continue;
    const { parts, complete } = collectParts(readStoredParts(request.parts), incoming);
    if (!complete) {
      await ctx.store.update('notes_requests', ctx.organizationId, request.id, {
        parts: parts as unknown as Record<string, unknown>,
      });
      continue;
    }
    const applied = await applyResult(ctx, request, parts);
    if (applied === 'ready') outcome.settled += 1;
    else if (applied === 'failed') outcome.failed += 1;
  }
  return outcome;
}

async function expire(ctx: Required<BridgeStore>, request: NotesRequest, why: string) {
  await ctx.store.update('notes_requests', ctx.organizationId, request.id, {
    status: 'expired',
    error: why,
    parts: {},
    completed_at: ctx.now.toISOString(),
  });
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: null,
    action: 'notes.request_expired',
    entityType: 'meeting',
    entityId: request.meeting_id,
    metadata: { request_id: request.id, fired: Boolean(request.fired_at) },
  });
}

async function fail(ctx: Required<BridgeStore>, request: NotesRequest, why: string) {
  await ctx.store.update('notes_requests', ctx.organizationId, request.id, {
    status: 'failed',
    error: why.slice(0, 300),
    parts: {},
    completed_at: ctx.now.toISOString(),
  });
  await recordAudit(ctx.store, {
    organizationId: ctx.organizationId,
    userId: null,
    action: 'notes.request_failed',
    entityType: 'meeting',
    entityId: request.meeting_id,
    metadata: { request_id: request.id },
  });
}

/** A task's title and words for an action item: the principal's own promise reads as theirs. */
function taskFor(item: ActionItem, meeting: Meeting, day: string | null) {
  const owner = item.ownerName?.trim();
  const title = (item.isPrincipalPromise || !owner ? item.text : `${owner}: ${item.text}`).slice(
    0,
    300,
  );
  const when = day ? ` on ${day}` : '';
  const whose = item.isPrincipalPromise
    ? ' Your promise.'
    : owner
      ? ` ${owner} said they would do this.`
      : '';
  return {
    title,
    detail: `From the meeting "${meeting.title}"${when}.${whose}`.slice(0, 2_000),
    due_at: item.due,
  };
}

/**
 * File the action items as tasks, through the tasks service (add-only, to the
 * principal, a title already known is never added twice), and return the
 * items with the task each now has. Items that already had one keep it.
 */
async function fileTasks(
  ctx: Required<BridgeStore>,
  meeting: Meeting,
  items: readonly ActionItem[],
  day: string | null,
): Promise<{ items: ActionItem[]; created: number }> {
  const open = items.filter((a) => !a.taskId);
  if (open.length === 0) return { items: [...items], created: 0 };
  const wanted = open.map((a) => ({ item: a, task: taskFor(a, meeting, day) }));
  let created = 0;
  for (let i = 0; i < wanted.length; i += 20) {
    const slice = wanted.slice(i, i + 20);
    const result = await ingestTasks(ctx.store, ctx.organizationId, {
      source: TASK_SOURCE,
      tasks: slice.map((w) => ({
        title: w.task.title,
        detail: w.task.detail,
        due_at: w.task.due_at,
      })),
    });
    created += result.created.length;
  }
  const tasks = (await listAllPages(ctx.store, 'tasks', ctx.organizationId)) as Task[];
  const byTitle = new Map<string, string>();
  for (const t of [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    byTitle.set(normalizeTitle(t.title), t.id);
  }
  const ids = new Map(wanted.map((w) => [w.item.id, byTitle.get(normalizeTitle(w.task.title))]));
  return {
    items: items.map((a) => (a.taskId ? a : { ...a, taskId: ids.get(a.id) ?? null })),
    created,
  };
}

/** Store a complete result as the meeting's notes, or fail the request saying why. */
async function applyResult(
  ctx: Required<BridgeStore>,
  request: NotesRequest,
  parts: StoredParts,
): Promise<'ready' | 'failed' | 'skipped'> {
  const org = ctx.organizationId;
  // Read again: another poll may have stored it a moment ago.
  const fresh = (await ctx.store.get('notes_requests', org, request.id)) as NotesRequest | null;
  if (!fresh || fresh.status !== 'pending') return 'skipped';
  const meeting = await ctx.store.get('meetings', org, request.meeting_id);
  if (!meeting || meeting.deleted_at) {
    await fail(ctx, request, 'The meeting is no longer there.');
    return 'failed';
  }
  if (parts.error) {
    await fail(ctx, request, `Arwin could not write these notes: ${parts.error}`);
    return 'failed';
  }
  const material = await materialFor(ctx, meeting);
  const voices = assemblySpeakers(material.speakers, meeting, material.team);
  const speakers: RoutineSpeaker[] = material.speakers
    .filter((s) => !s.merged_into)
    .map((s) => ({
      clusterKey: s.cluster_key,
      name: voices.get(s.cluster_key)?.name ?? speakerDisplayName(s),
      email: voices.get(s.cluster_key)?.email ?? s.person_email,
      isPrincipal: Boolean(voices.get(s.cluster_key)?.isPrincipal),
    }));
  const principal = material.team.members.find((m) => m.userId === material.team.principalId);
  const note = (await ctx.store.findOne('meeting_notes', org, {
    eq: { provider: 'copilot', external_id: meeting.id },
  })) as MeetingNote | null;
  const day = fresh.meeting_day ?? localDateKey(new Date(meeting.created_at), DEFAULT_TIMEZONE);
  const assembled = assembleRoutineNotes({
    notes: mergeFragments(parts),
    lineMap: fresh.line_map,
    typedNotes: material.typedNotes,
    speakers,
    principalName: principal?.fullName ?? null,
    meetingDay: day,
    previous: note?.action_items ?? [],
  });
  if (assembled.points === 0 && assembled.actionItems.length === 0) {
    await fail(ctx, request, 'The notes came back empty.');
    return 'failed';
  }
  const filed = await fileTasks(ctx, meeting, assembled.actionItems, fresh.meeting_day);
  const content = notesAsText(assembled.blocks, filed.items);
  const flagged = meeting.injection_flagged || scanForInjection(content).flagged;
  const at = ctx.now.toISOString();
  const patch: Partial<MeetingNote> = {
    content: content || '(No notes yet.)',
    enhanced_blocks: assembled.blocks,
    action_items: filed.items,
    template_id: fresh.template_id,
    prompt_version: NOTES_ROUTINE_VERSION,
    model: ARWIN_NOTES_MODEL,
    generated_at: at,
    notes_request_id: fresh.id,
    injection_flagged: Boolean(note?.injection_flagged) || flagged,
  };
  if (note) {
    await ctx.store.update('meeting_notes', org, note.id, { ...patch, updated_at: at });
  } else {
    await ctx.store.insert('meeting_notes', {
      id: newId(),
      organization_id: org,
      provider: 'copilot',
      external_id: meeting.id,
      title: meeting.title,
      occurred_at: meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at,
      attendees: material.participants
        .filter((p): p is MeetingParticipant & { email: string } => Boolean(p.email))
        .map((p) => ({ name: p.name, email: p.email })),
      content: patch.content ?? '',
      source_url: null,
      injection_flagged: Boolean(patch.injection_flagged),
      meeting_id: meeting.id,
      user_notes: null,
      edited_at: null,
      visibility: meeting.visibility,
      owner_id: meeting.recorded_by,
      created_at: at,
      updated_at: at,
      ...patch,
    } as MeetingNote);
  }
  await ctx.store.update('notes_requests', org, fresh.id, {
    status: 'ready',
    parts: {},
    error: null,
    completed_at: at,
  });
  if (meeting.status === 'processing' || meeting.status === 'failed') {
    await ctx.store.update('meetings', org, meeting.id, { status: 'ready' });
  }
  if (flagged && !meeting.injection_flagged) {
    await ctx.store.update('meetings', org, meeting.id, { injection_flagged: true });
  }
  await recordAudit(ctx.store, {
    organizationId: org,
    userId: null,
    action: 'notes.result_applied',
    entityType: 'meeting',
    entityId: meeting.id,
    metadata: {
      request_id: fresh.id,
      points: assembled.points,
      action_items: filed.items.length,
      tasks_created: filed.created,
      unknown_ids: assembled.unknownIds,
      parts: parts.of,
    },
  });
  try {
    await fireMeetingFollowUp(
      { store: ctx.store, auth: { organizationId: org, userId: fresh.requested_by } },
      meeting,
    );
  } catch (error) {
    log.warn('Copilot Notes: the follow-up routine could not be started', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  return 'ready';
}

/** Pending chat or notes requests count as "waiting" for a meeting page's poll. */
export async function meetingHasPendingRequest(
  store: DataStore,
  organizationId: string,
  meetingId: string,
): Promise<boolean> {
  try {
    const found = await store.findOne('notes_requests', organizationId, {
      eq: { meeting_id: meetingId, kind: 'notes', status: 'pending' },
    });
    return Boolean(found);
  } catch (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return false;
    throw error;
  }
}
