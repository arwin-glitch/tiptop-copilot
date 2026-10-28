import 'server-only';
import { requireRole } from '@/lib/auth/session';
import { DEFAULT_RECORDING_RULES } from '@/lib/notes/never-record';
import { readNotesPreferences, setNotesPreferences } from '@/lib/notes/preferences';
import { toTemplateView } from '@/lib/notes/views';
import { recordAudit } from '@/lib/security/audit';
import { alignRoster } from '@/lib/speakers/roster';
import {
  BUILTIN_TEMPLATES,
  isBuiltinTemplateId,
  type CreateRecordingRuleRequest,
  type NoteTemplate,
  type NotesPreferences,
  type RecordingRule,
  type RecordingRuleView,
  type RosterTurnInput,
  type SetNotesPreferencesRequest,
  type SpeakerView,
  type TemplateView,
  type TranscriptSegment,
  type UpdateRecordingRuleRequest,
  type UpdateTemplateRequest,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { applyNamingLadder } from './notes-naming';
import { allLinesOf, guard, loadMeeting, speakerViews, type NotesContext } from './notes';

/**
 * Kraken Notes settings (D-076): each person's default visibility, the
 * firm's never-record rules, custom templates, and the meeting-app roster.
 *
 * Never-record rules are the firm's own (a sister company's domain, a
 * calendar, a word): rows, never code, because the repository is public. The
 * built-in legal and family words are listed beside them and cannot be
 * edited. Any member may add a rule (more protection is always allowed);
 * turning one off or deleting it takes an admin.
 */

/* ======================================================= preferences == */

export async function getPreferences(ctx: NotesContext): Promise<NotesPreferences> {
  return readNotesPreferences(ctx.store, ctx.auth.organizationId, ctx.auth.userId);
}

export async function savePreferences(
  ctx: NotesContext,
  patch: SetNotesPreferencesRequest,
): Promise<Result<NotesPreferences>> {
  return setNotesPreferences(ctx.store, ctx.auth, patch, ctx.now);
}

/* ================================================== recording rules == */

function ruleView(row: RecordingRule): RecordingRuleView {
  return {
    id: row.id,
    kind: row.kind,
    pattern: row.pattern,
    label: row.label,
    enabled: row.enabled,
    isDefault: false,
  };
}

const DEFAULT_VIEWS: RecordingRuleView[] = DEFAULT_RECORDING_RULES.map((r) => ({
  id: r.id,
  kind: r.kind,
  pattern: r.pattern,
  label: r.label,
  enabled: true,
  isDefault: true,
}));

export async function listRecordingRules(ctx: NotesContext): Promise<Result<RecordingRuleView[]>> {
  return guard('read the never-record rules', async () => {
    const rows = (await ctx.store.list(
      'recording_rules',
      ctx.auth.organizationId,
      {},
      { orderBy: [{ field: 'created_at', direction: 'asc' }] },
    )) as RecordingRule[];
    return ok([...rows.map(ruleView), ...DEFAULT_VIEWS]);
  });
}

function normalizePattern(kind: RecordingRule['kind'], pattern: string): Result<string> {
  const p = pattern.trim();
  if (kind === 'attendee_domain') {
    const d = p.toLowerCase().replace(/^@/, '');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d))
      return err('invalid_input', 'That is not a domain, like example.com.');
    return ok(d);
  }
  if (kind === 'attendee_email') {
    const e = p.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      return err('invalid_input', 'That is not an email address.');
    return ok(e);
  }
  return ok(p);
}

export async function createRecordingRule(
  ctx: NotesContext,
  input: CreateRecordingRuleRequest,
): Promise<Result<RecordingRuleView>> {
  return guard('save the never-record rule', async () => {
    const pattern = normalizePattern(input.kind, input.pattern);
    if (!pattern.ok) return pattern;
    const org = ctx.auth.organizationId;
    const existing = await ctx.store.findOne('recording_rules', org, {
      eq: { kind: input.kind, pattern: pattern.value },
    });
    if (existing) return err('conflict', 'That rule is already on the list.');
    const now = (ctx.now ?? new Date()).toISOString();
    const row: RecordingRule = {
      id: newId(),
      organization_id: org,
      kind: input.kind,
      pattern: pattern.value,
      label: input.label,
      enabled: input.enabled ?? true,
      created_by: ctx.auth.userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('recording_rules', row);
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.recording_rule_created',
      entityType: 'recording_rule',
      entityId: row.id,
      metadata: { kind: row.kind, label: row.label },
    });
    return ok(ruleView(row));
  });
}

