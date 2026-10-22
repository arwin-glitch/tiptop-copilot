import 'server-only';
import { env } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { AuditEvent } from '@/lib/types/domain';
import type { Meeting } from '@/lib/types/notes';

/**
 * Start the meeting-follow-up routine the moment Arwin's notes for a meeting
 * are stored (D-076), instead of waiting for its two-hourly schedule. The app POSTs the
 * routine's /fire address (MEETING_FOLLOWUP_FIRE_URL, with its token) the
 * way the Ask routine is fired (ask-routine.ts): the text names the meeting
 * and nothing else, and the routine reads the notes through Copilot's MCP
 * tools, so no content leaves here.
 *
 * Only a meeting the team can see is announced (the routine could not read a
 * private one anyway), once per meeting: regenerating the notes does not
 * fire it again. Never in demo mode, and never without both settings: the
 * routine's own schedule stays the backstop.
 */

export const FOLLOWUP_FIRED_ACTION = 'notes.followup_fired';
const FIRE_TIMEOUT_MS = 8_000;

/** What the routine is told: the meeting's id, nothing else. */
export function followUpFireText(meetingId: string): string {
  return `copilot_meeting_id=${meetingId}`;
}

export type FireOutcome = 'fired' | 'not_set_up' | 'private' | 'already' | 'failed';

/** What firing needs: the store and the organization (a signed-in person, or the daily job). */
export interface FollowUpContext {
  store: DataStore;
  auth: { organizationId: string; userId: string | null };
}

export async function fireMeetingFollowUp(
  ctx: FollowUpContext,
  meeting: Meeting,
  fetchImpl: typeof fetch = fetch,
): Promise<FireOutcome> {
  const e = env();
  if (e.demoMode || !e.meetingFollowupFireUrl || !e.meetingFollowupFireToken) return 'not_set_up';
  if (meeting.visibility !== 'team' || meeting.deleted_at) return 'private';
  const org = ctx.auth.organizationId;
  if (meeting.folder_id) {
    const folder = await ctx.store.get('meeting_folders', org, meeting.folder_id);
    if (folder?.is_private) return 'private';
  }
  const before = (await ctx.store.list(
    'audit_events',
    org,
    { eq: { action: FOLLOWUP_FIRED_ACTION, entity_id: meeting.id } },
    { limit: 1 },
  )) as AuditEvent[];
  if (before.length) return 'already';

  let fired = false;
  try {
    const response = await fetchImpl(e.meetingFollowupFireUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${e.meetingFollowupFireToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: followUpFireText(meeting.id) }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
    fired = response.ok;
    if (!response.ok) {
      log.warn('Meeting follow-up trigger refused the request', { status: response.status });
    }
  } catch (error) {
    log.warn('Meeting follow-up trigger could not be reached', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  if (!fired) return 'failed';
  await recordAudit(ctx.store, {
    organizationId: org,
    userId: ctx.auth.userId,
    action: 'notes.followup_fired',
    entityType: 'meeting',
    entityId: meeting.id,
    metadata: {},
  });
  return 'fired';
}
