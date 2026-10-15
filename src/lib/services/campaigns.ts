import 'server-only';
import {
  CLICK_BURST_MS,
  isAutoReply,
  isAutomatedAgent,
  withinScanWindow,
} from '@/lib/campaigns/activity';
import {
  BATCH_BUDGET_MS,
  BATCH_MAX,
  DAILY_CAP,
  DAY_MS,
  INTERRUPTED_AFTER_MS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_CONSECUTIVE_FAILURES,
  MAX_RECIPIENTS,
  SEND_INTERVAL_MS,
  SEND_LEASE_MS,
  UPLOAD_CHUNK_BYTES,
  dailyCapState,
  formatBytes,
  waitBeforeNext,
  type DailyCapState,
} from '@/lib/campaigns/limits';
import { isEmail, normalizeEmail, parsePastedRecipients } from '@/lib/campaigns/recipients';
import type { CampaignSender, OutgoingCampaignEmail } from '@/lib/campaigns/sender-types';
import {
  collectLinks,
  escapeHtml,
  firstNameOf,
  isTrackableHref,
  mergeFieldsUsed,
  missingMergeFields,
  parseTemplate,
  renderHtml,
  renderSubject,
  renderText,
  subjectIssues,
  type MergeField,
  type ParsedTemplate,
} from '@/lib/campaigns/template';
import {
  LOCAL_ORIGIN_MESSAGE,
  testTrackingUrls,
  trackingUrls,
  type TestTrackingTarget,
  type TrackingTarget,
  type TrackingUrls,
} from '@/lib/campaigns/tokens';
import { statusFieldOf } from '@/lib/crm/fields';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore, Filter, Row, TableName } from '@/lib/db/store';
import { recordAudit, type AuditAction } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import type { StorageProvider } from '@/lib/storage/provider';
import type {
  Campaign,
  CampaignAttachment,
  CampaignEvent,
  CampaignEventKind,
  CampaignFromIdentity,
  CampaignMerge,
  CampaignPauseReason,
  CampaignRecipient,
  CampaignStatus,
  CrmRecord,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';
import { corporateEmailDomain, htmlToPlainText } from '@/lib/util/text';

/**
 * Campaigns: tracked bulk email, replacing Affinity's.
 *
 * A campaign is a subject, a body template with merge fields, a signature,
 * attachments and a recipient list. Sending is one personal email per
 * recipient from the connected mailbox, paced and capped (lib/campaigns/
 * limits.ts), with (each switchable per campaign) an open pixel and tracked
 * links, an unsubscribe line, and always a reply check against the synced
 * mailbox.
 *
 * The send rules, which every function here keeps:
 *   - Nothing sends unless a person taps Send. `confirmCampaign` is the only
 *     way out of 'draft', and it takes back the exact count, subject, sender,
 *     settings and version the review screen showed; anything changed since
 *     and it refuses. Batches go only while a campaign is 'sending' and only
 *     when a page asks for one. There is no schedule and nothing here is
 *     called by a job, except the reply check, which only reads the mailbox.
 *   - What was reviewed is what goes. Leaving 'draft' is a compare-and-set on
 *     the campaign's version (DataStore.updateWhere), and every draft edit is
 *     a compare-and-set on status 'draft', so an edit racing the tap either
 *     lands first (and the tap is refused as stale) or is refused itself.
 *     A recipient added after the reviewed ones is never sent.
 *   - This module never builds a sender. Callers pass one in (see
 *     lib/campaigns/sender-types.ts), so importing it reaches no send path.
 *   - One sender per organization at a time: a batch holds the organization's
 *     send lease (campaign_send_locks) while it sends, so two tabs or two
 *     server instances never send at once, and the pace and the daily cap
 *     hold across them.
 *   - Nobody gets the same email twice: each recipient is claimed (attempted_at
 *     set where it was null, atomically) just before the send, and an attempt
 *     that never finished is reported as "may have gone out", never redone
 *     unless a person says so.
 *   - Unsubscribed addresses are left out when added and checked again just
 *     before each batch.
 *
 * Every function returns a Result and runs inside `guard`, so a missing table
 * (the migration not applied yet) reads as "not set up yet", not a crash.
 */

/* ------------------------------------------------------------- setup state */

export const CAMPAIGN_TABLES = [
  'campaigns',
  'campaign_recipients',
  'campaign_events',
  'campaign_send_locks',
] as const;
export type CampaignTable = (typeof CAMPAIGN_TABLES)[number];

export const CAMPAIGNS_MIGRATION_FILE = 'supabase/migrations/20261016000000_campaigns.sql';

const NOT_SET_UP_READ = `Campaigns are not set up yet: their tables do not exist. Run ${CAMPAIGNS_MIGRATION_FILE} in the Supabase SQL editor, then reload.`;
const NOT_SET_UP_WRITE = `Nothing was saved: the campaign tables do not exist yet. Run ${CAMPAIGNS_MIGRATION_FILE} in the Supabase SQL editor, then try again.`;
const OUT_OF_DATE = `Campaigns are not fully set up: their tables are from an earlier copy of the migration. Run ${CAMPAIGNS_MIGRATION_FILE} again in the Supabase SQL editor (it is safe to re-run).`;

/** True for the "tables not created yet" failure, which a page shows as a set-up state. */
export function isCampaignsNotSetUp(result: Result<unknown>): boolean {
  return !result.ok && result.error.code === 'not_configured';
}

async function guard<T>(
  mode: 'read' | 'write',
  operation: string,
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (isMissingTableError(error)) {
      return err('not_configured', mode === 'read' ? NOT_SET_UP_READ : NOT_SET_UP_WRITE, {
        stillUsable: 'Everything outside Campaigns works as before.',
        details: { operation },
      });
    }
    if (isMissingColumnError(error)) {
      return err('not_configured', OUT_OF_DATE, {
        stillUsable: 'Everything outside Campaigns works as before.',
        details: { operation },
      });
    }
    log.error('Campaign operation failed', {
      operation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return err(
      'internal',
      mode === 'read' ? 'Campaigns could not be read just now.' : 'That did not work. Try again.',
      { retryable: true, details: { operation } },
    );
  }
}

/* ----------------------------------------------------------------- helpers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const RECIPIENT_ORDER = [{ field: 'created_at', direction: 'asc' as const }];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every row whose `column` is one of `values`, in chunks that keep URLs short. */
async function listWhereIn<T extends TableName>(
  store: DataStore,
  table: T,
  organizationId: string,
  base: Filter,
  column: string,
  values: readonly string[],
): Promise<Row<T>[]> {
  const out: Row<T>[] = [];
  for (const group of chunk([...new Set(values)], 100)) {
    out.push(
      ...(await listAllPages(store, table, organizationId, {
        ...base,
        in: { ...base.in, [column]: group },
      })),
    );
  }
  return out;
}

async function audit(
  store: DataStore,
  organizationId: string,
  userId: string | null,
  action: AuditAction,
  campaignId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await recordAudit(store, {
    organizationId,
    userId,
    action,
    entityType: 'campaign',
    entityId: campaignId,
    metadata,
  });
}

async function loadCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Campaign | null> {
  if (!isUuid(campaignId)) return null;
  return store.get('campaigns', organizationId, campaignId);
}

const NOT_FOUND = () => err('not_found', 'That campaign does not exist.');
const NOT_DRAFT = () =>
  err(
    'conflict',
    'This campaign has already been sent or started, so it can no longer be changed.',
  );

async function recipientsOf(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  filter: Filter = {},
): Promise<CampaignRecipient[]> {
  return listAllPages(
    store,
    'campaign_recipients',
    organizationId,
    { ...filter, eq: { ...filter.eq, campaign_id: campaignId } },
    RECIPIENT_ORDER,
  );
}

/** Whether a campaign's emails carry any Copilot link (and so need a public APP_URL). */
const usesAppLinks = (c: Pick<Campaign, 'track_activity' | 'unsubscribe_link'>) =>
  c.track_activity || c.unsubscribe_link;

/**
 * A version strictly after the campaign's current one. Postgres's trigger
 * stamps its own `now()` anyway; the demo store keeps this, so two edits in
 * the same millisecond still read as two versions.
 */
function nextVersion(campaign: Pick<Campaign, 'updated_at'>): string {
  return new Date(Math.max(Date.now(), (Date.parse(campaign.updated_at) || 0) + 1)).toISOString();
}

/**
 * Mark a draft changed, so a review made before the change cannot be
 * confirmed — but only while it is still a draft. False: it was confirmed
 * (or deleted) meanwhile, and the caller undoes what it did.
 */
async function touchDraft(
  store: DataStore,
  organizationId: string,
  campaign: Pick<Campaign, 'id' | 'updated_at'>,
): Promise<boolean> {
  const rows = await store.updateWhere(
    'campaigns',
    organizationId,
    { eq: { id: campaign.id, status: 'draft' } },
    { updated_at: nextVersion(campaign) },
  );
  return rows.length > 0;
}

/** Why a compare-and-set on a draft found nothing: gone, started, or changed under it. */
async function draftConflict(store: DataStore, organizationId: string, campaignId: string) {
  const current = await loadCampaign(store, organizationId, campaignId);
  if (!current) return NOT_FOUND();
  if (current.status !== 'draft') return NOT_DRAFT();
  return err('conflict', 'This campaign changed at the same moment somewhere else. Try again.', {
    retryable: true,
  });
}

/** The in-process half of the send lock (the database lease is the other). */
const sending = processWide('campaign-send-locks', () => new Set<string>());

/* ------------------------------------------------------------------ counts */

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  /** Interrupted mid-send: may have gone out. */
  unconfirmed: number;
  skipped: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
}

export function countRecipients(recipients: readonly CampaignRecipient[]): CampaignCounts {
  const c: CampaignCounts = {
    total: recipients.length,
    pending: 0,
    sent: 0,
    failed: 0,
    unconfirmed: 0,
    skipped: 0,
    opened: 0,
    clicked: 0,
    replied: 0,
    bounced: 0,
    unsubscribed: 0,
  };
  for (const r of recipients) {
    c[r.status] += 1;
    if (r.status !== 'sent') continue;
    if (r.opened_at) c.opened += 1;
    if (r.clicked_at) c.clicked += 1;
    if (r.replied_at) c.replied += 1;
    if (r.bounced_at) c.bounced += 1;
    if (r.unsubscribed_at) c.unsubscribed += 1;
  }
  return c;
}

/** A share of the sent emails, as a whole percentage; null before anything was sent. */
export function rate(part: number, sent: number): number | null {
  return sent > 0 ? Math.round((part / sent) * 100) : null;
}

/** Where one recipient stands, most telling first: what the report shows. */
export type RecipientState =
  | 'replied'
  | 'clicked'
  | 'opened'
  | 'sent'
  | 'bounced'
  | 'unsubscribed'
  | 'failed'
  | 'unconfirmed'
  | 'skipped'
  | 'pending';

export function recipientState(r: CampaignRecipient): RecipientState {
  if (r.status !== 'sent') return r.status;
  if (r.bounced_at) return 'bounced';
  if (r.replied_at) return 'replied';
  if (r.unsubscribed_at) return 'unsubscribed';
  if (r.clicked_at) return 'clicked';
  if (r.opened_at) return 'opened';
  return 'sent';
}

/* ------------------------------------------------------------------- reads */

export interface CampaignSummary extends Campaign {
  counts: CampaignCounts;
}

/** Every campaign, newest first, with its counts. */
export async function listCampaigns(
  store: DataStore,
  organizationId: string,
): Promise<Result<CampaignSummary[]>> {
  return guard('read', 'list campaigns', async () => {
    const campaigns = await listAllPages(store, 'campaigns', organizationId, {}, [
      { field: 'created_at', direction: 'desc' },
    ]);
    const recipients = campaigns.length
      ? await listWhereIn(
          store,
          'campaign_recipients',
          organizationId,
          {},
          'campaign_id',
          campaigns.map((c) => c.id),
        )
      : [];
    const byCampaign = new Map<string, CampaignRecipient[]>();
    for (const r of recipients) {
      const list = byCampaign.get(r.campaign_id) ?? [];
      list.push(r);
      byCampaign.set(r.campaign_id, list);
    }
    return ok(
      campaigns.map((c) => ({ ...c, counts: countRecipients(byCampaign.get(c.id) ?? []) })),
    );
  });
}

export interface CampaignDetail {
  campaign: Campaign;
  recipients: CampaignRecipient[];
  counts: CampaignCounts;
}

export async function getCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Result<CampaignDetail>> {
  return guard('read', 'read a campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const recipients = await recipientsOf(store, organizationId, campaign.id);
    return ok({ campaign, recipients, counts: countRecipients(recipients) });
  });
}

