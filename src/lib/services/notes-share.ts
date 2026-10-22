import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/config/env';
import { listAllPages } from '@/lib/db/paging';
import type { DataStore } from '@/lib/db/store';
import { soleOrganizationId } from '@/lib/db/tenancy';
import { sharedNotePath } from '@/lib/notes/api';
import { isShareLinkActive, toShareLinkView } from '@/lib/notes/views';
import { recordAudit } from '@/lib/security/audit';
import { rateLimit } from '@/lib/security/limits';
import { speakerDisplayName } from '@/lib/speakers/ladder';
import {
  NOTES_LIMITS,
  type CreateShareLinkRequest,
  type MeetingSpeaker,
  type NoteShareLink,
  type SharedNoteView,
  type ShareLinkView,
  type TranscriptSegment,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { guard, loadMeeting, noteOf, type NotesContext } from './notes';

/**
 * Share links for a meeting's notes (D-076).
 *
 * - The summary only, unless "Include transcript" is switched on.
 * - They expire (7, 30 or 90 days; 30 by default, 90 at most) and can be
 *   revoked at once.
 * - Only a hash of the token is stored: HMAC-SHA256 under NOTES_SHARE_PEPPER,
 *   so a copy of the table is useless without the pepper too. The token is
 *   in the link alone, shown once.
 * - The public view carries no email address, no voice data and no internal
 *   ids; every view is counted and audited, and views brake per address.
 */

/** Demo mode's pepper: a fixed, public string, used only with fictional data. */
const DEMO_PEPPER = 'demo-notes-share-pepper-not-a-secret-0000000000';
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function pepper(): string | null {
  const e = env();
  if (e.notesSharePepper && e.notesSharePepper.length >= 32) return e.notesSharePepper;
  return e.demoMode ? DEMO_PEPPER : null;
}

export function hashShareToken(token: string, key: string): string {
  return createHmac('sha256', key).update(token).digest('hex');
}

/** 24 random bytes as 32 URL-safe characters. */
export function mintShareToken(): string {
  return randomBytes(24).toString('base64url');
}

const SHARE_OFF = () =>
  err('not_configured', 'Share links are not set up yet: NOTES_SHARE_PEPPER is missing.', {
    stillUsable: 'Notes can still be read in Copilot by anyone they are visible to.',
  });

export async function createShareLink(
  ctx: NotesContext,
  meetingId: string,
  input: CreateShareLinkRequest,
): Promise<Result<{ link: ShareLinkView; url: string }>> {
  return guard('make the share link', async () => {
    const key = pepper();
    if (!key) return SHARE_OFF();
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const meeting = found.value;
    const note = await noteOf(ctx, meeting);
    if (!note?.generated_at) {
      return err('conflict', 'Generate the notes before sharing them.');
    }
    const days = input.expiresInDays ?? NOTES_LIMITS.shareDefaultDays;
    if (days > NOTES_LIMITS.shareMaxDays)
      return err('invalid_input', 'Links last 90 days at most.');
    const now = ctx.now ?? new Date();
    const token = mintShareToken();
    const row: NoteShareLink = {
      id: newId(),
      organization_id: ctx.auth.organizationId,
      meeting_id: meeting.id,
      token_hash: hashShareToken(token, key),
      include_transcript: input.includeTranscript ?? false,
      expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
      revoked_at: null,
      revoked_by: null,
      created_by: ctx.auth.userId,
      view_count: 0,
      last_viewed_at: null,
      created_at: now.toISOString(),
    };
    await ctx.store.insert('note_share_links', row);
    await recordAudit(ctx.store, {
      organizationId: ctx.auth.organizationId,
      userId: ctx.auth.userId,
      action: 'notes.share.create',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: { link_id: row.id, include_transcript: row.include_transcript, days },
    });
    return ok({
      link: toShareLinkView(row, now),
      url: `${env().appUrl.replace(/\/$/, '')}${sharedNotePath(token)}`,
    });
  });
}

export async function listShareLinks(
  ctx: NotesContext,
  meetingId: string,
): Promise<Result<ShareLinkView[]>> {
  return guard('read the share links', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const rows = (await ctx.store.list(
      'note_share_links',
      ctx.auth.organizationId,
      { eq: { meeting_id: meetingId } },
      { orderBy: [{ field: 'created_at', direction: 'desc' }] },
    )) as NoteShareLink[];
    const now = ctx.now ?? new Date();
    return ok(rows.map((r) => toShareLinkView(r, now)));
  });
}