export async function updateRecordingRule(
  ctx: NotesContext,
  id: string,
  patch: UpdateRecordingRuleRequest,
): Promise<Result<RecordingRuleView>> {
  return guard('save the never-record rule', async () => {
    if (id.startsWith('default:')) return err('forbidden', 'The built-in rules cannot be changed.');
    const org = ctx.auth.organizationId;
    const row = await ctx.store.get('recording_rules', org, id);
    if (!row) return err('not_found', 'That rule was not found.');
    // Weakening protection (turning a rule off, changing what it matches) takes an admin.
    if (patch.enabled === false || patch.pattern !== undefined) {
      const allowed = requireRole(ctx.auth, 'admin');
      if (!allowed.ok) return allowed;
    }
    const next: Partial<RecordingRule> = {};
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.pattern !== undefined) {
      const pattern = normalizePattern(row.kind, patch.pattern);
      if (!pattern.ok) return pattern;
      next.pattern = pattern.value;
    }
    const updated = await ctx.store.update('recording_rules', org, id, next);
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.recording_rule_updated',
      entityType: 'recording_rule',
      entityId: id,
      metadata: { fields: Object.keys(next).join(','), enabled: updated.enabled },
    });
    return ok(ruleView(updated));
  });
}

export async function deleteRecordingRule(ctx: NotesContext, id: string): Promise<Result<true>> {
  return guard('delete the never-record rule', async () => {
    if (id.startsWith('default:')) return err('forbidden', 'The built-in rules cannot be removed.');
    const allowed = requireRole(ctx.auth, 'admin');
    if (!allowed.ok) return allowed;
    const org = ctx.auth.organizationId;
    const row = await ctx.store.get('recording_rules', org, id);
    if (!row) return err('not_found', 'That rule was not found.');
    await ctx.store.remove('recording_rules', org, id);
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'notes.recording_rule_deleted',
      entityType: 'recording_rule',
      entityId: id,
      metadata: { kind: row.kind, label: row.label },
    });
    return ok(true);
  });
}

/* ======================================================== templates == */

async function customTemplate(ctx: NotesContext, id: string): Promise<Result<NoteTemplate>> {
  if (isBuiltinTemplateId(id)) return err('forbidden', 'The built-in templates cannot be changed.');
  const row = await ctx.store.get('note_templates', ctx.auth.organizationId, id);
  if (!row || row.archived) return err('not_found', 'That template was not found.');
  return ok(row);
}

export async function updateTemplate(
  ctx: NotesContext,
  id: string,
  patch: UpdateTemplateRequest,
): Promise<Result<TemplateView>> {
  return guard('save the template', async () => {
    const found = await customTemplate(ctx, id);
    if (!found.ok) return found;
    if (
      patch.name &&
      BUILTIN_TEMPLATES.some((t) => t.name.toLowerCase() === patch.name?.toLowerCase())
    ) {
      return err('conflict', 'A built-in template already has that name.');
    }
    const next: Partial<NoteTemplate> = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.meetingType !== undefined) next.meeting_type = patch.meetingType;
    if (patch.purpose !== undefined) next.purpose = patch.purpose;
    if (patch.length !== undefined) next.length = patch.length;
    if (patch.sections !== undefined) next.sections = patch.sections;
    if (patch.prompt !== undefined) next.prompt = patch.prompt;
    if (patch.autoRule !== undefined) next.auto_rule = patch.autoRule;
    const updated = await ctx.store.update('note_templates', ctx.auth.organizationId, id, next);
    await recordAudit(ctx.store, {
      organizationId: ctx.auth.organizationId,
      userId: ctx.auth.userId,
      action: 'notes.template_updated',
      entityType: 'note_template',
      entityId: id,
      metadata: { fields: Object.keys(next).join(',') },
    });
    return ok(toTemplateView(updated));
  });
}

/** Archive a custom template: it leaves the picker; notes already written with it keep its id. */
export async function archiveTemplate(ctx: NotesContext, id: string): Promise<Result<true>> {
  return guard('remove the template', async () => {
    const found = await customTemplate(ctx, id);
    if (!found.ok) return found;
    await ctx.store.update('note_templates', ctx.auth.organizationId, id, { archived: true });
    await recordAudit(ctx.store, {
      organizationId: ctx.auth.organizationId,
      userId: ctx.auth.userId,
      action: 'notes.template_archived',
      entityType: 'note_template',
      entityId: id,
      metadata: {},
    });
    return ok(true);
  });
}

/* =========================================================== roster == */

/**
 * The meeting app's speaking timeline (the Meet extension's roster), lined up
 * with the meeting-audio voices: rung d of the naming ladder. Names a voice
 * only where nobody picked one and no stronger evidence named it.
 */
export async function applyRoster(
  ctx: NotesContext,
  meetingId: string,
  turns: readonly RosterTurnInput[],
): Promise<Result<{ speakers: SpeakerView[]; named: number }>> {
  return guard('line up the roster', async () => {
    const found = await loadMeeting(ctx, meetingId, { recorderOnly: true });
    if (!found.ok) return found;
    const meeting = found.value;
    const lines = (await allLinesOf(ctx, meeting.id, { finalOnly: true })) as TranscriptSegment[];
    const matches = alignRoster(
      turns.map((t) => ({
        name: t.name,
        email: t.email ?? null,
        startMs: t.startMs,
        endMs: t.endMs,
      })),
      lines.map((l) => ({ clusterKey: l.cluster_key, startMs: l.start_ms, endMs: l.end_ms })),
    );
    const result = await applyNamingLadder(ctx, meeting, { roster: matches, lines });
    return ok({ speakers: await speakerViews(ctx, meeting), named: result.named });
  });
}