/** The organization's 24-hour cap right now, for a page to say when the next slot opens. */
export async function dailyCapNow(
  store: DataStore,
  organizationId: string,
): Promise<Result<DailyCapState>> {
  return guard('read', 'read the daily cap', async () =>
    ok(await capState(store, organizationId, new Date(), DAILY_CAP)),
  );
}

/* ------------------------------------------------------------ draft edits */

export interface CampaignActor {
  userId: string | null;
}

export async function createCampaign(
  store: DataStore,
  organizationId: string,
  actor: CampaignActor,
  input: { name?: string | null } = {},
): Promise<Result<Campaign>> {
  return guard('write', 'create a campaign', async () => {
    const now = new Date().toISOString();
    const name =
      (input.name ?? '').trim().slice(0, 300) ||
      `Campaign ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const campaign: Campaign = {
      id: newId(),
      organization_id: organizationId,
      name,
      subject: '',
      body_template: '',
      from_identity: 'nick',
      status: 'draft',
      attachments: [],
      link_allowlist: [],
      confirmed_at: null,
      confirmed_by: null,
      last_sent_at: null,
      track_activity: true,
      unsubscribe_link: false,
      confirmed_through: null,
      pause_reason: null,
      created_by: actor.userId,
      created_at: now,
      updated_at: now,
      sent_at: null,
    };
    await store.insert('campaigns', campaign);
    await audit(store, organizationId, actor.userId, 'campaign.created', campaign.id);
    return ok(campaign);
  });
}

export interface CampaignPatch {
  name?: string;
  subject?: string;
  body_template?: string;
  from_identity?: CampaignFromIdentity;
  track_activity?: boolean;
  unsubscribe_link?: boolean;
}

export async function updateCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  patch: CampaignPatch,
): Promise<Result<Campaign>> {
  return guard('write', 'update a campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    const next: Partial<Campaign> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 300);
      if (!name) return err('invalid_input', 'Give the campaign a name.');
      next.name = name;
    }
    if (patch.subject !== undefined)
      next.subject = patch.subject.replace(/[\r\n]+/g, ' ').slice(0, 300);
    if (patch.body_template !== undefined)
      next.body_template = patch.body_template.slice(0, 50_000);
    if (patch.from_identity !== undefined) {
      if (patch.from_identity !== 'nick' && patch.from_identity !== 'arwin') {
        return err('invalid_input', 'Choose Nick or Arwin.');
      }
      next.from_identity = patch.from_identity;
    }
    if (typeof patch.track_activity === 'boolean') next.track_activity = patch.track_activity;
    if (typeof patch.unsubscribe_link === 'boolean') next.unsubscribe_link = patch.unsubscribe_link;
    next.updated_at = nextVersion(campaign);
    // Only while it is still a draft: a save racing the tap on Send must not
    // change the email after its review (and its link allowlist) was taken.
    const [updated] = await store.updateWhere(
      'campaigns',
      organizationId,
      { eq: { id: campaign.id, status: 'draft' } },
      next,
    );
    if (!updated) return draftConflict(store, organizationId, campaign.id);
    return ok(updated);
  });
}

/** Delete a draft, its recipients and its attachments. A campaign that sent anything stays. */
export async function deleteCampaign(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  campaignId: string,
  actor: CampaignActor,
): Promise<Result<true>> {
  return guard('write', 'delete a campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const onlyDrafts = () =>
      err('conflict', 'Only a draft can be deleted. A campaign that started keeps its report.');
    if (campaign.status !== 'draft') return onlyDrafts();
    // Claim it first, so a tap on Send in another tab cannot start what is
    // being deleted.
    const [claimed] = await store.updateWhere(
      'campaigns',
      organizationId,
      { eq: { id: campaign.id, status: 'draft' } },
      { status: 'cancelled', updated_at: nextVersion(campaign) },
    );
    if (!claimed) return onlyDrafts();
    for (const attachment of claimed.attachments) await removeParts(storage, attachment.parts);
    await store.removeWhere('campaign_recipients', organizationId, {
      eq: { campaign_id: campaign.id },
    });
    await store.remove('campaigns', organizationId, campaign.id);
    await audit(store, organizationId, actor.userId, 'campaign.deleted', campaign.id);
    return ok(true);
  });
}

/* ------------------------------------------------------------ suppression */

/**
 * The latest unsubscribe or resubscribe per address: an unsubscribe there
 * means suppressed. On a tie the unsubscribe wins (nobody is emailed by
 * accident); new events are stamped after the latest anyway (nextSuppressionAt).
 */
function latestSuppressionEvents(rows: readonly CampaignEvent[]): Map<string, CampaignEvent> {
  const latest = new Map<string, CampaignEvent>();
  for (const row of rows) {
    if (!row.email || (row.kind !== 'unsubscribe' && row.kind !== 'resubscribe')) continue;
    const key = row.email.toLowerCase();
    const previous = latest.get(key);
    const at = Date.parse(row.at);
    const before = previous ? Date.parse(previous.at) : -Infinity;
    if (at > before || (at === before && row.kind === 'unsubscribe')) latest.set(key, row);
  }
  return latest;
}

/** A time strictly after the address's latest unsubscribe or resubscribe, so the new one wins. */
async function nextSuppressionAt(
  store: DataStore,
  organizationId: string,
  email: string,
): Promise<string> {
  const rows = await listWhereIn(
    store,
    'campaign_events',
    organizationId,
    { in: { kind: ['unsubscribe', 'resubscribe'] } },
    'email',
    [email],
  );
  const latest = rows.reduce((max, r) => Math.max(max, Date.parse(r.at) || 0), 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

/** Of these addresses, the ones that unsubscribed (and were not resubscribed since). */
export async function suppressedEmails(
  store: DataStore,
  organizationId: string,
  emails: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length) return out;
  const rows = await listWhereIn(
    store,
    'campaign_events',
    organizationId,
    { in: { kind: ['unsubscribe', 'resubscribe'] } },
    'email',
    emails.map((e) => e.toLowerCase()),
  );
  for (const [email, event] of latestSuppressionEvents(rows)) {
    if (event.kind === 'unsubscribe') out.add(email);
  }
  return out;
}

/** Skip the unsent copies of an address waiting in any campaign. */
async function skipWaiting(store: DataStore, organizationId: string, email: string) {
  await store.updateWhere(
    'campaign_recipients',
    organizationId,
    { eq: { email, status: 'pending' }, isNull: ['attempted_at'] },
    { status: 'skipped', error: 'Unsubscribed' },
  );
}

export interface SuppressionEntry {
  email: string;
  at: string;
  /** Through a campaign email's link, or added by a person in Copilot. */
  source: 'link' | 'manual';
  campaignId: string | null;
  campaignName: string | null;
}

/** Everyone currently unsubscribed, newest first: the suppression list as a person reads it. */
export async function listUnsubscribes(
  store: DataStore,
  organizationId: string,
): Promise<Result<SuppressionEntry[]>> {
  return guard('read', 'list unsubscribes', async () => {
    const rows = await listAllPages(store, 'campaign_events', organizationId, {
      in: { kind: ['unsubscribe', 'resubscribe'] },
    });
    const current = [...latestSuppressionEvents(rows).values()].filter(
      (e) => e.kind === 'unsubscribe',
    );
    const campaignIds = [
      ...new Set(current.map((e) => e.campaign_id).filter((id): id is string => !!id)),
    ];
    const names = new Map(
      (campaignIds.length
        ? await listWhereIn(store, 'campaigns', organizationId, {}, 'id', campaignIds)
        : []
      ).map((c) => [c.id, c.name]),
    );
    return ok(
      current
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .map((e) => ({
          email: (e.email as string).toLowerCase(),
          at: e.at,
          source: e.recipient_id ? ('link' as const) : ('manual' as const),
          campaignId: e.campaign_id,
          campaignName: e.campaign_id ? (names.get(e.campaign_id) ?? null) : null,
        })),
    );
  });
}

/**
 * Put an unsubscribed address back on: for someone who asked to get these
 * emails again. The unsubscribe stays in the history; the later resubscribe
 * outranks it.
 */
export async function resubscribe(
  store: DataStore,
  organizationId: string,
  actor: CampaignActor,
  rawEmail: string,
): Promise<Result<{ email: string }>> {
  return guard('write', 'resubscribe an address', async () => {
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) return err('invalid_input', 'That is not an email address.');
    if (!(await suppressedEmails(store, organizationId, [email])).has(email)) {
      return err('not_found', 'That address is not unsubscribed.');
    }
    await store.insert('campaign_events', {
      id: newId(),
      organization_id: organizationId,
      campaign_id: null,
      recipient_id: null,
      kind: 'resubscribe',
      url: null,
      email,
      at: await nextSuppressionAt(store, organizationId, email),
      user_agent: null,
      automated: false,
    });
    await audit(store, organizationId, actor.userId, 'campaign.resubscribed', null);
    return ok({ email });
  });
}

/**
 * Unsubscribe an address by hand: someone replied asking to be taken off, or
 * the campaign went without an unsubscribe link. Same effect as the link.
 */
export async function suppressEmail(
  store: DataStore,
  organizationId: string,
  actor: CampaignActor,
  rawEmail: string,
): Promise<Result<{ email: string; already: boolean }>> {
  return guard('write', 'unsubscribe an address', async () => {
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) return err('invalid_input', 'That is not an email address.');
    const already = (await suppressedEmails(store, organizationId, [email])).has(email);
    if (!already) {
      await store.insert('campaign_events', {
        id: newId(),
        organization_id: organizationId,
        campaign_id: null,
        recipient_id: null,
        kind: 'unsubscribe',
        url: null,
        email,
        at: await nextSuppressionAt(store, organizationId, email),
        user_agent: null,
        automated: false,
      });
      await audit(store, organizationId, actor.userId, 'campaign.suppressed', null);
    }
    await skipWaiting(store, organizationId, email);
    return ok({ email, already });
  });
}

/* -------------------------------------------------------------- recipients */

export interface RecipientCandidate {
  email: string;
  name: string | null;
  company: string | null;
  record_id: string | null;
}

export interface AddRecipientsSummary {
  added: number;
  /** Already on this campaign. */
  alreadyIn: number;
  /** In the source more than once. */
  duplicates: number;
  /** Left out because they unsubscribed. */
  unsubscribed: number;
  /** Who those are (the first 20), so a person can check the list or resubscribe one. */
  unsubscribedEmails: string[];
  /** People on the list with no email address. */
  noEmail: number;
  /** Text that looked like an address but is not one. */
  invalid: string[];
  /** Left out because the campaign is full. */
  overLimit: number;
  /** Recipients on the campaign now. */
  total: number;
}

async function addCandidates(
  store: DataStore,
  organizationId: string,
  campaign: Campaign,
  candidates: RecipientCandidate[],
  base: Pick<AddRecipientsSummary, 'duplicates' | 'noEmail' | 'invalid'>,
): Promise<Result<AddRecipientsSummary>> {
  const existing = await recipientsOf(store, organizationId, campaign.id);
  const have = new Set(existing.map((r) => r.email));
  const seen = new Set<string>();
  let duplicates = base.duplicates;
  let alreadyIn = 0;
  const fresh: RecipientCandidate[] = [];
  for (const c of candidates) {
    const email = normalizeEmail(c.email);
    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    if (have.has(email)) {
      alreadyIn += 1;
      continue;
    }
    fresh.push({ ...c, email });
  }
  const suppressed = await suppressedEmails(
    store,
    organizationId,
    fresh.map((c) => c.email),
  );
  const allowed = fresh.filter((c) => !suppressed.has(c.email));
  const room = Math.max(0, MAX_RECIPIENTS - existing.length);
  const taking = allowed.slice(0, room);
  // A millisecond apart, so the list (and the send order) keeps the order
  // people were added in rather than falling back to random ids. Always after
  // everyone already on it: a recipient added after a confirmation therefore
  // sorts after the reviewed ones, past `confirmed_through`.
  const start = Math.max(Date.now(), ...existing.map((r) => Date.parse(r.created_at) + 1));
  const rows: CampaignRecipient[] = taking.map((c, index) => {
    const now = new Date(start + index).toISOString();
    const name = c.name?.trim() || null;
    const merge: CampaignMerge = {};
    if (name) {
      merge.name = name;
      const first = firstNameOf(name);
      if (first) merge.first_name = first;
    }
    if (c.company?.trim()) merge.company = c.company.trim();
    return {
      id: newId(),
      organization_id: organizationId,
      campaign_id: campaign.id,
      email: c.email,
      name,
      merge,
      record_id: c.record_id,
      status: 'pending',
      gmail_message_id: null,
      gmail_thread_id: null,
      error: null,
      attempted_at: null,
      sent_at: null,
      opened_at: null,
      open_count: 0,
      clicked_at: null,
      click_count: 0,
      replied_at: null,
      bounced_at: null,
      unsubscribed_at: null,
      created_at: now,
      updated_at: now,
    };
  });
  for (const group of chunk(rows, 500)) await store.insertMany('campaign_recipients', group);
  if (rows.length && !(await touchDraft(store, organizationId, campaign))) {
    // Confirmed while these went in: take them out again. (Were any left, a
    // batch would skip them anyway: they sort after `confirmed_through`.)
    for (const group of chunk(
      rows.map((r) => r.id),
      100,
    )) {
      await store.removeWhere('campaign_recipients', organizationId, { in: { id: group } });
    }
    return draftConflict(store, organizationId, campaign.id);
  }
  return ok({
    added: rows.length,
    alreadyIn,
    duplicates,
    unsubscribed: fresh.length - allowed.length,
    unsubscribedEmails: fresh
      .filter((c) => suppressed.has(c.email))
      .map((c) => c.email)
      .slice(0, 20),
    noEmail: base.noEmail,
    invalid: base.invalid,
    overLimit: allowed.length - taking.length,
    total: existing.length + rows.length,
  });
}

const personEmail = (r: CrmRecord) => normalizeEmail(r.primary_email ?? r.emails[0] ?? '');

/** Companies by their domain, for naming the company of a person from their work address. */
async function companiesByDomain(
  store: DataStore,
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, string>> {
  const domains = [
    ...new Set(emails.map((e) => corporateEmailDomain(e)).filter((d): d is string => !!d)),
  ];
  const out = new Map<string, string>();
  if (!domains.length) return out;
  const companies = await listWhereIn(
    store,
    'crm_records',
    organizationId,
    { eq: { kind: 'company' } },
    'domain',
    domains,
  );
  for (const c of companies) if (c.domain) out.set(c.domain, c.name);
  return out;
}

/**
 * People from a CRM list, filtered by status: a person list's people; for a
 * company or deal list, the people linked to each row (and, for a company,
 * the people at its domain), with that company as their {{company}}.
 */
export async function addRecipientsFromList(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  input: { listId: string; statuses?: readonly string[] | null },
): Promise<Result<AddRecipientsSummary>> {
  return guard('write', 'add recipients from a list', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    if (!isUuid(input.listId)) return err('not_found', 'That list does not exist.');
    const list = await store.get('crm_lists', organizationId, input.listId);
    if (!list) return err('not_found', 'That list does not exist.');

    const filter: Filter = { eq: { list_id: list.id } };
    const statusField = statusFieldOf(list);
    const statuses = (input.statuses ?? []).filter((s) => typeof s === 'string' && s);
    if (statusField && statuses.length) filter.in = { [`values->>${statusField.key}`]: statuses };
    const entries = await listAllPages(store, 'crm_list_entries', organizationId, filter, [
      { field: 'position', direction: 'asc' },
    ]);

    // The list's company-type field names a person's company when it is set.
    const companyField = list.fields.find((f) => f.type === 'company');
    const linkedIds = (e: (typeof entries)[number]) => [
      ...(e.record_id ? [e.record_id] : []),
      ...(((e as { linked_record_ids?: string[] }).linked_record_ids ?? []) as string[]),
    ];
    const records = new Map(
      (
        await listWhereIn(
          store,
          'crm_records',
          organizationId,
          {},
          'id',
          entries.flatMap(linkedIds),
        )
      ).map((r) => [r.id, r]),
    );

    const candidates: RecipientCandidate[] = [];
    let noEmail = 0;
    const companiesToExpand: { company: CrmRecord }[] = [];
    for (const entry of entries) {
      const ids = linkedIds(entry);
      if (!ids.length) {
        noEmail += 1;
        continue;
      }
      const fieldCompany = companyField ? entry.values[companyField.key] : null;
      const namedCompany = Array.isArray(fieldCompany)
        ? (fieldCompany[0] ?? null)
        : typeof fieldCompany === 'string'
          ? fieldCompany
          : null;
      const rowCompany = ids.map((id) => records.get(id)).find((r) => r?.kind === 'company');
      let found = false;
      for (const id of ids) {
        const record = records.get(id);
        if (!record) continue;
        if (record.kind === 'person') {
          const email = personEmail(record);
          if (!email || !isEmail(email)) continue;
          found = true;
          candidates.push({
            email,
            name: record.name,
            company: namedCompany ?? rowCompany?.name ?? null,
            record_id: record.id,
          });
        } else if (record.domain && !ids.some((x) => records.get(x)?.kind === 'person')) {
          // A company row with nobody linked: its people are those at its domain.
          companiesToExpand.push({ company: record });
          found = true;
        }
      }
      if (!found) noEmail += 1;
    }

    for (const { company } of companiesToExpand) {
      const suffix = `@${company.domain}`;
      const people = await store.list(
        'crm_records',
        organizationId,
        { eq: { kind: 'person' }, textSearch: { columns: ['primary_email'], query: suffix } },
        { orderBy: [{ field: 'name', direction: 'asc' }], limit: 200 },
      );
      const atDomain = people.filter((p) => p.primary_email?.toLowerCase().endsWith(suffix));
      if (!atDomain.length) noEmail += 1;
      for (const p of atDomain) {
        candidates.push({
          email: personEmail(p),
          name: p.name,
          company: company.name,
          record_id: p.id,
        });
      }
    }

    // Name a company from the work address for anyone the list left without one.
    const domainCompanies = await companiesByDomain(
      store,
      organizationId,
      candidates.filter((c) => !c.company).map((c) => c.email),
    );
    for (const c of candidates) {
      if (!c.company) c.company = domainCompanies.get(corporateEmailDomain(c.email) ?? '') ?? null;
    }

    return addCandidates(store, organizationId, campaign, candidates, {
      duplicates: 0,
      noEmail,
      invalid: [],
    });
  });
}

/** Pasted addresses, matched to CRM people where they are known (for names and companies). */
export async function addRecipientsFromPaste(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  text: string,
): Promise<Result<AddRecipientsSummary>> {
  return guard('write', 'add pasted recipients', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    const parsed = parsePastedRecipients(text.slice(0, 500_000), MAX_RECIPIENTS + 500);
    if (!parsed.recipients.length) {
      return err(
        'invalid_input',
        parsed.invalid.length
          ? `No valid email addresses found. Check: ${parsed.invalid.slice(0, 3).join(', ')}`
          : 'Paste at least one email address.',
      );
    }
    const emails = parsed.recipients.map((r) => r.email);
    const known = new Map<string, CrmRecord>();
    for (const group of chunk(emails, 100)) {
      const people = await store.list('crm_records', organizationId, {
        eq: { kind: 'person' },
        arrayOverlaps: { emails: group },
      });
      for (const p of people) for (const e of p.emails) known.set(e.toLowerCase(), p);
    }
    const companies = await companiesByDomain(store, organizationId, emails);
    const candidates: RecipientCandidate[] = parsed.recipients.map((r) => {
      const person = known.get(r.email);
      return {
        email: r.email,
        name: r.name ?? person?.name ?? null,
        company: companies.get(corporateEmailDomain(r.email) ?? '') ?? null,
        record_id: person?.id ?? null,
      };
    });
    return addCandidates(store, organizationId, campaign, candidates, {
      duplicates: parsed.duplicates,
      noEmail: 0,
      invalid: parsed.invalid,
    });
  });
}

export async function removeRecipients(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  input: { ids?: readonly string[]; all?: boolean },
): Promise<Result<{ removed: number; total: number }>> {
  return guard('write', 'remove recipients', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    let removed = 0;
    if (input.all) {
      removed = await store.removeWhere('campaign_recipients', organizationId, {
        eq: { campaign_id: campaign.id },
      });
    } else {
      const ids = (input.ids ?? []).filter(isUuid);
      for (const group of chunk(ids, 100)) {
        removed += await store.removeWhere('campaign_recipients', organizationId, {
          eq: { campaign_id: campaign.id },
          in: { id: group },
        });
      }
    }
    if (removed && !(await touchDraft(store, organizationId, campaign))) {
      // Confirmed while they were being taken off: fewer people get it than
      // the review counted, never more.
      return err(
        'conflict',
        'The campaign was started while these people were being removed, so they will not get it. Its report shows who did.',
      );
    }
    const total = await store.count('campaign_recipients', organizationId, {
      eq: { campaign_id: campaign.id },
    });
    return ok({ removed, total });
  });
}

/* ------------------------------------------------------------- attachments */

/** Extensions Gmail refuses to send, so a campaign refuses them up front. */
const BLOCKED_EXTENSIONS = new Set(
  'ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpkg dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll'.split(
    ' ',
  ),
);

export interface AttachmentChunk {
  /** One id per file, chosen by the page; the parts of one file share it. */
  uploadId: string;
  index: number;
  count: number;
  name: string;
  type: string;
  /** The whole file's size in bytes. */
  size: number;
}

function cleanFilename(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f"\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'attachment'
  );
}

async function removeParts(storage: StorageProvider, parts: readonly string[]) {
  for (const part of parts) {
    const removed = await storage.remove(part);
    if (!removed.ok) log.warn('Campaign attachment part could not be removed', {});
  }
}

const partPath = (organizationId: string, campaignId: string, uploadId: string, index: number) =>
  `campaigns/${organizationId}/${campaignId}/${uploadId}/${index}`;

/** Tries at a compare-and-set on a draft's attachments before giving up. */
const ATTACHMENT_WRITE_TRIES = 5;

/**
 * One piece of an attachment. Pieces arrive in order; the file is added to
 * the campaign when its last piece lands and the pieces add up to its size —
 * and only if the campaign is still a draft at that moment. A file that
 * finishes after the tap on Send is thrown away: every email carries exactly
 * the attachments its review showed.
 */
export async function addAttachmentChunk(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  campaignId: string,
  meta: AttachmentChunk,
  bytes: Uint8Array,
): Promise<Result<{ complete: boolean; attachments: CampaignAttachment[] }>> {
  return guard<{ complete: boolean; attachments: CampaignAttachment[] }>(
    'write',
    'upload a campaign attachment',
    async () => {
      const campaign = await loadCampaign(store, organizationId, campaignId);
      if (!campaign) return NOT_FOUND();
      if (campaign.status !== 'draft') return NOT_DRAFT();
      if (!isUuid(meta.uploadId)) return err('invalid_input', 'That upload is not valid.');
      const name = cleanFilename(meta.name);
      const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
      if (BLOCKED_EXTENSIONS.has(extension)) {
        return err('unsupported_media_type', `Gmail does not send .${extension} files.`);
      }
      const maxParts = Math.ceil(MAX_ATTACHMENT_BYTES / UPLOAD_CHUNK_BYTES) + 1;
      if (
        !Number.isInteger(meta.count) ||
        !Number.isInteger(meta.index) ||
        meta.count < 1 ||
        meta.count > maxParts ||
        meta.index < 0 ||
        meta.index >= meta.count
      ) {
        return err('invalid_input', 'That upload is not valid.');
      }
      if (bytes.byteLength === 0) return err('invalid_input', 'That file is empty.');
      if (bytes.byteLength > UPLOAD_CHUNK_BYTES)
        return err('too_large', 'That piece is too large.');
      const tooBig = (used: number) =>
        err(
          'too_large',
          `Attachments can be ${formatBytes(MAX_ATTACHMENT_BYTES)} together; this would make ${formatBytes(used + Math.max(0, meta.size))}.`,
        );
      const used = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
      if (
        !Number.isFinite(meta.size) ||
        meta.size <= 0 ||
        used + meta.size > MAX_ATTACHMENT_BYTES
      ) {
        return tooBig(used);
      }
      const tooMany = () =>
        err('invalid_input', `A campaign can carry ${MAX_ATTACHMENTS} attachments at most.`);
      if (campaign.attachments.length >= MAX_ATTACHMENTS) return tooMany();

      const path = partPath(organizationId, campaign.id, meta.uploadId, meta.index);
      const put = await storage.put(path, bytes, meta.type || 'application/octet-stream');
      if (!put.ok) return put;
      if (meta.index < meta.count - 1)
        return ok({ complete: false, attachments: campaign.attachments });

      const parts = Array.from({ length: meta.count }, (_, i) =>
        partPath(organizationId, campaign.id, meta.uploadId, i),
      );
      let total = 0;
      for (const part of parts) {
        const data = await storage.get(part);
        if (!data.ok) {
          await removeParts(storage, parts);
          return err('invalid_input', `${name} did not upload completely. Add it again.`);
        }
        total += data.value.byteLength;
      }
      if (total !== meta.size) {
        await removeParts(storage, parts);
        return err('invalid_input', `${name} did not upload completely. Add it again.`);
      }

      // Write only onto the version just read, and only while it is a draft:
      // another file may have finished meanwhile (then read again and retry),
      // or the campaign may have been confirmed (then this file never joins).
      for (let attempt = 0; attempt < ATTACHMENT_WRITE_TRIES; attempt++) {
        const latest = await loadCampaign(store, organizationId, campaign.id);
        if (!latest || latest.status !== 'draft') {
          await removeParts(storage, parts);
          return latest ? NOT_DRAFT() : NOT_FOUND();
        }
        const others = latest.attachments.filter((a) => a.id !== meta.uploadId);
        const usedNow = others.reduce((sum, a) => sum + a.size, 0);
        if (usedNow + meta.size > MAX_ATTACHMENT_BYTES || others.length >= MAX_ATTACHMENTS) {
          await removeParts(storage, parts);
          return others.length >= MAX_ATTACHMENTS ? tooMany() : tooBig(usedNow);
        }
        const attachments: CampaignAttachment[] = [
          ...others,
          {
            id: meta.uploadId,
            name,
            type: (meta.type || 'application/octet-stream').slice(0, 200),
            size: meta.size,
            parts,
          },
        ];
        const [updated] = await store.updateWhere(
          'campaigns',
          organizationId,
          { eq: { id: latest.id, status: 'draft', updated_at: latest.updated_at } },
          { attachments, updated_at: nextVersion(latest) },
        );
        if (updated) return ok({ complete: true, attachments: updated.attachments });
      }
      await removeParts(storage, parts);
      return err(
        'conflict',
        `${name} could not be added just now: the campaign kept changing. Add it again.`,
        { retryable: true },
      );
    },
  );
}

export async function removeAttachment(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  campaignId: string,
  attachmentId: string,
): Promise<Result<CampaignAttachment[]>> {
  return guard('write', 'remove a campaign attachment', async () => {
    for (let attempt = 0; attempt < ATTACHMENT_WRITE_TRIES; attempt++) {
      const campaign = await loadCampaign(store, organizationId, campaignId);
      if (!campaign) return NOT_FOUND();
      if (campaign.status !== 'draft') return NOT_DRAFT();
      const attachment = campaign.attachments.find((a) => a.id === attachmentId);
      if (!attachment) return err('not_found', 'That attachment is not on this campaign.');
      // Off the campaign first, and only while it is a draft; the stored
      // pieces go only after that, so a removal racing the tap on Send can
      // never delete a file the reviewed campaign still carries.
      const [updated] = await store.updateWhere(
        'campaigns',
        organizationId,
        { eq: { id: campaign.id, status: 'draft', updated_at: campaign.updated_at } },
        {
          attachments: campaign.attachments.filter((a) => a.id !== attachmentId),
          updated_at: nextVersion(campaign),
        },
      );
      if (!updated) continue;
      await removeParts(storage, attachment.parts);
      return ok(updated.attachments);
    }
    return draftConflict(store, organizationId, campaignId);
  });
}

async function loadAttachments(
  storage: StorageProvider,
  attachments: readonly CampaignAttachment[],
): Promise<Result<OutgoingCampaignEmail['attachments']>> {
  const out: OutgoingCampaignEmail['attachments'] = [];
  for (const a of attachments) {
    const pieces: Uint8Array[] = [];
    for (const part of a.parts) {
      const data = await storage.get(part);
      if (!data.ok) {
        return err(
          'provider_unavailable',
          `${a.name} could not be read from storage, so nothing was sent.`,
          {
            retryable: true,
          },
        );
      }
      pieces.push(data.value);
    }
    const data = Buffer.concat(pieces.map((p) => Buffer.from(p)));
    if (data.byteLength !== a.size) {
      return err('internal', `${a.name} is incomplete in storage, so nothing was sent.`);
    }
    out.push({ filename: a.name, mimeType: a.type, data });
  }
  return ok(out);
}

/* ----------------------------------------------------------------- compose */

/** The recipient's merge values, with their name filled in from the row when merge lacks it. */
function mergeFor(r: Pick<CampaignRecipient, 'merge' | 'name'>): CampaignMerge {
  return { ...(r.name && !r.merge?.name ? { name: r.name } : {}), ...(r.merge ?? {}) };
}

/** `"Jane Doe" <jane@example.com>` for a To header, RFC 2047-encoded when the name is not ASCII. */
export function formatAddress(name: string | null | undefined, email: string): string {
  const clean = (name ?? '')
    .replace(/["\\<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || clean.includes('@')) return email;
  if (/^[\x20-\x7e]+$/.test(clean)) return `"${clean}" <${email}>`;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?= <${email}>`;
}

/**
 * One recipient's email, exactly as it goes out: merge fields filled, the
 * signature, and, as the campaign's switches say, tracked links and the open
 * pixel (`track_activity`) and the small unsubscribe line with its
 * List-Unsubscribe header (`unsubscribe_link`). With both off, or no URLs,
 * the email is a plain personal one: links as written, nothing of Copilot's.
 * A link whose text is itself an address is never rewritten (template.ts).
 * Exported for tests.
 */
export function composeCampaignEmail(
  campaign: Pick<Campaign, 'subject' | 'body_template' | 'track_activity' | 'unsubscribe_link'>,
  recipient: Pick<CampaignRecipient, 'email' | 'name' | 'merge'>,
  options: {
    signatureHtml: string;
    urls: TrackingUrls | null;
    parsed?: ParsedTemplate;
    attachments?: OutgoingCampaignEmail['attachments'];
    subjectPrefix?: string;
  },
): OutgoingCampaignEmail {
  const parsed = options.parsed ?? parseTemplate(campaign.body_template);
  const merge = mergeFor(recipient);
  const tracking = campaign.track_activity ? options.urls : null;
  const unsubscribe = campaign.unsubscribe_link ? (options.urls?.unsubscribe ?? null) : null;
  const subject = `${options.subjectPrefix ?? ''}${renderSubject(campaign.subject, merge) || '(no subject)'}`;
  const bodyHtml = renderHtml(parsed.blocks, { merge, trackHref: tracking?.click });
  const bodyText = renderText(parsed.blocks, { merge });
  const footerHtml = unsubscribe
    ? `<div style="margin-top:24px;font-size:12px;color:#888888">If you would rather not get these emails, <a href="${escapeHtml(unsubscribe)}" target="_blank" style="color:#888888">unsubscribe</a>.</div>`
    : '';
  const pixel = tracking
    ? `<img src="${escapeHtml(tracking.open)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    : '';
  const html = `<div dir="ltr">${bodyHtml}<br><div class="gmail_signature">${options.signatureHtml}</div>${footerHtml}${pixel}</div>`;
  const signatureText = htmlToPlainText(options.signatureHtml);
  const text = [
    bodyText,
    signatureText ? `--\n${signatureText}` : '',
    unsubscribe ? `Unsubscribe: ${unsubscribe}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    to: formatAddress(recipient.name, recipient.email),
    subject,
    html,
    text,
    attachments: options.attachments ?? [],
    listUnsubscribe: unsubscribe,
  };
}

/* ------------------------------------------------------------------ review */

export interface CampaignReview {
  campaign: Campaign;
  /** Recipients who will be sent to. */
  recipientCount: number;
  /** Problems that stop the send. Empty means it can be confirmed. */
  issues: string[];
  /** Merge fields some recipients have no value for, and how many: they see the fallback. */
  fallbacks: { field: MergeField; count: number }[];
  attachmentBytes: number;
  /** Echoed back by the confirmation, which refuses if anything changed since. */
  version: string;
}

export interface ReviewOptions {
  /**
   * The public origin for Copilot links (APP_URL), or null when it is local:
   * then a campaign with tracking or the unsubscribe line on cannot go.
   * Undefined skips that check.
   */
  appUrl?: string | null;
}

/** What the review screen shows and the confirmation checks, from the saved campaign. */
export function reviewIssues(
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  options: ReviewOptions = {},
): Omit<CampaignReview, 'campaign' | 'version'> {
  const issues: string[] = [];
  const pending = recipients.filter((r) => r.status === 'pending');
  if (!pending.length) issues.push('Add at least one recipient.');
  if (pending.length > MAX_RECIPIENTS) {
    issues.push(`A campaign can go to ${MAX_RECIPIENTS} people at most.`);
  }
  if (!campaign.subject.trim()) issues.push('Write a subject.');
  issues.push(...subjectIssues(campaign.subject));
  if (!campaign.body_template.trim()) issues.push('Write the email.');
  const parsed = parseTemplate(campaign.body_template);
  issues.push(...parsed.issues);
  const attachmentBytes = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    issues.push(`Attachments are over ${formatBytes(MAX_ATTACHMENT_BYTES)} together.`);
  }
  if (options.appUrl === null && usesAppLinks(campaign)) issues.push(LOCAL_ORIGIN_MESSAGE);
  const used = mergeFieldsUsed(campaign.subject, campaign.body_template);
  const fallbacks = used
    .map((field) => ({
      field,
      count: pending.filter((r) => missingMergeFields([field], mergeFor(r)).length > 0).length,
    }))
    .filter((f) => f.count > 0);
  return { recipientCount: pending.length, issues, fallbacks, attachmentBytes };
}