/** Revoke a link: from this moment it opens nothing. */
export async function revokeShareLink(
  ctx: NotesContext,
  meetingId: string,
  linkId: string,
): Promise<Result<ShareLinkView>> {
  return guard('revoke the share link', async () => {
    const found = await loadMeeting(ctx, meetingId);
    if (!found.ok) return found;
    const org = ctx.auth.organizationId;
    const link = await ctx.store.get('note_share_links', org, linkId);
    if (!link || link.meeting_id !== meetingId) return err('not_found', 'That link was not found.');
    const now = ctx.now ?? new Date();
    const updated = link.revoked_at
      ? link
      : await ctx.store.update('note_share_links', org, link.id, {
          revoked_at: now.toISOString(),
          revoked_by: ctx.auth.userId,
        });
    if (!link.revoked_at) {
      await recordAudit(ctx.store, {
        organizationId: org,
        userId: ctx.auth.userId,
        action: 'notes.share.revoke',
        entityType: 'meeting',
        entityId: meetingId,
        metadata: { link_id: link.id },
      });
    }
    return ok(toShareLinkView(updated, now));
  });
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * What /n/<token> shows, or not_found for anything that should show nothing:
 * a malformed, unknown, revoked or expired token, or a meeting in the trash.
 * Each successful view is counted and audited. `ip` brakes repeated views
 * from one address.
 */
export async function resolveSharedNote(
  store: DataStore,
  token: string,
  options: { ip?: string | null; organizationId?: string; now?: Date } = {},
): Promise<Result<SharedNoteView>> {
  const nothing = () => err('not_found', 'This link is not valid any more.');
  const limited = rateLimit(`notes-share-view:${options.ip ?? 'unknown'}`, 60, 60_000);
  if (!limited.ok) return limited;
  if (!TOKEN_RE.test(token)) return nothing();
  // Turning Copilot Notes off turns its links off too.
  if (env().notesEnabled === 'off') return nothing();
  const key = pepper();
  if (!key) return nothing();
  const organizationId = options.organizationId ?? (await soleOrganizationId('notes share link'));
  if (!organizationId) return nothing();
  const now = options.now ?? new Date();
  try {
    const hash = hashShareToken(token, key);
    const link = await store.findOne('note_share_links', organizationId, {
      eq: { token_hash: hash },
    });
    if (!link || !sameHash(link.token_hash, hash) || !isShareLinkActive(link, now))
      return nothing();
    const meeting = await store.get('meetings', organizationId, link.meeting_id);
    if (!meeting || meeting.deleted_at) return nothing();
    const note = await store.findOne('meeting_notes', organizationId, {
      eq: { provider: 'copilot', external_id: meeting.id },
    });
    if (!note?.generated_at) return nothing();

    let transcript: SharedNoteView['transcript'] = null;
    if (link.include_transcript) {
      const [speakers, lines] = await Promise.all([
        store.list('meeting_speakers', organizationId, {
          eq: { meeting_id: meeting.id },
        }) as Promise<MeetingSpeaker[]>,
        listAllPages(
          store,
          'transcript_segments',
          organizationId,
          { eq: { meeting_id: meeting.id } },
          [{ field: 'seq', direction: 'asc' }],
        ) as Promise<TranscriptSegment[]>,
      ]);
      const names = new Map(speakers.map((s) => [s.cluster_key, speakerDisplayName(s)]));
      // Names only: a voice named by its address shows as a guest instead.
      transcript = lines.map((l) => {
        const name = names.get(l.cluster_key) ?? 'Guest';
        return {
          startMs: l.start_ms,
          speaker: name.includes('@') ? 'Guest' : name,
          text: l.edited_text ?? l.text,
        };
      });
    }

    await store.update('note_share_links', organizationId, link.id, {
      view_count: link.view_count + 1,
      last_viewed_at: now.toISOString(),
    });
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'notes.share.view',
      entityType: 'meeting',
      entityId: meeting.id,
      metadata: { link_id: link.id },
      ip: options.ip ?? null,
    });

    return ok({
      title: meeting.title,
      occurredAt: meeting.started_at ?? meeting.scheduled_start ?? meeting.created_at,
      blocks: (note.enhanced_blocks ?? []).map((b) => ({
        kind: b.kind,
        text: b.text,
        depth: b.depth,
        source: b.source,
      })),
      actionItems: (note.action_items ?? []).map((a) => ({
        text: a.text,
        ownerName: a.ownerName,
        due: a.due,
      })),
      transcript,
      expiresAt: link.expires_at,
    });
  } catch {
    return nothing();
  }
}
