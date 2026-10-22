import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { AuditEvent } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { hashIp } from './crypto';
import { redact, log } from './redact';

/**
 * Append-only audit trail.
 *
 * Written for every consequential action: integration connect/disconnect, data
 * deletion, decisions, corrections, drafts, exports and AI generations.
 * Metadata is redacted before write, so a mistake upstream cannot put a token
 * into a durable table.
 */

export type AuditAction =
  | 'auth.demo_session_started'
  | 'auth.signed_out'
  | 'auth.desktop_signed_in'
  | 'desktop.installer_downloaded'
  | 'integration.connected'
  | 'integration.disconnected'
  | 'integration.data_deleted'
  | 'integration.sync_started'
  | 'integration.sync_finished'
  | 'deal.created'
  | 'deal.updated'
  | 'deal.stage_changed'
  | 'deal.merged'
  | 'deal.analysis_generated'
  | 'deal.analysis_overridden'
  | 'deal.fact_corrected'
  | 'deal.decision_recorded'
  | 'deal.memo_exported'
  | 'deal.stage_synced'
  | 'deal.routine_sync'
  | 'deal.archived'
  | 'deal.restored'
  | 'email.analyzed_as_deal'
  | 'email.attached_to_deal'
  | 'email.ignored'
  | 'email.body_fetched'
  | 'meeting_note.ingested_from_email'
  | 'attachment.extracted'
  | 'attachment.downloaded'
  | 'knowledge.uploaded'
  | 'knowledge.deleted'
  | 'network.imported'
  | 'portfolio.created'
  | 'portfolio.imported'
  | 'portfolio.request_handled'
  | 'portfolio.asks_read'
  | 'crm.list_created'
  | 'crm.list_updated'
  | 'crm.entry_added'
  | 'crm.entry_updated'
  | 'crm.record_updated'
  | 'crm.entry_removed'
  | 'crm.entry_restored'
  | 'crm.note_added'
  | 'crm.note_updated'
  | 'crm.note_deleted'
  | 'crm.record_created'
  | 'crm.imported'
  | 'crm.list_destination'
  | 'crm.affinity_sync'
  | 'crm.view_saved'
  | 'crm.view_deleted'
  | 'crm.exported'
  | 'campaign.created'
  | 'campaign.deleted'
  | 'campaign.recipient_updated'
  | 'campaign.test_sent'
  | 'campaign.confirmed'
  | 'campaign.paused'
  | 'campaign.resumed'
  | 'campaign.cancelled'
  | 'campaign.retried'
  | 'campaign.marked_sent'
  | 'campaign.resent'
  | 'campaign.unsubscribed'
  | 'campaign.resubscribed'
  | 'campaign.suppressed'
  // Events (D-075). Owners' actions carry their userId; an outside editor's,
  // staff link's or guest's carry userId null and the grant/guest id in
  // metadata (never a token, never an email in a public-path log).
  | 'event.created'
  | 'event.updated'
  | 'event.duplicated'
  | 'event.published'
  | 'event.unpublished'
  | 'event.cancelled'
  | 'event.archived'
  | 'event.deleted'
  | 'event.slug_changed'
  | 'event.settings_changed'
  | 'event.registration_changed'
  | 'event.template_saved'
  | 'event.editor_link_created'
  | 'event.editor_link_updated'
  | 'event.editor_link_revoked'
  | 'event.editor_link_regenerated'
  | 'event.editor_link_claimed'
  | 'event.editor_links_revoked_all'
  | 'event.editing_paused'
  | 'event.editing_resumed'
  | 'event.ready_for_review'
  | 'event.version_named'
  | 'event.version_restored'
  | 'event.media_uploaded'
  | 'event.media_deleted'
  | 'event.guest_added'
  | 'event.guest_updated'
  | 'event.guest_status_changed'
  | 'event.guest_link_rotated'
  | 'event.guest_deleted'
  | 'event.guests_exported'
  | 'event.guests_imported'
  | 'event.rsvp_received'
  | 'event.rsvp_changed'
  | 'event.rsvp_duplicate'
  | 'event.rsvp_busy'
  | 'event.checkin'
  | 'event.checkin_undone'
  | 'event.walk_in_added'
  | 'event.campaign_drafted'
  | 'event.notified_marked'
  | 'task.created'
  | 'task.updated'
  | 'task.edited'
  | 'task.assigned'
  | 'task.auto_completed'
  | 'task.money_legal_set'
  | 'task.proof_recorded'
  | 'task.needs_proof'
  | 'task.proof_expected'
  | 'task.proof_seen'
  | 'task.proof_missing'
  | 'task.proof_confirmed'
  | 'task.company_set'
  | 'task.glance_set'
  | 'task.autoclose_sweep'
  | 'task.snapshot_posted'
  | 'calendar.event_created'
  | 'calendar.event_updated'
  | 'calendar.event_deleted'
  | 'draft.created'
  | 'chat.question_asked'
  | 'brief.generated'
  | 'settings.updated'
  | 'mcp.token_created'
  | 'mcp.token_revoked'
  | 'mcp.tool_called'
  | 'push.desktop_enabled'
  | 'push.desktop_disabled'
  | 'feeds.notices_on'
  | 'feeds.notices_off'
  | 'thesis.updated'
  | 'account.data_deleted'
  | 'security.injection_flagged'
  | 'security.citation_rejected';

export interface AuditInput {
  organizationId: string;
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAudit(store: DataStore, input: AuditInput): Promise<void> {
  const event: AuditEvent = {
    id: newId(),
    organization_id: input.organizationId,
    user_id: input.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata: (redact(input.metadata ?? {}) as Record<string, unknown>) ?? {},
    ip_hash: hashIp(input.ip),
    created_at: new Date().toISOString(),
  };
  try {
    await store.insert('audit_events', event);
  } catch (error) {
    // An audit failure must never take down the action it was describing, but
    // it must be loud.
    log.error('Failed to write audit event', {
      action: input.action,
      entityType: input.entityType,
      reason: (error as Error)?.message,
    });
  }
}