export async function reviewCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  options: ReviewOptions = {},
): Promise<Result<CampaignReview>> {
  return guard('read', 'review a campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const recipients = await recipientsOf(store, organizationId, campaign.id);
    return ok({
      campaign,
      version: campaign.updated_at,
      ...reviewIssues(campaign, recipients, options),
    });
  });
}

/* ----------------------------------------------------------------- confirm */

export interface ConfirmExpectation {
  /** The campaign's `updated_at` as the review screen read it. */
  version: string;
  recipients: number;
  subject: string;
  from: CampaignFromIdentity;
  /** Whether the review showed tracking on. */
  track: boolean;
  /** Whether the review showed the unsubscribe line on. */
  unsubscribe: boolean;
}

/**
 * The one tap: move a draft to 'sending' — only if it is exactly what the
 * review showed (same version, count, subject, signature and switches) and has
 * nothing left to fix. The move itself is a compare-and-set on the version, so
 * an edit that lands between the check and the move makes it refuse. Sends
 * nothing itself; the page then asks for batches.
 */
export async function confirmCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  actor: CampaignActor,
  expected: ConfirmExpectation,
  options: ReviewOptions = {},
): Promise<Result<Campaign>> {
  return guard('write', 'confirm a campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') {
      return err('conflict', 'This campaign was already started.');
    }
    const recipients = await recipientsOf(store, organizationId, campaign.id);
    const review = reviewIssues(campaign, recipients, options);
    if (review.issues.length) return err('invalid_input', review.issues[0] as string);
    const stale = () =>
      err('conflict', 'The campaign changed since this review. Look it over again before sending.');
    const changed =
      Date.parse(expected.version) !== Date.parse(campaign.updated_at) ||
      expected.recipients !== review.recipientCount ||
      expected.subject !== campaign.subject ||
      expected.from !== campaign.from_identity ||
      expected.track !== campaign.track_activity ||
      expected.unsubscribe !== campaign.unsubscribe_link;
    if (changed) return stale();
    // Anyone who unsubscribed since they were added.
    const suppressed = await suppressedEmails(
      store,
      organizationId,
      recipients.map((r) => r.email),
    );
    if (suppressed.size) {
      for (const r of recipients.filter((x) => suppressed.has(x.email))) {
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { eq: { id: r.id, status: 'pending' } },
          { status: 'skipped', error: 'Unsubscribed' },
        );
      }
      await touchDraft(store, organizationId, campaign);
      return err(
        'conflict',
        `${suppressed.size} ${suppressed.size === 1 ? 'person has' : 'people have'} unsubscribed since being added. Review the count again before sending.`,
      );
    }
    const pending = recipients.filter((r) => r.status === 'pending');
    const through = pending.reduce<string | null>(
      (last, r) => (!last || Date.parse(r.created_at) > Date.parse(last) ? r.created_at : last),
      null,
    );
    const now = new Date().toISOString();
    const links = collectLinks(parseTemplate(campaign.body_template).blocks).filter(
      isTrackableHref,
    );
    const [updated] = await store.updateWhere(
      'campaigns',
      organizationId,
      { eq: { id: campaign.id, status: 'draft', updated_at: campaign.updated_at } },
      {
        status: 'sending',
        link_allowlist: links,
        confirmed_at: now,
        confirmed_by: actor.userId,
        confirmed_through: through,
        pause_reason: null,
        updated_at: nextVersion(campaign),
      },
    );
    if (!updated) return stale();
    await audit(store, organizationId, actor.userId, 'campaign.confirmed', campaign.id, {
      recipients: review.recipientCount,
      from: campaign.from_identity,
      attachments: campaign.attachments.length,
      tracking: campaign.track_activity,
      unsubscribe_link: campaign.unsubscribe_link,
    });
    return ok(updated);
  });
}

