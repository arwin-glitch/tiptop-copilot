import 'server-only';
import { DEFAULT_RECORDING_RULES } from '@/lib/notes/never-record';
import { recordAudit } from '@/lib/security/audit';
import type {
  CreateRecordingRuleRequest,
  RecordingRule,
  RecordingRuleView,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { guard, type NotesContext } from './notes';

/**
 * Never-record rules (D-076), as Settings edits them: the team's own rows
 * (a title word, a guest's domain or address, a calendar), then the built-in
 * legal and family defaults, which are read only. Anything specific to the
 * firm lives here as a row, never in the code: the repository is public.
 * A meeting that matches any enabled rule cannot be recorded.
 */

function toView(rule: RecordingRule): RecordingRuleView {
  return {
    id: rule.id,
    kind: rule.kind,
    pattern: rule.pattern,
    label: rule.label,
    enabled: rule.enabled,
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

async function audit(
  ctx: NotesContext,
  action: 'notes.rule_created' | 'notes.rule_updated' | 'notes.rule_deleted',
  ruleId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordAudit(ctx.store, {
    organizationId: ctx.auth.organizationId,
    userId: ctx.auth.userId,
    action,
    entityType: 'recording_rule',
    entityId: ruleId,
    metadata,
  });
}

export async function listRecordingRules(ctx: NotesContext): Promise<Result<RecordingRuleView[]>> {
  return guard('read the never-record rules', async () => {
    const rows = (await ctx.store.list(
      'recording_rules',
      ctx.auth.organizationId,
      {},
      { orderBy: [{ field: 'created_at', direction: 'asc' }] },
    )) as RecordingRule[];
    return ok([...rows.map(toView), ...DEFAULT_VIEWS]);
  });
}

export async function createRecordingRule(
  ctx: NotesContext,
  input: CreateRecordingRuleRequest,
): Promise<Result<RecordingRuleView>> {
  return guard('save the never-record rule', async () => {
    const org = ctx.auth.organizationId;
    const pattern =
      input.kind === 'attendee_domain'
        ? input.pattern.toLowerCase().replace(/^@/, '')
        : input.kind === 'attendee_email'
          ? input.pattern.toLowerCase()
          : input.pattern;
    if (input.kind === 'attendee_domain' && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(pattern)) {
      return err('invalid_input', 'That does not look like a domain (for example example.com).');
    }
    if (input.kind === 'attendee_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pattern)) {
      return err('invalid_input', 'That does not look like an email address.');
    }
    const existing = (await ctx.store.list('recording_rules', org, {
      eq: { kind: input.kind },
    })) as RecordingRule[];
    if (existing.some((r) => r.pattern.toLowerCase() === pattern.toLowerCase())) {
      return err('conflict', 'There is already a rule for that.');
    }
    const now = (ctx.now ?? new Date()).toISOString();
    const row: RecordingRule = {
      id: newId(),
      organization_id: org,
      kind: input.kind,
      pattern,
      label: input.label,
      enabled: true,
      created_by: ctx.auth.userId,
      created_at: now,
      updated_at: now,
    };
    await ctx.store.insert('recording_rules', row);
    // The pattern itself stays out of the audit trail: it can name a person.
    await audit(ctx, 'notes.rule_created', row.id, { kind: row.kind, label: row.label });
    return ok(toView(row));
  });
}

export async function updateRecordingRule(
  ctx: NotesContext,
  ruleId: string,
  enabled: boolean,
): Promise<Result<RecordingRuleView>> {
  return guard('save the never-record rule', async () => {
    const org = ctx.auth.organizationId;
    const rule = await ctx.store.get('recording_rules', org, ruleId);
    if (!rule) return err('not_found', 'That rule was not found.');
    const updated = await ctx.store.update('recording_rules', org, rule.id, { enabled });
    await audit(ctx, 'notes.rule_updated', rule.id, { enabled });
    return ok(toView(updated));
  });
}

export async function deleteRecordingRule(
  ctx: NotesContext,
  ruleId: string,
): Promise<Result<true>> {
  return guard('delete the never-record rule', async () => {
    const org = ctx.auth.organizationId;
    const rule = await ctx.store.get('recording_rules', org, ruleId);
    if (!rule) return err('not_found', 'That rule was not found.');
    await ctx.store.remove('recording_rules', org, rule.id);
    await audit(ctx, 'notes.rule_deleted', rule.id, { kind: rule.kind, label: rule.label });
    return ok(true);
  });
}