/* ----------------------------------------------------------------- control */

export type CampaignAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry_failed'
  /** "May have gone out", checked in Gmail Sent: it did. */
  | 'mark_sent'
  /** "May have gone out", checked in Gmail Sent: it did not, so send it. */
  | 'resend';

export interface ControlOptions {
  /** For a pause: the sending page was left rather than Pause tapped. */
  reason?: 'left';
  /** For mark_sent and resend: which "may have gone out" recipients (all of them when omitted). */
  recipientIds?: readonly string[];
}

const UNCONFIRMED_ERROR =
  'Interrupted while sending: it may have gone out. Check Sent in Gmail, then mark it sent or send it again.';

/**
 * Pause, resume, cancel, put the failed sends back in the queue, or settle
 * the "may have gone out" ones. Resume, retry and resend are taps on Send in
 * their own right: they set the campaign sending, and the page that tapped
 * them drives the batches. Every status move is a compare-and-set.
 */
export async function controlCampaign(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  actor: CampaignActor,
  action: CampaignAction,
  options: ControlOptions = {},
): Promise<Result<Campaign>> {
  return guard('write', `campaign ${action}`, async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const move = async (from: CampaignStatus[], patch: Partial<Campaign>) =>
      (
        await store.updateWhere(
          'campaigns',
          organizationId,
          { eq: { id: campaign.id }, in: { status: from } },
          patch,
        )
      )[0] ?? null;

    if (action === 'pause') {
      const reason: CampaignPauseReason = options.reason === 'left' ? 'left' : 'manual';
      const updated = await move(['sending'], { status: 'paused', pause_reason: reason });
      if (!updated) {
        // Leaving a page that was not (or no longer) sending changes nothing.
        if (reason === 'left') return ok(campaign);
        return err('conflict', 'Only a sending campaign can pause.');
      }
      await audit(store, organizationId, actor.userId, 'campaign.paused', campaign.id, { reason });
      return ok(updated);
    }
    if (action === 'resume') {
      const updated = await move(['paused'], { status: 'sending', pause_reason: null });
      if (!updated) return err('conflict', 'Only a paused campaign can resume.');
      await audit(store, organizationId, actor.userId, 'campaign.resumed', campaign.id);
      return ok(updated);
    }
    if (action === 'cancel') {
      const updated = await move(['sending', 'paused'], {
        status: 'cancelled',
        pause_reason: null,
      });
      if (!updated) {
        return err('conflict', 'Only a sending or paused campaign can be cancelled.');
      }
      const skipped = await store.updateWhere(
        'campaign_recipients',
        organizationId,
        { eq: { campaign_id: campaign.id, status: 'pending' }, isNull: ['attempted_at'] },
        { status: 'skipped', error: 'Cancelled before it was sent' },
      );
      await audit(store, organizationId, actor.userId, 'campaign.cancelled', campaign.id, {
        skipped: skipped.length,
      });
      return ok(updated);
    }
    if (campaign.status === 'draft' || campaign.status === 'cancelled') {
      return err('conflict', 'There is nothing to send again on this campaign.');
    }
    const restart = () =>
      move(['sent', 'paused', 'sending'], { status: 'sending', sent_at: null, pause_reason: null });

    if (action === 'retry_failed') {
      // Only real failures: "may have gone out" is never swept up here.
      const reset = await store.updateWhere(
        'campaign_recipients',
        organizationId,
        { eq: { campaign_id: campaign.id, status: 'failed' } },
        { status: 'pending', error: null, attempted_at: null },
      );
      if (!reset.length) return err('conflict', 'No failed sends to retry.');
      const updated = await restart();
      if (!updated) return NOT_FOUND();
      await audit(store, organizationId, actor.userId, 'campaign.retried', campaign.id, {
        recipients: reset.length,
      });
      return ok(updated);
    }

    // mark_sent / resend: the "may have gone out" recipients a person checked.
    const ids = options.recipientIds?.filter(isUuid);
    const unconfirmed = (
      await recipientsOf(store, organizationId, campaign.id, { eq: { status: 'unconfirmed' } })
    ).filter((r) => !ids || ids.includes(r.id));
    if (!unconfirmed.length) return err('conflict', 'Nobody is waiting to be checked.');
    let settled = 0;
    for (const r of unconfirmed) {
      const patch: Partial<CampaignRecipient> =
        action === 'mark_sent'
          ? { status: 'sent', sent_at: r.attempted_at ?? new Date().toISOString(), error: null }
          : { status: 'pending', attempted_at: null, error: null };
      const changed = await store.updateWhere(
        'campaign_recipients',
        organizationId,
        { eq: { id: r.id, status: 'unconfirmed' } },
        patch,
      );
      settled += changed.length;
    }
    if (action === 'mark_sent') {
      await audit(store, organizationId, actor.userId, 'campaign.marked_sent', campaign.id, {
        recipients: settled,
      });
      return ok((await loadCampaign(store, organizationId, campaign.id)) ?? campaign);
    }
    const updated = await restart();
    if (!updated) return NOT_FOUND();
    await audit(store, organizationId, actor.userId, 'campaign.resent', campaign.id, {
      recipients: settled,
    });
    return ok(updated);
  });
}

/* ----------------------------------------------------------------- sending */

export interface BatchDeps {
  sender: CampaignSender;
  storage: StorageProvider;
  /**
   * The app's public origin, for the tracking and unsubscribe links (APP_URL),
   * or null while it is a local address (route-helpers' trackingOrigin). A
   * campaign whose emails carry Copilot links refuses to send without one.
   */
  appUrl: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  batchMax?: number;
  budgetMs?: number;
  intervalMs?: number;
  dailyCap?: number;
  leaseMs?: number;
}

export type BatchState =
  /** Sent what it could; more to go. */
  | 'sending'
  /** Everyone has been sent to (or failed, or was skipped). */
  | 'done'
  /** The campaign is paused; nothing sent. */
  | 'paused'
  /** Not sending (draft, cancelled or finished). */
  | 'idle'
  /** Another batch for this organization is running right now. */
  | 'busy'
  /** The 24-hour cap is reached; the campaign paused. */
  | 'capped';

export interface BatchProgress {
  state: BatchState;
  status: CampaignStatus;
  /** Why it is paused, when it is. */
  pauseReason: CampaignPauseReason | null;
  sentNow: number;
  failedNow: number;
  counts: CampaignCounts;
  /** Something the person should read (a pause, the cap). */
  message: string | null;
  /** When the cap frees a slot, once reached. */
  capResetsAt: string | null;
  /** Emails the 24-hour cap still allows. */
  dailyRemaining: number;
}

async function capState(store: DataStore, organizationId: string, now: Date, cap: number) {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = await listAllPages(store, 'campaign_recipients', organizationId, {
    gte: { sent_at: since },
  });
  return dailyCapState(
    recent.map((r) => r.sent_at).filter((s): s is string => Boolean(s)),
    now,
    cap,
  );
}

/* The organization's send lease (see CampaignSendLock). */

interface SendLease {
  token: string;
  /** The organization's last campaign email, carried while the lease is held. */
  lastSentAt: string | null;
}

/**
 * Take the organization's send lease, or null when another batch holds it.
 * Taking it is a compare-and-set on the token the row had when read, so of
 * two batches that read the same free lease only one gets it.
 */
async function acquireSendLease(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  now: Date,
  leaseMs: number,
): Promise<SendLease | null> {
  const token = newId();
  const expires = new Date(now.getTime() + leaseMs).toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = await store.findOne('campaign_send_locks', organizationId, {});
    if (!lock) {
      try {
        await store.insert('campaign_send_locks', {
          organization_id: organizationId,
          lease_token: token,
          lease_expires_at: expires,
          campaign_id: campaignId,
          last_sent_at: null,
          updated_at: now.toISOString(),
        });
        return { token, lastSentAt: null };
      } catch (error) {
        if (isMissingTableError(error) || isMissingColumnError(error)) throw error;
        continue; // Another batch created the row first: read it again.
      }
    }
    if (lock.lease_expires_at && Date.parse(lock.lease_expires_at) > now.getTime()) return null;
    const [taken] = await store.updateWhere(
      'campaign_send_locks',
      organizationId,
      { eq: { lease_token: lock.lease_token } },
      { lease_token: token, lease_expires_at: expires, campaign_id: campaignId },
    );
    return taken ? { token, lastSentAt: taken.last_sent_at } : null;
  }
  return null;
}

/** Extend the lease before an email; false when it lapsed and someone else took it. */
async function renewSendLease(
  store: DataStore,
  organizationId: string,
  lease: SendLease,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const rows = await store.updateWhere(
    'campaign_send_locks',
    organizationId,
    { eq: { lease_token: lease.token } },
    {
      lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      last_sent_at: lease.lastSentAt,
    },
  );
  return rows.length > 0;
}

async function releaseSendLease(store: DataStore, organizationId: string, lease: SendLease) {
  await store.updateWhere(
    'campaign_send_locks',
    organizationId,
    { eq: { lease_token: lease.token } },
    { lease_expires_at: null, last_sent_at: lease.lastSentAt },
  );
}

/**
 * Send the next few emails of a confirmed campaign: at most `batchMax`, about
 * one every `intervalMs`, and none started after `budgetMs`, so one request
 * always finishes well inside the host's limits. The page calls this again
 * while it stays open and the campaign is sending.
 */
export async function sendBatch(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  deps: BatchDeps,
): Promise<Result<BatchProgress>> {
  return guard('write', 'send a campaign batch', async () => {
    const now = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? defaultSleep;
    const batchMax = deps.batchMax ?? BATCH_MAX;
    const budgetMs = deps.budgetMs ?? BATCH_BUDGET_MS;
    const intervalMs = deps.intervalMs ?? SEND_INTERVAL_MS;
    const cap = deps.dailyCap ?? DAILY_CAP;
    const leaseMs = deps.leaseMs ?? SEND_LEASE_MS;

    let campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const initial = campaign;

    const progress = async (
      state: BatchState,
      extra: Partial<BatchProgress> = {},
    ): Promise<BatchProgress> => {
      const fresh = (await loadCampaign(store, organizationId, campaignId)) ?? initial;
      const counts = countRecipients(await recipientsOf(store, organizationId, campaignId));
      const capNow = await capState(store, organizationId, now(), cap);
      return {
        state,
        status: fresh.status,
        pauseReason: fresh.status === 'paused' ? fresh.pause_reason : null,
        sentNow: 0,
        failedNow: 0,
        counts,
        message: null,
        capResetsAt: capNow.resetsAt,
        dailyRemaining: capNow.remaining,
        ...extra,
      };
    };

    /** Done when nobody is left waiting; otherwise where it stands. */
    const finish = async (sentNow = 0, failedNow = 0, message: string | null = null) => {
      const left = await store.count('campaign_recipients', organizationId, {
        eq: { campaign_id: campaignId, status: 'pending' },
      });
      const current = await loadCampaign(store, organizationId, campaignId);
      if (left === 0 && current?.status === 'sending') {
        await store.updateWhere(
          'campaigns',
          organizationId,
          { eq: { id: campaignId, status: 'sending' } },
          { status: 'sent', sent_at: now().toISOString() },
        );
        return progress('done', { sentNow, failedNow, message });
      }
      const state: BatchState =
        current?.status === 'paused'
          ? 'paused'
          : current?.status === 'sending'
            ? 'sending'
            : 'idle';
      return progress(state, { sentNow, failedNow, message });
    };

    const pauseFor = (reason: CampaignPauseReason) =>
      store.updateWhere(
        'campaigns',
        organizationId,
        { eq: { id: campaignId, status: 'sending' } },
        { status: 'paused', pause_reason: reason },
      );

    if (campaign.status !== 'sending') {
      return ok(await progress(campaign.status === 'paused' ? 'paused' : 'idle'));
    }
    if (usesAppLinks(campaign) && !deps.appUrl) {
      return err('not_configured', LOCAL_ORIGIN_MESSAGE);
    }
    // Two locks: this process's set (cheap, and enough for the demo store),
    // then the organization's lease in the database, which holds across
    // server instances (a second tab landing on another one, a deploy).
    if (sending.has(organizationId)) return ok(await progress('busy'));
    sending.add(organizationId);
    let lease: SendLease | null = null;
    try {
      lease = await acquireSendLease(store, organizationId, campaign.id, now(), leaseMs);
      if (!lease) return ok(await progress('busy'));
      const started = Date.now();

      // An attempt that never finished: it may have gone out, so it is
      // reported rather than sent again. A recent one may still be finishing
      // in a batch whose lease lapsed, so wait for it.
      const attempted = await recipientsOf(store, organizationId, campaign.id, {
        eq: { status: 'pending' },
        notNull: ['attempted_at'],
      });
      let inFlight = false;
      for (const r of attempted) {
        if (now().getTime() - Date.parse(r.attempted_at as string) < INTERRUPTED_AFTER_MS) {
          inFlight = true;
          continue;
        }
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { eq: { id: r.id, status: 'pending' } },
          { status: 'unconfirmed', error: UNCONFIRMED_ERROR },
        );
      }
      if (inFlight) return ok(await progress('busy'));

      // Anyone added after the review that confirmed it (a second tab racing
      // the tap) never goes.
      const through = campaign.confirmed_through;
      if (through) {
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          {
            eq: { campaign_id: campaign.id, status: 'pending' },
            isNull: ['attempted_at'],
            gt: { created_at: through },
          },
          { status: 'skipped', error: 'Added after the review was confirmed, so not sent.' },
        );
      }

      // Read once per batch: while this batch holds the lease nothing else
      // in the organization sends, so the count stays true.
      const capNow = await capState(store, organizationId, now(), cap);
      if (capNow.remaining <= 0) {
        await pauseFor('capped');
        return ok(
          await progress('capped', {
            message: `Daily limit reached: ${cap} emails in the last 24 hours. The campaign paused; resume once the next slot opens.`,
          }),
        );
      }

      const queue = await store.list(
        'campaign_recipients',
        organizationId,
        {
          eq: { campaign_id: campaign.id, status: 'pending' },
          isNull: ['attempted_at'],
          ...(through ? { lte: { created_at: through } } : {}),
        },
        {
          orderBy: [
            { field: 'created_at', direction: 'asc' },
            { field: 'id', direction: 'asc' },
          ],
          limit: Math.min(batchMax, capNow.remaining),
        },
      );
      if (!queue.length) return ok(await finish());

      const signatureHtml = await deps.sender.signature(campaign.from_identity);
      if (!signatureHtml) {
        return err(
          'provider_unavailable',
          "Couldn't read Nick's signature from Gmail, so nothing was sent. Try again in a minute.",
          { retryable: true },
        );
      }
      const attachments = await loadAttachments(deps.storage, campaign.attachments);
      if (!attachments.ok) return attachments;
      const parsed = parseTemplate(campaign.body_template);
      const urlsFor = (recipientId: string): TrackingUrls | null =>
        campaign && usesAppLinks(campaign) && deps.appUrl
          ? trackingUrls(deps.appUrl, { organizationId, recipientId })
          : null;
      try {
        urlsFor((queue[0] as CampaignRecipient).id);
      } catch {
        return err(
          'not_configured',
          'Tracking links need SESSION_SECRET (at least 32 characters) set on the server, so nothing was sent.',
        );
      }

      const suppressed = await suppressedEmails(
        store,
        organizationId,
        queue.map((r) => r.email),
      );

      let sentNow = 0;
      let failedNow = 0;
      let failuresInARow = 0;
      let message: string | null = null;
      for (const recipient of queue) {
        if (suppressed.has(recipient.email)) {
          await store.updateWhere(
            'campaign_recipients',
            organizationId,
            { eq: { id: recipient.id, status: 'pending' }, isNull: ['attempted_at'] },
            { status: 'skipped', error: 'Unsubscribed' },
          );
          continue;
        }
        if (Date.now() - started > budgetMs) break;
        // A pause or cancel tapped mid-batch stops it before the next email.
        campaign = await loadCampaign(store, organizationId, campaignId);
        if (!campaign || campaign.status !== 'sending') break;

        const wait = Math.max(
          waitBeforeNext(campaign.last_sent_at, now().getTime(), intervalMs),
          waitBeforeNext(lease.lastSentAt, now().getTime(), intervalMs),
        );
        if (wait > 0) await sleep(wait);

        // Built before the attempt is marked, so a failure here leaves the
        // recipient cleanly unsent rather than "may have gone out".
        const email = composeCampaignEmail(campaign, recipient, {
          signatureHtml,
          urls: urlsFor(recipient.id),
          parsed,
          attachments: attachments.value,
        });
        // Still the organization's sender? A batch that stalled past its
        // lease stops here instead of sending alongside the one that took over.
        if (!(await renewSendLease(store, organizationId, lease, now(), leaseMs))) {
          lease = null;
          message = 'Another window took over sending this campaign.';
          break;
        }
        // Claim the recipient: only one batch can turn attempted_at from
        // empty to a time, so nobody is sent the same email twice.
        const [claimed] = await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { eq: { id: recipient.id, status: 'pending' }, isNull: ['attempted_at'] },
          { attempted_at: now().toISOString() },
        );
        if (!claimed) continue;
        const result = await deps.sender.send(email);
        const at = now().toISOString();
        lease.lastSentAt = at;
        await store.update('campaigns', organizationId, campaignId, { last_sent_at: at });

        if (result.ok) {
          sentNow += 1;
          failuresInARow = 0;
          await store.update('campaign_recipients', organizationId, recipient.id, {
            status: 'sent',
            sent_at: at,
            gmail_message_id: result.value.messageId,
            gmail_thread_id: result.value.threadId,
            error: null,
          });
          continue;
        }

        failedNow += 1;
        failuresInARow += 1;
        await store.update('campaign_recipients', organizationId, recipient.id, {
          status: 'failed',
          error: result.error.message.slice(0, 500),
        });
        const refused =
          result.error.code === 'provider_unauthorized' || result.error.code === 'forbidden';
        if (refused || failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
          await pauseFor(refused ? 'refused' : 'failures');
          message = refused
            ? 'Gmail refused to send, so the campaign paused. Sending may need to be turned on again in Settings.'
            : `${MAX_CONSECUTIVE_FAILURES} emails in a row did not send, so the campaign paused. Check the errors, then resume.`;
          log.warn('Campaign paused after send failures', {
            campaignId,
            code: result.error.code,
          });
          break;
        }
      }
      return ok(await finish(sentNow, failedNow, message));
    } finally {
      if (lease) {
        try {
          await releaseSendLease(store, organizationId, lease);
        } catch {
          // It expires on its own.
          log.warn('Campaign send lease could not be released', {});
        }
      }
      sending.delete(organizationId);
    }
  });
}

/**
 * "Send test to me": the email as one recipient would get it (the first on
 * the list, or nobody's merge values), to the signed-in person, marked
 * [Test]. Its links and pixel are the real tracked ones, on a token that
 * names the campaign rather than a recipient: they go through Copilot exactly
 * as the real email's do (so the test proves APP_URL works from outside) and
 * record nothing.
 */
export async function sendTest(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  deps: Pick<BatchDeps, 'sender' | 'storage' | 'appUrl'> & {
    to: string;
    actor: CampaignActor;
    recipientId?: string | null;
  },
): Promise<Result<{ to: string; as: string | null }>> {
  return guard('write', 'send a campaign test', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const to = normalizeEmail(deps.to);
    if (!isEmail(to)) return err('invalid_input', 'Your account has no email address to send to.');
    const issues = [
      ...subjectIssues(campaign.subject),
      ...parseTemplate(campaign.body_template).issues,
    ];
    if (!campaign.body_template.trim()) issues.unshift('Write the email first.');
    if (usesAppLinks(campaign) && !deps.appUrl) issues.push(LOCAL_ORIGIN_MESSAGE);
    if (issues.length) return err('invalid_input', issues[0] as string);
    let urls: TrackingUrls | null = null;
    if (usesAppLinks(campaign) && deps.appUrl) {
      try {
        urls = testTrackingUrls(deps.appUrl, { organizationId, campaignId: campaign.id });
      } catch {
        return err(
          'not_configured',
          'Tracking links need SESSION_SECRET (at least 32 characters) set on the server, so the test was not sent.',
        );
      }
    }
    const sample =
      (deps.recipientId && isUuid(deps.recipientId)
        ? await store.findOne('campaign_recipients', organizationId, {
            eq: { id: deps.recipientId, campaign_id: campaign.id },
          })
        : null) ??
      (
        await store.list(
          'campaign_recipients',
          organizationId,
          { eq: { campaign_id: campaign.id } },
          { orderBy: [...RECIPIENT_ORDER, { field: 'id', direction: 'asc' }], limit: 1 },
        )
      )[0] ??
      null;
    const signatureHtml = await deps.sender.signature(campaign.from_identity);
    if (!signatureHtml) {
      return err(
        'provider_unavailable',
        "Couldn't read Nick's signature from Gmail, so the test was not sent. Try again, or sign as Arwin.",
        { retryable: true },
      );
    }
    const attachments = await loadAttachments(deps.storage, campaign.attachments);
    if (!attachments.ok) return attachments;
    const email = composeCampaignEmail(
      campaign,
      { email: to, name: sample?.name ?? null, merge: sample?.merge ?? {} },
      {
        signatureHtml,
        urls,
        attachments: attachments.value,
        subjectPrefix: '[Test] ',
      },
    );
    const sent = await deps.sender.send({ ...email, to });
    if (!sent.ok) return sent;
    await audit(store, organizationId, deps.actor.userId, 'campaign.test_sent', campaign.id, {
      as_recipient: Boolean(sample),
    });
    return ok({ to, as: sample?.email ?? null });
  });
}

/* ---------------------------------------------------------------- tracking */

/** Events kept per recipient; past this only the counter moves. */
const MAX_EVENTS_PER_RECIPIENT = 100;
/** Machine opens and clicks kept per recipient, for the record. */
const MAX_AUTOMATED_EVENTS = 20;

/** What a tracking request looked like, for telling a person from a machine (activity.ts). */
export interface TrackingSignal {
  userAgent?: string | null;
  /** A HEAD request: a link checker, never a person. */
  head?: boolean;
  /** Marked as a prefetch by its headers. */
  prefetch?: boolean;
  /** For tests. */
  now?: Date;
}

function clipAgent(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? '').trim();
  return ua ? ua.slice(0, 500) : null;
}

async function addEvent(
  store: DataStore,
  recipient: CampaignRecipient,
  kind: CampaignEventKind,
  extra: Partial<CampaignEvent> = {},
) {
  const event: CampaignEvent = {
    id: newId(),
    organization_id: recipient.organization_id,
    campaign_id: recipient.campaign_id,
    recipient_id: recipient.id,
    kind,
    url: null,
    email: null,
    at: new Date().toISOString(),
    user_agent: null,
    automated: false,
    ...extra,
  };
  await store.insert('campaign_events', event);
}

/** Keep a machine's open or click for the record, up to a few per recipient. */
async function addAutomatedEvent(
  store: DataStore,
  recipient: CampaignRecipient,
  kind: 'open' | 'click',
  extra: Partial<CampaignEvent>,
) {
  const kept = await store.count('campaign_events', recipient.organization_id, {
    eq: { recipient_id: recipient.id, automated: true },
  });
  if (kept < MAX_AUTOMATED_EVENTS)
    await addEvent(store, recipient, kind, { ...extra, automated: true });
}

async function trackedRecipient(
  store: DataStore,
  target: TrackingTarget,
): Promise<CampaignRecipient | null> {
  const recipient = await store.get(
    'campaign_recipients',
    target.organizationId,
    target.recipientId,
  );
  return recipient && recipient.status === 'sent' ? recipient : null;
}

/**
 * The pixel loaded. Counted as an open unless it looks like a machine: a
 * prefetch, a scanner's user agent, or within the first minute after the
 * send (a mail filter on delivery). Never fails toward the caller: the gif is
 * served whatever happens. Ok(true) when it counted.
 */
export async function recordOpen(
  store: DataStore,
  target: TrackingTarget,
  signal: TrackingSignal = {},
): Promise<Result<boolean>> {
  return guard('write', 'record an open', async () => {
    const r = await trackedRecipient(store, target);
    if (!r) return ok(false);
    const now = signal.now ?? new Date();
    const at = now.toISOString();
    const userAgent = clipAgent(signal.userAgent);
    if (
      signal.head ||
      signal.prefetch ||
      isAutomatedAgent(signal.userAgent) ||
      withinScanWindow(r.sent_at, now)
    ) {
      await addAutomatedEvent(store, r, 'open', { at, user_agent: userAgent });
      return ok(false);
    }
    await store.update('campaign_recipients', target.organizationId, r.id, {
      opened_at: r.opened_at ?? at,
      open_count: r.open_count + 1,
    });
    if (r.open_count < MAX_EVENTS_PER_RECIPIENT) {
      await addEvent(store, r, 'open', { at, user_agent: userAgent });
    }
    return ok(true);
  });
}

/**
 * A recipient's clicks again, from their events, after some turned out to be
 * a scanner's: the counter loses those, and an open that only those clicks
 * implied goes too.
 */
async function undoBurst(store: DataStore, r: CampaignRecipient, since: string) {
  const undone = await store.updateWhere(
    'campaign_events',
    r.organization_id,
    { eq: { recipient_id: r.id, kind: 'click', automated: false }, gte: { at: since } },
    { automated: true },
  );
  if (!undone.length) return;
  const fresh = (await store.get('campaign_recipients', r.organization_id, r.id)) ?? r;
  const human = await store.list(
    'campaign_events',
    r.organization_id,
    { eq: { recipient_id: r.id, kind: 'click', automated: false } },
    { orderBy: [{ field: 'at', direction: 'asc' }], limit: 1 },
  );
  const clickCount = Math.max(0, fresh.click_count - undone.length);
  const clickedAt = clickCount > 0 ? (human[0]?.at ?? fresh.clicked_at) : null;
  await store.update('campaign_recipients', r.organization_id, r.id, {
    click_count: clickCount,
    clicked_at: clickedAt,
    opened_at: fresh.open_count > 0 ? fresh.opened_at : clickedAt,
  });
}

/**
 * A tracked link was clicked. Returns where to send them — only ever a link
 * that was in the campaign's body when it was confirmed, so the redirect can
 * never be pointed somewhere else by editing the URL. The redirect happens
 * whoever asks; it counts as the person's click only when it does not look
 * like a mail scanner (see activity.ts): not a HEAD or prefetch, not a
 * scanner's user agent, not in the first minute after the send, and not a
 * second link a few seconds after the first (then the first is undone too).
 */
export async function recordClick(
  store: DataStore,
  target: TrackingTarget,
  url: string,
  signal: TrackingSignal = {},
): Promise<Result<string>> {
  return guard('write', 'record a click', async () => {
    const r = await store.get('campaign_recipients', target.organizationId, target.recipientId);
    if (!r) return err('not_found', 'That link is not valid.');
    const campaign = await store.get('campaigns', target.organizationId, r.campaign_id);
    if (!campaign || !campaign.link_allowlist.includes(url) || !isTrackableHref(url)) {
      return err('not_found', 'That link is not valid.');
    }
    if (r.status !== 'sent') return ok(url);
    const now = signal.now ?? new Date();
    const at = now.toISOString();
    const userAgent = clipAgent(signal.userAgent);
    let automated =
      Boolean(signal.head || signal.prefetch) ||
      isAutomatedAgent(signal.userAgent) ||
      withinScanWindow(r.sent_at, now);
    const since = new Date(now.getTime() - CLICK_BURST_MS).toISOString();
    let burst = false;
    if (!automated) {
      const recent = await store.list('campaign_events', target.organizationId, {
        eq: { recipient_id: r.id, kind: 'click', automated: false },
        gte: { at: since },
      });
      burst = recent.some((e) => e.url !== url);
      automated = burst;
    }
    if (automated) {
      await addAutomatedEvent(store, r, 'click', { at, url, user_agent: userAgent });
      if (burst) await undoBurst(store, r, since);
      return ok(url);
    }
    await store.update('campaign_recipients', target.organizationId, r.id, {
      clicked_at: r.clicked_at ?? at,
      click_count: r.click_count + 1,
      // A click is an open, even when the pixel was blocked.
      opened_at: r.opened_at ?? at,
    });
    if (r.click_count < MAX_EVENTS_PER_RECIPIENT) {
      await addEvent(store, r, 'click', { at, url, user_agent: userAgent });
    }
    return ok(url);
  });
}

/**
 * A test email's link: where to send them (one of the campaign's own links,
 * as written now for a draft, as confirmed otherwise). Records nothing.
 */
export async function resolveTestClick(
  store: DataStore,
  target: TestTrackingTarget,
  url: string,
): Promise<Result<string>> {
  return guard('read', 'follow a test link', async () => {
    const campaign = await loadCampaign(store, target.organizationId, target.campaignId);
    if (!campaign || !isTrackableHref(url)) return err('not_found', 'That link is not valid.');
    const links =
      campaign.status === 'draft'
        ? collectLinks(parseTemplate(campaign.body_template).blocks)
        : campaign.link_allowlist;
    return links.includes(url) ? ok(url) : err('not_found', 'That link is not valid.');
  });
}

/** Mask an address for a page anyone holding the link can see: j•••@example.com. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** Who an unsubscribe link is for, masked, without changing anything. */
export async function describeUnsubscribe(
  store: DataStore,
  target: TrackingTarget,
): Promise<Result<{ email: string; already: boolean }>> {
  return guard('read', 'read an unsubscribe link', async () => {
    const r = await store.get('campaign_recipients', target.organizationId, target.recipientId);
    if (!r) return err('not_found', 'That link is not valid.');
    const suppressed = await suppressedEmails(store, target.organizationId, [r.email]);
    return ok({ email: maskEmail(r.email), already: suppressed.has(r.email) });
  });
}

/**
 * Unsubscribe the recipient's address from every campaign: an event that is
 * the suppression list, and any unsent copy waiting in another campaign is
 * skipped.
 */
export async function unsubscribe(
  store: DataStore,
  target: TrackingTarget,
  userAgent?: string | null,
): Promise<Result<{ email: string; already: boolean }>> {
  return guard('write', 'unsubscribe', async () => {
    const r = await store.get('campaign_recipients', target.organizationId, target.recipientId);
    if (!r) return err('not_found', 'That link is not valid.');
    const masked = maskEmail(r.email);
    const already = (await suppressedEmails(store, target.organizationId, [r.email])).has(r.email);
    if (!already) {
      await addEvent(store, r, 'unsubscribe', {
        email: r.email,
        user_agent: clipAgent(userAgent),
        at: await nextSuppressionAt(store, target.organizationId, r.email),
      });
      await audit(store, target.organizationId, null, 'campaign.unsubscribed', r.campaign_id);
    }
    if (!r.unsubscribed_at) {
      await store.update('campaign_recipients', target.organizationId, r.id, {
        unsubscribed_at: new Date().toISOString(),
      });
    }
    await skipWaiting(store, target.organizationId, r.email);
    return ok({ email: masked, already });
  });
}

/* ----------------------------------------------------------------- replies */

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;

/** Only the last few weeks of sends are checked; older ones have had their replies. */
const REPLY_WINDOW_DAYS = 60;

/** How far around an interrupted attempt a sent copy is looked for. */
const SENT_COPY_BEFORE_MS = 60_000;
const SENT_COPY_AFTER_MS = 15 * 60_000;

/**
 * "May have gone out" settled from the synced mailbox: a message in Sent to
 * that recipient, with that recipient's subject, sent around the attempt.
 * Found, it did go out, and the recipient is marked sent with its Gmail ids.
 */
async function settleUnconfirmed(
  store: DataStore,
  organizationId: string,
  since: string,
  campaignId?: string,
): Promise<number> {
  const unconfirmed = await listAllPages(store, 'campaign_recipients', organizationId, {
    eq: { status: 'unconfirmed', ...(campaignId ? { campaign_id: campaignId } : {}) },
    notNull: ['attempted_at'],
    gte: { attempted_at: since },
  });
  if (!unconfirmed.length) return 0;
  const campaigns = new Map(
    (
      await listWhereIn(
        store,
        'campaigns',
        organizationId,
        {},
        'id',
        unconfirmed.map((r) => r.campaign_id),
      )
    ).map((c) => [c.id, c]),
  );
  let settled = 0;
  for (const r of unconfirmed) {
    const campaign = campaigns.get(r.campaign_id);
    if (!campaign) continue;
    const attempted = Date.parse(r.attempted_at as string);
    const copies = await store.list(
      'email_messages',
      organizationId,
      {
        arrayContains: { to_addresses: r.email, labels: 'SENT' },
        gte: { sent_at: new Date(attempted - SENT_COPY_BEFORE_MS).toISOString() },
        lte: { sent_at: new Date(attempted + SENT_COPY_AFTER_MS).toISOString() },
      },
      { limit: 20 },
    );
    const subject = renderSubject(campaign.subject, mergeFor(r)) || '(no subject)';
    const copy = copies.find((m) => (m.subject ?? '').trim() === subject);
    if (!copy) continue;
    const thread = await store.get('email_threads', organizationId, copy.thread_id);
    const changed = await store.updateWhere(
      'campaign_recipients',
      organizationId,
      { eq: { id: r.id, status: 'unconfirmed' } },
      {
        status: 'sent',
        sent_at: copy.sent_at,
        gmail_message_id: copy.provider_message_id,
        gmail_thread_id: thread?.provider_thread_id ?? null,
        error: null,
      },
    );
    settled += changed.length;
  }
  return settled;
}

/**
 * Replies and bounces, read from the synced mailbox: a message in a sent
 * email's Gmail thread, after it was sent, from that recipient (a reply,
 * unless it is an automatic one such as an out-of-office) or from a mail
 * server (a bounce). Also settles "may have gone out" sends whose copy turned
 * up in Sent. Reads the mailbox only; sends nothing. Run when a campaign is
 * viewed and from the daily job.
 */
export async function checkReplies(
  store: DataStore,
  organizationId: string,
  options: { campaignId?: string; now?: Date } = {},
): Promise<
  Result<{
    checked: number;
    replies: number;
    bounces: number;
    autoReplies: number;
    settled: number;
  }>
> {
  return guard('write', 'check campaign replies', async () => {
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * DAY_MS).toISOString();
    if (options.campaignId && !isUuid(options.campaignId)) return NOT_FOUND();
    const settled = await settleUnconfirmed(store, organizationId, since, options.campaignId);
    const filter: Filter = {
      eq: { status: 'sent', ...(options.campaignId ? { campaign_id: options.campaignId } : {}) },
      notNull: ['gmail_thread_id'],
      isNull: ['replied_at', 'bounced_at'],
      gte: { sent_at: since },
    };
    const open = await listAllPages(store, 'campaign_recipients', organizationId, filter);
    const none = { checked: open.length, replies: 0, bounces: 0, autoReplies: 0, settled };
    if (!open.length) return ok(none);

    const threads = await listWhereIn(
      store,
      'email_threads',
      organizationId,
      {},
      'provider_thread_id',
      open.map((r) => r.gmail_thread_id as string),
    );
    if (!threads.length) return ok(none);
    const threadByProvider = new Map(threads.map((t) => [t.provider_thread_id, t.id]));
    const messages = await listWhereIn(
      store,
      'email_messages',
      organizationId,
      { gte: { sent_at: since } },
      'thread_id',
      threads.map((t) => t.id),
    );
    const byThread = new Map<string, typeof messages>();
    for (const m of messages) {
      const list = byThread.get(m.thread_id) ?? [];
      list.push(m);
      byThread.set(m.thread_id, list);
    }

    let replies = 0;
    let bounces = 0;
    let autoReplies = 0;
    for (const r of open) {
      const threadId = threadByProvider.get(r.gmail_thread_id as string);
      if (!threadId) continue;
      const after = (byThread.get(threadId) ?? [])
        .filter((m) => Date.parse(m.sent_at) > Date.parse(r.sent_at as string))
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      const bounce = after.find((m) => BOUNCE_SENDER.test(m.from_address));
      const fromThem = after.filter((m) => m.from_address.toLowerCase() === r.email);
      // An out-of-office is not a reply; a real one after it still counts.
      const reply = fromThem.find((m) => !isAutoReply(m, r.sent_at));
      if (!reply && fromThem.length) autoReplies += 1;
      if (bounce && (!reply || bounce.sent_at <= reply.sent_at)) {
        bounces += 1;
        await store.update('campaign_recipients', organizationId, r.id, {
          bounced_at: bounce.sent_at,
        });
        await addEvent(store, r, 'bounce', { at: bounce.sent_at });
      } else if (reply) {
        replies += 1;
        await store.update('campaign_recipients', organizationId, r.id, {
          replied_at: reply.sent_at,
        });
        await addEvent(store, r, 'reply', { at: reply.sent_at });
      }
    }
    return ok({ checked: open.length, replies, bounces, autoReplies, settled });
  });
}
