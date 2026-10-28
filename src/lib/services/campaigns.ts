import 'server-only';
import {
  CLICK_BURST_MS,
  bounceNames,
  isAutoReply,
  isAutomatedAgent,
  withinScanWindow,
} from '@/lib/campaigns/activity';
import {
  campaignAttachmentType,
  unsupportedAttachmentMessage,
} from '@/lib/campaigns/attachment-types';
import {
  NO_COPIES,
  cleanBccMode,
  cleanCopyList,
  copiesFor,
  copyCount,
  parseCopyAddresses,
  type EmailCopies,
} from '@/lib/campaigns/copies';
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
import {
  fillMerge,
  mergeValuesProblem,
  peopleMissingFields,
  type MergeValues,
  type MissingPerson,
} from '@/lib/campaigns/missing-fields';
import { checkExtras, type ExtrasCheck, type ManifestPhoto } from '@/lib/campaigns/manifest';
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  PHOTO_KIND_LABEL,
  PHOTO_MIME,
  declaredPhotoKind,
  isPhotoName,
  isPhotoType,
  photoMatcher,
  sniffPhoto,
  type PhotoKind,
  type CampaignPhotoView,
  type PhotoUploadOutcome,
} from '@/lib/campaigns/photos';
import { isEmail, normalizeEmail, parsePastedRecipients } from '@/lib/campaigns/recipients';
import type { CampaignSender, OutgoingCampaignEmail } from '@/lib/campaigns/sender-types';
import {
  collectLinks,
  escapeHtml,
  firstNameOf,
  isRsvpLinkUrl,
  isTrackableHref,
  mergeFieldsUsed,
  missingMergeFields,
  parseTemplate,
  renderHtml,
  renderSubject,
  renderText,
  rsvpLinkUsed,
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
import { personCompanyOf, statusFieldOf } from '@/lib/crm/fields';
import { isMissingColumnError, isMissingTableError } from '@/lib/db/missing-table';
import { chunk, listAllPages } from '@/lib/db/paging';
import type { DataStore, Filter, Row, TableName } from '@/lib/db/store';
import { recordAudit, type AuditAction } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { updatePersonContact, type PersonContactField } from '@/lib/services/crm';
import { eventLinkCheck, type EventLinkCheck } from '@/lib/services/event-campaign-links';
import { BUCKET_HEIC_MIGRATION_FILE } from '@/lib/storage/allowed-types';
import type { StorageProvider } from '@/lib/storage/provider';
import type {
  Campaign,
  CampaignAttachment,
  CampaignBccMode,
  CampaignEvent,
  CampaignEventKind,
  CampaignFromIdentity,
  CampaignMerge,
  CampaignPauseReason,
  CampaignPhoto,
  CampaignRecipient,
  CampaignStatus,
  CrmRecord,
  EventCampaignKind,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type ErrorCode, type Result } from '@/lib/util/result';
import { corporateEmailDomain, htmlToPlainText } from '@/lib/util/text';
import { DEFAULT_TIMEZONE, formatDate } from '@/lib/util/time';

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
 * Photos and copies (a photo per recipient, CC and BCC) are optional and off
 * by default; see "photos and copies" below. A campaign that uses neither
 * reviews, confirms and sends exactly as it did before they existed, and
 * until their migration is applied they stay hidden.
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

/** Whether a campaign's emails carry any Kraken link (and so need a public APP_URL). */
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

/** A campaign that finished sending: its name and counts, never who it went to. */
export interface FinishedCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  sentAt: string | null;
  counts: CampaignCounts;
}

/**
 * Campaigns that finished sending since `since`, newest first, as name and
 * counts only: what the phone alert says when one is done. Reads only.
 */
export async function finishedCampaignsSince(
  store: DataStore,
  organizationId: string,
  since: Date,
): Promise<Result<FinishedCampaign[]>> {
  return guard('read', 'list finished campaigns', async () => {
    const campaigns = await listAllPages(
      store,
      'campaigns',
      organizationId,
      { eq: { status: 'sent' }, gte: { sent_at: since.toISOString() } },
      [{ field: 'sent_at', direction: 'desc' }],
    );
    const out: FinishedCampaign[] = [];
    for (const c of campaigns) {
      const counts = countRecipients(await recipientsOf(store, organizationId, c.id));
      out.push({ id: c.id, name: c.name, status: c.status, sentAt: c.sent_at, counts });
    }
    return ok(out);
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

/**
 * A new draft. With no name it is called after today, "Campaign Oct 18, 2026",
 * read in the creator's profile timezone (`timeZone`): the server runs in UTC,
 * whose date has already turned over on a Central evening.
 */
export async function createCampaign(
  store: DataStore,
  organizationId: string,
  actor: CampaignActor,
  input: {
    name?: string | null;
    timeZone?: string;
    now?: Date;
    /**
     * Event messages only (D-075, lib/services/event-comms.ts): the event the
     * draft is made from. Without it the row is exactly what it always was.
     */
    event?: EventCampaignLink;
  } = {},
): Promise<Result<Campaign>> {
  return guard('write', 'create a campaign', async () => {
    const at = input.now ?? new Date();
    const now = at.toISOString();
    const name =
      (input.name ?? '').trim().slice(0, 300) ||
      `Campaign ${formatDate(at, input.timeZone ?? DEFAULT_TIMEZONE)}`;
    if (input.event) {
      if (!isUuid(input.event.eventId)) return err('invalid_input', 'That event does not exist.');
      const draft: Campaign = {
        ...newCampaignRow(organizationId, actor, name, now),
        event_id: input.event.eventId,
        event_kind: input.event.kind,
        event_meta: input.event.meta,
      };
      try {
        await store.insert('campaigns', draft);
      } catch (error) {
        if (isMissingColumnError(error)) return EVENT_CAMPAIGNS_NOT_SET_UP();
        throw error;
      }
      await audit(store, organizationId, actor.userId, 'campaign.created', draft.id, {
        event: input.event.eventId,
        kind: input.event.kind,
      });
      return ok(draft);
    }
    const campaign = newCampaignRow(organizationId, actor, name, now);
    await store.insert('campaigns', campaign);
    await audit(store, organizationId, actor.userId, 'campaign.created', campaign.id);
    return ok(campaign);
  });
}

/** A new, empty draft row: no subject, no body, signed as Nick, tracking on. */
function newCampaignRow(
  organizationId: string,
  actor: CampaignActor,
  name: string,
  now: string,
): Campaign {
  return {
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
}

/* ---------------------------------------------------------- event messages */
//
// Events → Messages (D-075, lib/services/event-comms.ts) drafts its invites,
// reminders and notices as ordinary campaigns. What is added here is only
// where a draft came from (three columns from 20261023000300_event_campaigns.sql)
// and the guests' personal RSVP links: the review, the confirmation, the send
// lease, the daily cap and the recipient limit are the same code paths as for
// any campaign, and nothing here sends.

export const EVENT_CAMPAIGNS_MIGRATION_FILE =
  'supabase/migrations/20261023000300_event_campaigns.sql';

export const RSVP_LOCAL_ORIGIN_MESSAGE =
  'APP_URL is a local address, so the personal RSVP links in these emails would not open. Set it to the app’s public address. Nothing was sent.';

const EVENT_CAMPAIGNS_NOT_SET_UP = () =>
  err(
    'not_configured',
    `Event messages are not set up yet. Run ${EVENT_CAMPAIGNS_MIGRATION_FILE} in the Supabase SQL editor, then try again.`,
    { stillUsable: 'Campaigns and the rest of Events work as before.' },
  );

/** The event a draft is made from, as event-comms.ts passes it to createCampaign. */
export interface EventCampaignLink {
  eventId: string;
  kind: EventCampaignKind;
  meta: Record<string, unknown>;
}

/** A guest to add to an event draft, with the personal RSVP link the server made for them. */
export interface EventRecipientCandidate {
  email: string;
  name: string | null;
  company: string | null;
  record_id: string | null;
  /** Absolute: APP_URL + /e/<slug>/i/<token>. Anything else is refused. */
  rsvpLink: string;
}

/**
 * Add an event's guests to one of that event's drafts, each with their
 * personal RSVP link in `merge.rsvp_link`. The same dedupe, unsubscribe and
 * 2,000-recipient rules as every other way of adding people (addCandidates).
 * A link that is not exactly an /e/<slug>/i/<token> address is dropped, and
 * so is its guest (counted under `invalid`), so no recipient ever carries a
 * link of anyone's choosing.
 */
export async function addEventRecipients(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  candidates: readonly EventRecipientCandidate[],
): Promise<Result<AddRecipientsSummary>> {
  return guard('write', 'add event guests', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    if (!campaign.event_id) {
      return err('invalid_input', 'Only a draft made from an event can take its guests.');
    }
    const invalid: string[] = [];
    const good: RecipientCandidate[] = [];
    let noEmail = 0;
    for (const c of candidates) {
      const email = normalizeEmail(c.email ?? '');
      if (!email) {
        noEmail += 1;
        continue;
      }
      if (!isEmail(email) || !isRsvpLinkUrl(c.rsvpLink)) {
        invalid.push(email.slice(0, 120));
        continue;
      }
      good.push({
        email,
        name: c.name,
        company: c.company,
        record_id: isUuid(c.record_id) ? c.record_id : null,
        rsvp_link: c.rsvpLink,
      });
    }
    return addCandidates(store, organizationId, campaign, good, {
      duplicates: 0,
      noEmail,
      invalid,
    });
  });
}

/** An event's drafts and sends, newest first, with their counts. */
export async function listEventCampaigns(
  store: DataStore,
  organizationId: string,
  eventId: string,
): Promise<Result<CampaignSummary[]>> {
  if (!isUuid(eventId)) return ok([]);
  return guard('read', 'list event campaigns', async () => {
    let campaigns: Campaign[];
    try {
      campaigns = await listAllPages(
        store,
        'campaigns',
        organizationId,
        { eq: { event_id: eventId } },
        [{ field: 'created_at', direction: 'desc' }],
      );
    } catch (error) {
      // No event_id column: 20261023000300 has not run (the generic message
      // would send the reader to the campaigns migration instead).
      if (isMissingColumnError(error)) return EVENT_CAMPAIGNS_NOT_SET_UP();
      throw error;
    }
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

/** Every recipient row of these campaigns (an event's funnel and notice bookkeeping read them). */
export async function recipientsOfCampaigns(
  store: DataStore,
  organizationId: string,
  campaignIds: readonly string[],
): Promise<Result<CampaignRecipient[]>> {
  return guard('read', 'read event campaign recipients', async () =>
    ok(
      campaignIds.length
        ? await listWhereIn(
            store,
            'campaign_recipients',
            organizationId,
            {},
            'campaign_id',
            campaignIds.filter(isUuid),
          )
        : [],
    ),
  );
}

/**
 * Replace an event campaign's bookkeeping (event_meta), at any status: it is
 * never part of what is reviewed or sent. Used to remember that a sent
 * notice's status changes were marked as told.
 */
export async function setEventCampaignMeta(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  meta: Record<string, unknown>,
): Promise<Result<true>> {
  return guard('write', 'update an event campaign', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign?.event_id) return NOT_FOUND();
    await store.updateWhere(
      'campaigns',
      organizationId,
      { eq: { id: campaign.id, event_id: campaign.event_id } },
      { event_meta: meta },
    );
    return ok(true);
  });
}

/** Whether a click goes to this recipient's own RSVP link on an event campaign (recordClick). */
function isOwnRsvpLink(
  campaign: Pick<Campaign, 'event_id'>,
  recipient: Pick<CampaignRecipient, 'merge'>,
  url: string,
): boolean {
  return Boolean(campaign.event_id) && isRsvpLinkUrl(url) && recipient.merge?.rsvp_link === url;
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
    if (extrasAvailable(store, claimed)) {
      for (const photo of await photosOf(store, organizationId, campaign.id)) {
        await removeParts(storage, photo.parts);
      }
      await store.removeWhere('campaign_photos', organizationId, {
        eq: { campaign_id: campaign.id },
      });
    }
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
  /** Through a campaign email's link, or added by a person in Kraken. */
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
  /** Event drafts only (addEventRecipients): the guest's checked personal RSVP link. */
  rsvp_link?: string;
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
    if (c.rsvp_link && isRsvpLinkUrl(c.rsvp_link)) merge.rsvp_link = c.rsvp_link;
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
      // The type it is stored and sent with. Storage takes only some types,
      // so anything else is refused here, before a byte is written, rather
      // than failing in storage (it used to be stored as
      // application/octet-stream, which the bucket refuses outright).
      const type = campaignAttachmentType(name, meta.type);
      if (!type) return err('unsupported_media_type', unsupportedAttachmentMessage(name));
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
      const put = await storage.put(path, bytes, type);
      if (!put.ok) {
        // Storage refusing the type after all (its list is the migrations',
        // not this code's): the file's problem, said as such, not a 500.
        if (put.error.code === 'unsupported_media_type') {
          return err('unsupported_media_type', unsupportedAttachmentMessage(name));
        }
        return put;
      }
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
            type,
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

/* ------------------------------------------------------- photos and copies */
//
// Two optional additions to a campaign, both empty by default:
//
//   - A photo per recipient. The campaign keeps a set of photos (uploaded in
//     pieces to the private bucket, like attachments); each is given to the
//     recipient its file name names, when exactly one does (lib/campaigns/
//     photos.ts), or picked by hand. A recipient with a photo gets it as an
//     attachment on their own email, beside the shared attachments; a
//     recipient without one gets exactly the email they would have got.
//     A photo that cannot be found, read or fit under the per-email limit
//     stops the review, naming the person, and fails that one send mid-batch
//     ("Photo could not be read, so this email was not sent"): an email that
//     was meant to carry a photo never goes without it.
//   - Copies. The campaign's CC on every email; its BCC on every email or on
//     the first email it actually sends (claimed once, and kept claimed once
//     that email may have gone: only an outright refusal gives it back); a
//     recipient's own CC on their email only. To is
//     always exactly one recipient. Every copy counts toward the daily cap.
//
// Every edit here is a draft edit that moves the campaign's version on, so a
// review taken before it cannot be confirmed; per-recipient edits follow the
// recipients' rule (write, then move the version; if the campaign was
// confirmed in between, undo the write). Their columns come from
// 20261021001100_campaign_photos_cc.sql; until it is applied the features
// stay hidden and nothing here writes.

export const CAMPAIGN_EXTRAS_MIGRATION_FILE =
  'supabase/migrations/20261021001100_campaign_photos_cc.sql';

const EXTRAS_NOT_SET_UP = () =>
  err(
    'not_configured',
    `Photos and CC/BCC are not set up yet. Run ${CAMPAIGN_EXTRAS_MIGRATION_FILE} in the Supabase SQL editor, then reload.`,
    { stillUsable: 'Campaigns send as before without them.' },
  );

/** Why a recipient with a photo was not sent to, as the report shows it. */
export const PHOTO_UNREADABLE = 'Photo could not be read, so this email was not sent.';
const PHOTO_MISSING = 'Photo is missing, so this email was not sent.';
const PHOTO_INCOMPLETE = 'Photo is incomplete in storage, so this email was not sent.';
const PHOTO_TOO_BIG = 'Photo is too big for this email, so it was not sent.';

/**
 * Whether this campaign's row has the photo and copy columns, i.e. whether
 * 20261021001100_campaign_photos_cc.sql has been applied. Postgres returns
 * every column of a row, so a row without `cc` comes from a table without
 * it: then photos and copies stay hidden and nothing writes them. The demo
 * store keeps no schema, so it always has them.
 */
export function extrasAvailable(
  store: Pick<DataStore, 'kind'>,
  campaign: Pick<Campaign, 'cc'>,
): boolean {
  return store.kind === 'demo' || Array.isArray(campaign.cc);
}

export interface CampaignCopySettings {
  cc: string[];
  bcc: string[];
  bccMode: CampaignBccMode;
  /** Set once the first-only BCC copy went (or is going) with an email. */
  bccSampleAt: string | null;
}

/** A campaign's copies, cleaned: absent columns and stray values read as none. */
export function copySettingsOf(
  campaign: Pick<Campaign, 'cc' | 'bcc' | 'bcc_mode' | 'bcc_sample_at'>,
): CampaignCopySettings {
  return {
    cc: cleanCopyList(campaign.cc),
    bcc: cleanCopyList(campaign.bcc),
    bccMode: cleanBccMode(campaign.bcc_mode),
    bccSampleAt: campaign.bcc_sample_at ?? null,
  };
}

/** Whether a campaign changes any email with a photo or a copy. */
function usesExtras(campaign: Campaign, recipients: readonly CampaignRecipient[]): boolean {
  const copies = copySettingsOf(campaign);
  return (
    copies.cc.length > 0 ||
    copies.bcc.length > 0 ||
    recipients.some(
      (r) => r.status === 'pending' && (Boolean(r.photo_id) || cleanCopyList(r.cc).length > 0),
    )
  );
}

/** Every address a campaign copies anywhere, for the suppression check. */
function copyAddressesOf(campaign: Campaign, recipients: readonly CampaignRecipient[]): string[] {
  const copies = copySettingsOf(campaign);
  return [
    ...new Set([
      ...copies.cc,
      ...copies.bcc,
      ...recipients.filter((r) => r.status === 'pending').flatMap((r) => cleanCopyList(r.cc)),
    ]),
  ];
}

async function photosOf(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<CampaignPhoto[]> {
  return listAllPages(
    store,
    'campaign_photos',
    organizationId,
    { eq: { campaign_id: campaignId } },
    [
      { field: 'created_at', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ],
  );
}

/** What the review and the confirmation need to check photos and copies. */
export interface ExtrasContext {
  photos: ReadonlyMap<string, ManifestPhoto>;
  /** Of the addresses the campaign copies, those currently unsubscribed. */
  suppressed: ReadonlySet<string>;
}

/**
 * The photos and suppression state a review checks, or undefined for a
 * campaign that uses neither photos nor copies (or cannot yet): its review is
 * then exactly the review it always had, with no extra reads.
 */
async function extrasContext(
  store: DataStore,
  organizationId: string,
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  always = false,
): Promise<ExtrasContext | undefined> {
  if (!extrasAvailable(store, campaign)) return undefined;
  if (!always && !usesExtras(campaign, recipients)) return undefined;
  const photos = new Map(
    (await photosOf(store, organizationId, campaign.id)).map((p) => [p.id, p] as const),
  );
  const suppressed = await suppressedEmails(
    store,
    organizationId,
    copyAddressesOf(campaign, recipients),
  );
  return { photos, suppressed };
}

/**
 * One recipient's photo, read whole from storage and checked against what
 * was uploaded. Any failure is that email's failure, with a reason the
 * report can show; it is never sent without the photo.
 */
async function loadPhoto(
  storage: StorageProvider,
  photo: CampaignPhoto | null,
  sharedBytes: number,
): Promise<Result<OutgoingCampaignEmail['attachments'][number]>> {
  if (!photo) return err('not_found', PHOTO_MISSING);
  if (photo.size > MAX_PHOTO_BYTES || sharedBytes + photo.size > MAX_ATTACHMENT_BYTES) {
    return err('too_large', PHOTO_TOO_BIG);
  }
  if (!photo.parts.length) return err('internal', PHOTO_INCOMPLETE);
  const pieces: Uint8Array[] = [];
  for (const part of photo.parts) {
    const data = await storage.get(part);
    if (!data.ok) return err('provider_unavailable', PHOTO_UNREADABLE, { retryable: true });
    pieces.push(data.value);
  }
  const data = Buffer.concat(pieces.map((p) => Buffer.from(p)));
  if (data.byteLength !== photo.size) return err('internal', PHOTO_INCOMPLETE);
  return ok({ filename: photo.name, mimeType: photo.type, data });
}

const recipientLabel = (r: Pick<CampaignRecipient, 'name' | 'email'>) => r.name?.trim() || r.email;

function photoViews(
  photos: readonly CampaignPhoto[],
  recipients: readonly CampaignRecipient[],
): CampaignPhotoView[] {
  const pending = recipients.filter((r) => r.status === 'pending');
  const match = photoMatcher(pending);
  const byId = new Map(pending.map((r) => [r.id, r] as const));
  const names = new Map(photos.map((p) => [p.id, p.name] as const));
  return photos.map((p) => {
    const holders = pending
      .filter((r) => r.photo_id === p.id)
      .map((r) => ({ id: r.id, label: recipientLabel(r) }));
    let unmatched: string | null = null;
    if (!holders.length) {
      const m = match(p.name);
      if (m.kind === 'none') unmatched = 'No one on the list has this name or address.';
      else if (m.kind === 'many') {
        const who = m.recipientIds.map((id) => byId.get(id)).filter(Boolean) as CampaignRecipient[];
        unmatched = `Matches ${who.length} people (${who
          .slice(0, 3)
          .map(recipientLabel)
          .join(', ')}${who.length > 3 ? ', …' : ''}), so it was left for you to pick.`;
      } else {
        const r = byId.get(m.recipientId);
        const theirs = r?.photo_id ? names.get(r.photo_id) : null;
        unmatched = r
          ? theirs
            ? `Matches ${recipientLabel(r)}, who already has ${theirs}.`
            : `Matches ${recipientLabel(r)}: use Match by file name.`
          : 'No one on the list has this name or address.';
      }
    }
    return { id: p.id, name: p.name, size: p.size, type: p.type, recipients: holders, unmatched };
  });
}

/** The campaign's photos, for the composer. Empty until the migration is applied. */
export async function listCampaignPhotos(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Result<CampaignPhotoView[]>> {
  return guard('read', 'list campaign photos', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (!extrasAvailable(store, campaign)) return ok([]);
    const [photos, recipients] = await Promise.all([
      photosOf(store, organizationId, campaign.id),
      recipientsOf(store, organizationId, campaign.id),
    ]);
    return ok(photoViews(photos, recipients));
  });
}

/**
 * Where a photo's pieces are kept: a folder of their own beside the
 * attachments' (partPath), so a photo upload can never land on an
 * attachment's pieces, or an attachment upload on a photo's.
 */
const photoPartPath = (
  organizationId: string,
  campaignId: string,
  uploadId: string,
  index: number,
) => `campaigns/${organizationId}/${campaignId}/photos/${uploadId}/${index}`;

/**
 * Why storage turned a photo away. Every kind but HEIC is in the bucket's
 * first list; HEIC needs 20261021001500_bucket_heic.sql, and until that is
 * applied a HEIC photo is refused with this rather than a 500.
 */
function photoRefusedByStorage(name: string, kind: PhotoKind) {
  return err(
    'unsupported_media_type',
    kind === 'heic'
      ? `HEIC photos are not enabled yet, so ${name} was not added. Use JPG or PNG instead (to enable HEIC, run ${BUCKET_HEIC_MIGRATION_FILE} in the Supabase SQL editor).`
      : `Storage does not take ${PHOTO_KIND_LABEL[kind]} photos right now, so ${name} was not added.`,
  );
}

/** A photo whose bytes are another kind than the upload declared. */
const photoKindMismatch = (name: string, inside: PhotoKind, declared: PhotoKind) =>
  err(
    'unsupported_media_type',
    `${name} is a ${PHOTO_KIND_LABEL[inside]} image inside, not a ${PHOTO_KIND_LABEL[declared]}. Reload the page and add it again.`,
  );

/** A draft that can take photos and copies right now, or why not. */
async function extrasDraft(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Result<Campaign>> {
  const campaign = await loadCampaign(store, organizationId, campaignId);
  if (!campaign) return NOT_FOUND();
  if (campaign.status !== 'draft') return NOT_DRAFT();
  if (!extrasAvailable(store, campaign)) return EXTRAS_NOT_SET_UP();
  return ok(campaign);
}

/**
 * One piece of a photo. Pieces arrive in order like an attachment's; the
 * photo joins the campaign's set when its last piece lands, the pieces add up
 * to its size and its first bytes are really an image, and is then given to
 * the one recipient its file name names, if exactly one does and they have no
 * photo yet. All only while the campaign is a draft: a photo that finishes
 * after the tap on Send is taken out again, with any match it made.
 */
export async function addPhotoChunk(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  campaignId: string,
  meta: AttachmentChunk,
  bytes: Uint8Array,
): Promise<
  Result<{ complete: boolean; photos?: CampaignPhotoView[]; outcome?: PhotoUploadOutcome }>
> {
  return guard<{ complete: boolean; photos?: CampaignPhotoView[]; outcome?: PhotoUploadOutcome }>(
    'write',
    'upload a campaign photo',
    async () => {
      const draft = await extrasDraft(store, organizationId, campaignId);
      if (!draft.ok) return draft;
      const campaign = draft.value;
      if (!isUuid(meta.uploadId)) return err('invalid_input', 'That upload is not valid.');
      const name = cleanFilename(meta.name);
      // The kind every piece of this photo is stored as: its real image type,
      // never application/octet-stream (which the bucket refuses). The first
      // piece's bytes must say the same kind, below.
      const declared = declaredPhotoKind(name, meta.type);
      if (!isPhotoName(name) || !isPhotoType(meta.type) || !declared) {
        return err(
          'unsupported_media_type',
          `${name} is not a photo. Use JPG, PNG, GIF, WebP or HEIC files.`,
        );
      }
      const maxParts = Math.ceil(MAX_PHOTO_BYTES / UPLOAD_CHUNK_BYTES) + 1;
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
      if (!Number.isFinite(meta.size) || meta.size <= 0 || meta.size > MAX_PHOTO_BYTES) {
        return err(
          'too_large',
          `${name} is ${formatBytes(Math.max(0, meta.size || 0))}; a photo can be ${formatBytes(MAX_PHOTO_BYTES)} at most.`,
        );
      }
      const shared = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
      if (shared + meta.size > MAX_ATTACHMENT_BYTES) {
        return err(
          'too_large',
          `With the ${formatBytes(shared)} of attachments every email carries, ${name} would take an email over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        );
      }
      if (meta.index === 0) {
        const inside = sniffPhoto(bytes);
        if (!inside) {
          return err(
            'unsupported_media_type',
            `${name} is not a JPG, PNG, GIF, WebP or HEIC image inside.`,
          );
        }
        if (inside !== declared) return photoKindMismatch(name, inside, declared);
      }
      if (meta.index === 0) {
        const count = await store.count('campaign_photos', organizationId, {
          eq: { campaign_id: campaign.id },
        });
        if (count >= MAX_PHOTOS) {
          return err('invalid_input', `A campaign can carry ${MAX_PHOTOS} photos at most.`);
        }
      }

      // An id that is already a photo is refused before anything is written:
      // its pieces sit at the same paths, so writing (or cleaning up after a
      // refusal) would change or delete a photo someone already has, without
      // moving the draft's version.
      if (await store.get('campaign_photos', organizationId, meta.uploadId)) {
        return err('invalid_input', 'That upload is not valid.');
      }
      const path = photoPartPath(organizationId, campaign.id, meta.uploadId, meta.index);
      const put = await storage.put(path, bytes, PHOTO_MIME[declared]);
      if (!put.ok) {
        if (put.error.code === 'unsupported_media_type') {
          return photoRefusedByStorage(name, declared);
        }
        return put;
      }
      if (meta.index < meta.count - 1) return ok({ complete: false });

      const parts = Array.from({ length: meta.count }, (_, i) =>
        photoPartPath(organizationId, campaign.id, meta.uploadId, i),
      );
      const incomplete = async () => {
        await removeParts(storage, parts);
        return err('invalid_input', `${name} did not upload completely. Add it again.`);
      };
      let total = 0;
      let kind: ReturnType<typeof sniffPhoto> = null;
      for (const [i, part] of parts.entries()) {
        const data = await storage.get(part);
        if (!data.ok) return incomplete();
        if (i === 0) kind = sniffPhoto(data.value);
        total += data.value.byteLength;
      }
      if (total !== meta.size || !kind) return incomplete();
      if (kind !== declared) {
        // The last piece declared another kind than the first one's bytes:
        // its pieces were not all stored as the one real type.
        await removeParts(storage, parts);
        return photoKindMismatch(name, kind, declared);
      }

      const latest = await loadCampaign(store, organizationId, campaign.id);
      if (!latest || latest.status !== 'draft') {
        await removeParts(storage, parts);
        return latest ? NOT_DRAFT() : NOT_FOUND();
      }
      const existing = await photosOf(store, organizationId, campaign.id);
      if (
        existing.some((p) => p.id === meta.uploadId) ||
        (await store.get('campaign_photos', organizationId, meta.uploadId))
      ) {
        // Another upload with this id finished first: these pieces are its
        // pieces now, so they stay.
        return err('invalid_input', 'That upload is not valid.');
      }
      const photo: CampaignPhoto = {
        id: meta.uploadId,
        organization_id: organizationId,
        campaign_id: campaign.id,
        name,
        type: PHOTO_MIME[kind],
        size: meta.size,
        parts,
        // After every photo already in the set, so the list keeps upload order.
        created_at: new Date(
          Math.max(Date.now(), ...existing.map((p) => Date.parse(p.created_at) + 1)),
        ).toISOString(),
      };
      await store.insert('campaign_photos', photo);

      // Given to whoever its name names, if that is exactly one person and
      // they have no photo yet; anything else waits for a person to pick.
      const recipients = await recipientsOf(store, organizationId, campaign.id);
      const pending = recipients.filter((r) => r.status === 'pending');
      const match = photoMatcher(pending)(name);
      let matchedTo: CampaignRecipient | null = null;
      if (match.kind === 'one') {
        const [given] = await store.updateWhere(
          'campaign_recipients',
          organizationId,
          {
            eq: { id: match.recipientId, campaign_id: campaign.id, status: 'pending' },
            isNull: ['photo_id'],
          },
          { photo_id: photo.id },
        );
        matchedTo = given ?? null;
      }

      if (!(await touchDraft(store, organizationId, latest))) {
        // Confirmed while it went in: the reviewed campaign never had it.
        if (matchedTo) {
          await store.updateWhere(
            'campaign_recipients',
            organizationId,
            { eq: { id: matchedTo.id, photo_id: photo.id } },
            { photo_id: null },
          );
        }
        await store.remove('campaign_photos', organizationId, photo.id);
        await removeParts(storage, parts);
        return draftConflict(store, organizationId, campaign.id);
      }
      const fresh = await recipientsOf(store, organizationId, campaign.id);
      return ok({
        complete: true,
        photos: photoViews(await photosOf(store, organizationId, campaign.id), fresh),
        outcome: {
          photoId: photo.id,
          name,
          matchedTo: matchedTo ? recipientLabel(matchedTo) : null,
        },
      });
    },
  );
}

/**
 * Take a photo out of the set, and off whoever had it (they then get the
 * email without one, as a person asked). If the campaign was confirmed in
 * the meantime, everything is put back as the review saw it.
 */
export async function removePhoto(
  store: DataStore,
  storage: StorageProvider,
  organizationId: string,
  campaignId: string,
  photoId: string,
): Promise<Result<CampaignPhotoView[]>> {
  return guard('write', 'remove a campaign photo', async () => {
    const draft = await extrasDraft(store, organizationId, campaignId);
    if (!draft.ok) return draft;
    const campaign = draft.value;
    const photo = isUuid(photoId)
      ? await store.findOne('campaign_photos', organizationId, {
          eq: { id: photoId, campaign_id: campaign.id },
        })
      : null;
    if (!photo) return err('not_found', 'That photo is not on this campaign.');
    const holders = await store.updateWhere(
      'campaign_recipients',
      organizationId,
      { eq: { campaign_id: campaign.id, photo_id: photo.id } },
      { photo_id: null },
    );
    await store.remove('campaign_photos', organizationId, photo.id);
    if (!(await touchDraft(store, organizationId, campaign))) {
      await store.insert('campaign_photos', photo);
      for (const group of chunk(
        holders.map((r) => r.id),
        100,
      )) {
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { in: { id: group }, isNull: ['photo_id'] },
          { photo_id: photo.id },
        );
      }
      return draftConflict(store, organizationId, campaign.id);
    }
    await removeParts(storage, photo.parts);
    const recipients = await recipientsOf(store, organizationId, campaign.id);
    return ok(photoViews(await photosOf(store, organizationId, campaign.id), recipients));
  });
}

/**
 * Give a recipient a photo from the set, change it, or clear it (null): the
 * by-hand side of the match by file name.
 */
export async function assignPhoto(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  input: { recipientId: string; photoId: string | null },
): Promise<Result<CampaignPhotoView[]>> {
  return guard('write', 'assign a campaign photo', async () => {
    const draft = await extrasDraft(store, organizationId, campaignId);
    if (!draft.ok) return draft;
    const campaign = draft.value;
    const recipient = isUuid(input.recipientId)
      ? await store.findOne('campaign_recipients', organizationId, {
          eq: { id: input.recipientId, campaign_id: campaign.id },
        })
      : null;
    if (!recipient) return err('not_found', 'That person is not on this campaign.');
    if (recipient.status !== 'pending') {
      return err('conflict', 'That person is not waiting to be sent to.');
    }
    if (input.photoId !== null) {
      const photo = isUuid(input.photoId)
        ? await store.findOne('campaign_photos', organizationId, {
            eq: { id: input.photoId, campaign_id: campaign.id },
          })
        : null;
      if (!photo) return err('not_found', 'That photo is not on this campaign.');
      const shared = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
      if (shared + photo.size > MAX_ATTACHMENT_BYTES) {
        return err(
          'too_large',
          `With the shared attachments, ${photo.name} would take the email to ${recipientLabel(recipient)} over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        );
      }
    }
    const previous = recipient.photo_id ?? null;
    if (previous !== input.photoId) {
      const [changed] = await store.updateWhere(
        'campaign_recipients',
        organizationId,
        { eq: { id: recipient.id, status: 'pending' } },
        { photo_id: input.photoId },
      );
      if (!changed) return err('conflict', 'That person is not waiting to be sent to.');
      if (!(await touchDraft(store, organizationId, campaign))) {
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { eq: { id: recipient.id, photo_id: input.photoId } },
          { photo_id: previous },
        );
        return draftConflict(store, organizationId, campaign.id);
      }
    }
    const [photos, recipients] = await Promise.all([
      photosOf(store, organizationId, campaign.id),
      recipientsOf(store, organizationId, campaign.id),
    ]);
    return ok(photoViews(photos, recipients));
  });
}

/**
 * The match by file name again, for photos nobody has: after more people
 * were added, or a photo was cleared. Gives each to the one person its name
 * names when they have no photo yet; never moves a photo someone has.
 */
export async function matchPhotosByName(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Result<{ matched: number; photos: CampaignPhotoView[] }>> {
  return guard('write', 'match campaign photos', async () => {
    const draft = await extrasDraft(store, organizationId, campaignId);
    if (!draft.ok) return draft;
    const campaign = draft.value;
    const [photos, recipients] = await Promise.all([
      photosOf(store, organizationId, campaign.id),
      recipientsOf(store, organizationId, campaign.id),
    ]);
    const pending = recipients.filter((r) => r.status === 'pending');
    const held = new Set(pending.map((r) => r.photo_id).filter(Boolean));
    const match = photoMatcher(pending);
    const given: { recipientId: string; photoId: string }[] = [];
    const taken = new Set<string>();
    for (const photo of photos) {
      if (held.has(photo.id)) continue;
      const m = match(photo.name);
      if (m.kind !== 'one' || taken.has(m.recipientId)) continue;
      const [changed] = await store.updateWhere(
        'campaign_recipients',
        organizationId,
        {
          eq: { id: m.recipientId, campaign_id: campaign.id, status: 'pending' },
          isNull: ['photo_id'],
        },
        { photo_id: photo.id },
      );
      if (changed) {
        given.push({ recipientId: changed.id, photoId: photo.id });
        taken.add(changed.id);
      }
    }
    if (given.length && !(await touchDraft(store, organizationId, campaign))) {
      for (const g of given) {
        await store.updateWhere(
          'campaign_recipients',
          organizationId,
          { eq: { id: g.recipientId, photo_id: g.photoId } },
          { photo_id: null },
        );
      }
      return draftConflict(store, organizationId, campaign.id);
    }
    const fresh = given.length
      ? await recipientsOf(store, organizationId, campaign.id)
      : recipients;
    return ok({ matched: given.length, photos: photoViews(photos, fresh) });
  });
}

/**
 * The campaign's CC, its BCC and where the BCC goes. Each given list is
 * replaced whole; a list that is not all real addresses, or too long, is
 * refused whole. A compare-and-set on the draft like every other edit, so
 * it makes any earlier review stale.
 */
export async function updateCampaignCopies(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  input: { cc?: string; bcc?: string; bccMode?: CampaignBccMode },
): Promise<Result<Campaign>> {
  return guard('write', 'update campaign copies', async () => {
    const draft = await extrasDraft(store, organizationId, campaignId);
    if (!draft.ok) return draft;
    const campaign = draft.value;
    const patch: Partial<Campaign> = {};
    for (const key of ['cc', 'bcc'] as const) {
      const text = input[key];
      if (text === undefined) continue;
      const parsed = parseCopyAddresses(text);
      if (!parsed.ok) return err('invalid_input', `${key.toUpperCase()}: ${parsed.message}`);
      patch[key] = parsed.emails;
    }
    if (input.bccMode !== undefined) {
      if (input.bccMode !== 'every' && input.bccMode !== 'first') {
        return err('invalid_input', 'Choose every email or the first email only.');
      }
      patch.bcc_mode = input.bccMode;
    }
    if (!Object.keys(patch).length) return ok(campaign);
    const [updated] = await store.updateWhere(
      'campaigns',
      organizationId,
      { eq: { id: campaign.id, status: 'draft' } },
      { ...patch, updated_at: nextVersion(campaign) },
    );
    if (!updated) return draftConflict(store, organizationId, campaign.id);
    return ok(updated);
  });
}

/** One recipient's own CC, replaced whole (empty text clears it). */
export async function setRecipientCc(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  input: { recipientId: string; cc: string },
): Promise<Result<{ recipientId: string; cc: string[] }>> {
  return guard('write', "update a recipient's CC", async () => {
    const draft = await extrasDraft(store, organizationId, campaignId);
    if (!draft.ok) return draft;
    const campaign = draft.value;
    const recipient = isUuid(input.recipientId)
      ? await store.findOne('campaign_recipients', organizationId, {
          eq: { id: input.recipientId, campaign_id: campaign.id },
        })
      : null;
    if (!recipient) return err('not_found', 'That person is not on this campaign.');
    if (recipient.status !== 'pending') {
      return err('conflict', 'That person is not waiting to be sent to.');
    }
    const parsed = parseCopyAddresses(input.cc);
    if (!parsed.ok) return err('invalid_input', `CC: ${parsed.message}`);
    if (parsed.emails.includes(recipient.email)) {
      return err('invalid_input', `${recipient.email} already gets this email; CC someone else.`);
    }
    const previous = cleanCopyList(recipient.cc);
    if (previous.join(',') === parsed.emails.join(',')) {
      return ok({ recipientId: recipient.id, cc: previous });
    }
    const [changed] = await store.updateWhere(
      'campaign_recipients',
      organizationId,
      { eq: { id: recipient.id, status: 'pending' } },
      { cc: parsed.emails },
    );
    if (!changed) return err('conflict', 'That person is not waiting to be sent to.');
    if (!(await touchDraft(store, organizationId, campaign))) {
      await store.update('campaign_recipients', organizationId, recipient.id, { cc: previous });
      return draftConflict(store, organizationId, campaign.id);
    }
    return ok({ recipientId: recipient.id, cc: parsed.emails });
  });
}

/** "Who gets what", as the review screen reads it. */
export interface CampaignManifest {
  /** The campaign version it was read at: the review's, when nothing changed between. */
  version: string;
  /** Whether photos and copies can be used here (their migration is applied). */
  extras: boolean;
  tracking: boolean;
  unsubscribe: boolean;
  check: ExtrasCheck;
}

/**
 * Every pending recipient's email as it would go out, in send order, with
 * the problems and the totals: the dry run before the tap on Send. Reads
 * only.
 */
export async function campaignManifest(
  store: DataStore,
  organizationId: string,
  campaignId: string,
): Promise<Result<CampaignManifest>> {
  return guard('read', 'read who gets what', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    const recipients = await recipientsOf(store, organizationId, campaign.id);
    const context = await extrasContext(store, organizationId, campaign, recipients, true);
    return ok({
      version: campaign.updated_at,
      extras: Boolean(context),
      tracking: campaign.track_activity,
      unsubscribe: campaign.unsubscribe_link,
      check: checkExtras({
        campaign,
        pending: recipients.filter((r) => r.status === 'pending'),
        photos: context?.photos ?? new Map(),
        suppressed: context?.suppressed ?? new Set(),
      }),
    });
  });
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
 * the email is a plain personal one: links as written, nothing of Kraken's.
 * A link whose text is itself an address is never rewritten (template.ts).
 * Copies, when given, travel beside the email (its Cc and Bcc headers) and
 * never touch its body; with none, the result carries no `cc` or `bcc` at all.
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
    copies?: EmailCopies;
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
    ...(options.copies?.cc.length ? { cc: [...options.copies.cc] } : {}),
    ...(options.copies?.bcc.length ? { bcc: [...options.copies.bcc] } : {}),
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
  /** Who those are, with what each lacks and their CRM contact: the review fills them in. */
  missing: MissingPerson[];
  attachmentBytes: number;
  /** Echoed back by the confirmation, which refuses if anything changed since. */
  version: string;
  /**
   * Only for a campaign that uses photos or copies: the emails plus every
   * copy (what the daily cap counts), and what is worth knowing but stops
   * nothing (a CC who is also a recipient). Its blocking problems are in
   * `issues` with the rest.
   */
  extras?: { effectiveTotal: number; warnings: string[] };
}

export interface ReviewOptions {
  /**
   * The public origin for Kraken links (APP_URL), or null when it is local:
   * then a campaign with tracking or the unsubscribe line on cannot go.
   * Undefined skips that check.
   */
  appUrl?: string | null;
  /**
   * An event message's personal links as they stand now (filled by the
   * review and the confirmation themselves): an unpublished page or links
   * rotated since the draft stop the send. Undefined skips the check.
   */
  eventLinks?: EventLinkCheck;
}

/**
 * What the review screen shows and the confirmation checks, from the saved
 * campaign. `extras` (see extrasContext) is given only for a campaign that
 * uses photos or copies; without it the review is exactly what it always was.
 */
export function reviewIssues(
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  options: ReviewOptions = {},
  extras?: ExtrasContext,
): Omit<CampaignReview, 'campaign' | 'version' | 'missing'> {
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
  // {{rsvp_link}} (event messages, D-075): every recipient needs the personal
  // link the server gave them, and the links need a public origin.
  if (rsvpLinkUsed(campaign.body_template)) {
    const lacking = pending.filter((r) => !isRsvpLinkUrl(r.merge?.rsvp_link)).length;
    if (!campaign.event_id) {
      issues.push(
        '{{rsvp_link}} only works in a message drafted from an event (Events, then Messages).',
      );
    } else if (lacking) {
      issues.push(
        `${lacking} ${lacking === 1 ? 'recipient has' : 'recipients have'} no personal RSVP link. Only guests added from the event get one: remove the others, or take {{rsvp_link}} out.`,
      );
    }
    if (options.appUrl === null) issues.push(RSVP_LOCAL_ORIGIN_MESSAGE);
    if (campaign.event_id && options.eventLinks) {
      if (!options.eventLinks.live) {
        issues.push(
          'Publish the event page before sending: its personal links would not open until then.',
        );
      } else if (options.eventLinks.stale) {
        const n = options.eventLinks.stale;
        issues.push(
          `${n} personal ${n === 1 ? 'link is' : 'links are'} out of date (links rotated or the guest removed since this draft). Draft the message again from the event.`,
        );
      }
    }
  }
  if (campaign.event_id && options.eventLinks?.changedStatus) {
    const n = options.eventLinks.changedStatus;
    issues.push(
      `${n} ${n === 1 ? 'person in this notice has' : 'people in this notice have'} a different status now. Draft the notice again from the event’s queue.`,
    );
  }
  const used = mergeFieldsUsed(campaign.subject, campaign.body_template);
  const fallbacks = used
    .map((field) => ({
      field,
      count: pending.filter((r) => missingMergeFields([field], mergeFor(r)).length > 0).length,
    }))
    .filter((f) => f.count > 0);
  const review = { recipientCount: pending.length, issues, fallbacks, attachmentBytes };
  if (!extras) return review;
  // Photos that cannot go and unsubscribed copies stop the send, naming who.
  const check = checkExtras({
    campaign,
    pending,
    photos: extras.photos,
    suppressed: extras.suppressed,
  });
  issues.push(...check.issues);
  return {
    ...review,
    extras: { effectiveTotal: check.summary.effectiveTotal, warnings: check.warnings },
  };
}

/** The event-link check for a campaign that uses {{rsvp_link}}; undefined otherwise. */
async function eventLinksFor(
  store: DataStore,
  organizationId: string,
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
): Promise<EventLinkCheck | undefined> {
  if (!campaign.event_id) return undefined;
  if (!rsvpLinkUsed(campaign.body_template) && campaign.event_kind !== 'notice') return undefined;
  try {
    return await eventLinkCheck(store, organizationId, campaign, recipients);
  } catch (error) {
    if (isMissingTableError(error)) return undefined;
    throw error;
  }
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
    const extras = await extrasContext(store, organizationId, campaign, recipients);
    const eventLinks = await eventLinksFor(store, organizationId, campaign, recipients);
    return ok({
      campaign,
      version: campaign.updated_at,
      ...reviewIssues(campaign, recipients, { ...options, eventLinks }, extras),
      missing: await missingPeople(store, organizationId, campaign, recipients),
    });
  });
}

/**
 * The pending recipients who lack a merge field the email uses, each with
 * their CRM contact when they came from one. The contacts are a nicety: if
 * the CRM cannot be read (its tables not there yet, say) everyone reads as
 * unlinked, and the review still works.
 */
async function missingPeople(
  store: DataStore,
  organizationId: string,
  campaign: Pick<Campaign, 'subject' | 'body_template'>,
  recipients: readonly CampaignRecipient[],
): Promise<MissingPerson[]> {
  const pending = recipients.filter((r) => r.status === 'pending');
  const people = peopleMissingFields(
    mergeFieldsUsed(campaign.subject, campaign.body_template),
    pending.map((r) => ({ id: r.id, email: r.email, merge: mergeFor(r) })),
  );
  const recordOf = new Map(pending.map((r) => [r.id, r.record_id]));
  const recordIds = people.map((p) => recordOf.get(p.id)).filter((id): id is string => isUuid(id));
  if (!recordIds.length) return people;
  let records = new Map<string, CrmRecord>();
  try {
    records = new Map(
      (await listWhereIn(store, 'crm_records', organizationId, {}, 'id', recordIds)).map((r) => [
        r.id,
        r,
      ]),
    );
  } catch (error) {
    log.warn('Campaign review could not read CRM contacts', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return people.map((p) => {
    const record = records.get(recordOf.get(p.id) ?? '');
    if (record?.kind !== 'person') return p;
    const name = record.name.trim();
    return {
      ...p,
      contact: {
        name: name && !name.includes('@') ? name : null,
        company: personCompanyOf(record.fields)?.value ?? null,
      },
    };
  });
}

/* -------------------------------------------------------- fill merge values */

export interface FillMergeInput {
  recipientId: string;
  values: MergeValues;
  /** Also write the full name and company to the recipient's CRM contact. Off unless asked. */
  saveToContact?: boolean;
}

/** What happened on the CRM contact. */
export type ContactSave =
  /** Not asked for, or nothing typed that a contact holds. */
  | { status: 'skipped' }
  | { status: 'not_linked' }
  | { status: 'unchanged' }
  | { status: 'saved'; fields: PersonContactField[] }
  | { status: 'failed'; message: string };

export interface FillMergeResult {
  /** The merge fields that were empty and now have the typed value. */
  filled: MergeField[];
  contact: ContactSave;
}

/**
 * Fill in merge values a recipient is missing, from the review screen: the
 * values go into that recipient's own merge for this campaign, so the
 * preview, the review's counts and the send all use them. Only empty fields
 * are filled, and only while the campaign is a draft; the draft's version
 * moves on, so a review read before the change cannot be confirmed. With
 * `saveToContact`, the full name and company also go to the CRM person the
 * recipient came from; that never blocks the campaign's own save.
 */
export async function fillRecipientMerge(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  actor: CampaignActor,
  input: FillMergeInput,
): Promise<Result<FillMergeResult>> {
  return guard('write', 'fill in merge values', async () => {
    const campaign = await loadCampaign(store, organizationId, campaignId);
    if (!campaign) return NOT_FOUND();
    if (campaign.status !== 'draft') return NOT_DRAFT();
    const notOnIt = () => err('not_found', 'That person is not on this campaign.');
    if (!isUuid(input.recipientId)) return notOnIt();
    const recipient = await store.get('campaign_recipients', organizationId, input.recipientId);
    if (!recipient || recipient.campaign_id !== campaign.id) return notOnIt();
    const gone = () => err('conflict', 'This person is no longer waiting to get this campaign.');
    if (recipient.status !== 'pending') return gone();
    const problem = mergeValuesProblem(input.values);
    if (problem) return err('invalid_input', problem);

    const before = recipient.merge ?? {};
    const { merge, filled } = fillMerge(before, mergeFor(recipient), input.values);
    // Everything typed was filled meanwhile (another tab): nothing to change.
    if (!filled.length) return ok({ filled, contact: { status: 'skipped' } });
    const [updated] = await store.updateWhere(
      'campaign_recipients',
      organizationId,
      { eq: { id: recipient.id, campaign_id: campaign.id, status: 'pending' } },
      { merge, updated_at: new Date().toISOString() },
    );
    if (!updated) return gone();
    if (!(await touchDraft(store, organizationId, campaign))) {
      // Confirmed while this went in: put it back as the review showed it.
      await store.updateWhere(
        'campaign_recipients',
        organizationId,
        { eq: { id: recipient.id, status: 'pending' }, isNull: ['attempted_at'] },
        { merge: before },
      );
      return draftConflict(store, organizationId, campaign.id);
    }
    await audit(store, organizationId, actor.userId, 'campaign.recipient_updated', campaign.id, {
      fields: filled,
    });

    const forContact = {
      name: filled.includes('name') ? (merge.name ?? null) : null,
      company: filled.includes('company') ? (merge.company ?? null) : null,
    };
    let contact: ContactSave = { status: 'skipped' };
    if (input.saveToContact && (forContact.name || forContact.company)) {
      if (!recipient.record_id) {
        contact = { status: 'not_linked' };
      } else {
        const saved = await updatePersonContact(
          store,
          organizationId,
          recipient.record_id,
          forContact,
          { userId: actor.userId, name: null },
        );
        contact = !saved.ok
          ? { status: 'failed', message: saved.error.message }
          : saved.value.changed.length
            ? { status: 'saved', fields: saved.value.changed }
            : { status: 'unchanged' };
      }
    }
    return ok({ filled, contact });
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
    // The same photo and copy checks the review made: a photo that went
    // missing or an address that unsubscribed since refuses the tap too.
    const extras = await extrasContext(store, organizationId, campaign, recipients);
    const eventLinks = await eventLinksFor(store, organizationId, campaign, recipients);
    const review = reviewIssues(campaign, recipients, { ...options, eventLinks }, extras);
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
    const copies = extras ? copySettingsOf(campaign) : null;
    await audit(store, organizationId, actor.userId, 'campaign.confirmed', campaign.id, {
      recipients: review.recipientCount,
      from: campaign.from_identity,
      attachments: campaign.attachments.length,
      tracking: campaign.track_activity,
      unsubscribe_link: campaign.unsubscribe_link,
      // Counts only, never addresses: what the send carried besides the email.
      ...(copies
        ? {
            photos: pending.filter((r) => r.photo_id).length,
            cc: copies.cc.length,
            bcc: copies.bcc.length,
            bcc_mode: copies.bccMode,
            personal_cc: pending.filter((r) => cleanCopyList(r.cc).length).length,
          }
        : {}),
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
   * campaign whose emails carry Kraken links refuses to send without one.
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

/**
 * Gmail certainly did not send: it refused the request outright (no send
 * grant, or the grant was taken back), before any email could go. The send
 * loop pauses the campaign on it, and gives back a first-only BCC sample
 * claimed for that email. Any other error (Gmail unavailable, a dropped
 * connection) may have come after the email went.
 */
function gmailRefused(code: ErrorCode): boolean {
  return code === 'provider_unauthorized' || code === 'forbidden';
}

/**
 * The send times the 24-hour cap counts: one per email, plus one more per
 * CC or BCC address it went to (copy_count), since Gmail counts each of
 * those as a recipient too. An email that copied nobody counts once, as it
 * always did.
 */
function capTimes(rows: readonly Pick<CampaignRecipient, 'sent_at' | 'copy_count'>[]): string[] {
  return rows.flatMap((r) => {
    if (!r.sent_at) return [];
    const copies = Number.isFinite(r.copy_count) ? Math.floor(r.copy_count as number) : 0;
    return Array<string>(1 + Math.min(100, Math.max(0, copies))).fill(r.sent_at);
  });
}

async function capState(store: DataStore, organizationId: string, now: Date, cap: number) {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const recent = await listAllPages(store, 'campaign_recipients', organizationId, {
    gte: { sent_at: since },
  });
  return dailyCapState(capTimes(recent), now, cap);
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

      // Photos and copies, read once per batch. A campaign that uses neither
      // reads nothing more here, and every email below is the one it always
      // sent: no photo, no copies.
      const copySettings = extrasAvailable(store, campaign) ? copySettingsOf(campaign) : null;
      const sharedBytes = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
      const photoIds = copySettings
        ? [...new Set(queue.map((r) => r.photo_id).filter((id): id is string => Boolean(id)))]
        : [];
      const photos = new Map(
        (photoIds.length
          ? await listWhereIn(
              store,
              'campaign_photos',
              organizationId,
              { eq: { campaign_id: campaign.id } },
              'id',
              photoIds,
            )
          : []
        ).map((p) => [p.id, p] as const),
      );
      const copyAddresses = copySettings
        ? [...copySettings.cc, ...copySettings.bcc, ...queue.flatMap((r) => cleanCopyList(r.cc))]
        : [];

      // Recipients and copies alike: an unsubscribed address is never emailed.
      const suppressed = await suppressedEmails(store, organizationId, [
        ...queue.map((r) => r.email),
        ...copyAddresses,
      ]);

      let sentNow = 0;
      let failedNow = 0;
      let failuresInARow = 0;
      let message: string | null = null;
      // What the cap still allows in this batch. Each email costs one plus
      // its copies; one that copies nobody costs one, and the queue is never
      // longer than the cap allows, so a campaign without copies never stops
      // here.
      let capBudget = capNow.remaining;
      let cappedByCopies = false;
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

        // Their photo, read before anything is marked: one that cannot be
        // read fails this email (never sent without it) and the batch goes
        // on, unless it makes the failures in a row that pause it.
        let photo: OutgoingCampaignEmail['attachments'][number] | null = null;
        if (copySettings && recipient.photo_id) {
          const loaded = await loadPhoto(
            deps.storage,
            photos.get(recipient.photo_id) ?? null,
            sharedBytes,
          );
          if (!loaded.ok) {
            const [failed] = await store.updateWhere(
              'campaign_recipients',
              organizationId,
              { eq: { id: recipient.id, status: 'pending' }, isNull: ['attempted_at'] },
              { status: 'failed', error: loaded.error.message },
            );
            if (!failed) continue;
            failedNow += 1;
            failuresInARow += 1;
            log.warn('Campaign photo could not be attached', {
              campaignId,
              code: loaded.error.code,
            });
            if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
              await pauseFor('failures');
              message = `${MAX_CONSECUTIVE_FAILURES} emails in a row did not send, so the campaign paused. Check the errors, then resume.`;
              break;
            }
            continue;
          }
          photo = loaded.value;
        }

        // Their copies: the first-only BCC is offered while it is unclaimed,
        // and claimed below, just before the send.
        const copies: EmailCopies = copySettings
          ? copiesFor(recipient.email, {
              campaignCc: copySettings.cc,
              personalCc: cleanCopyList(recipient.cc),
              bcc:
                copySettings.bccMode === 'every' || !campaign.bcc_sample_at ? copySettings.bcc : [],
              suppressed,
            })
          : NO_COPIES;
        const cost = 1 + copyCount(copies);
        if (cost > capBudget) {
          cappedByCopies = true;
          break;
        }

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
          attachments: photo ? [...attachments.value, photo] : attachments.value,
          copies: { cc: copies.cc, bcc: [] },
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
        capBudget -= cost;
        // The BCC: on every email, or, first-only, on this one if it can
        // claim the sample (bcc_sample_at from empty to a time, once). The
        // claim stands once the email may have gone; only a refusal that
        // certainly sent nothing (gmailRefused) gives it back, for the next
        // email to carry.
        let bcc: string[] = [];
        let sampleClaim: string | null = null;
        if (copySettings && copies.bcc.length) {
          if (copySettings.bccMode === 'every') bcc = copies.bcc;
          else {
            const claimAt = now().toISOString();
            const [took] = await store.updateWhere(
              'campaigns',
              organizationId,
              { eq: { id: campaignId }, isNull: ['bcc_sample_at'] },
              { bcc_sample_at: claimAt },
            );
            if (took) {
              bcc = copies.bcc;
              sampleClaim = claimAt;
            }
          }
        }
        const result = await deps.sender.send(bcc.length ? { ...email, bcc } : email);
        const at = now().toISOString();
        lease.lastSentAt = at;
        await store.update('campaigns', organizationId, campaignId, { last_sent_at: at });

        if (result.ok) {
          sentNow += 1;
          failuresInARow = 0;
          const copied = copies.cc.length + bcc.length;
          await store.update('campaign_recipients', organizationId, recipient.id, {
            status: 'sent',
            sent_at: at,
            gmail_message_id: result.value.messageId,
            gmail_thread_id: result.value.threadId,
            error: null,
            // Written only when there were copies: the cap counts each.
            ...(copied ? { copy_count: copied } : {}),
          });
          continue;
        }

        const refused = gmailRefused(result.error.code);
        // Anything short of a refusal (Gmail unavailable, a dropped
        // connection) may have come after the email went, sample and all, so
        // the sample stays used and no later email can carry a second one.
        if (sampleClaim && refused) {
          await store.updateWhere(
            'campaigns',
            organizationId,
            { eq: { id: campaignId, bcc_sample_at: sampleClaim } },
            { bcc_sample_at: null },
          );
        }
        failedNow += 1;
        failuresInARow += 1;
        await store.update('campaign_recipients', organizationId, recipient.id, {
          status: 'failed',
          error: result.error.message.slice(0, 500),
        });
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
      if (cappedByCopies) {
        await pauseFor('capped');
        return ok(
          await progress('capped', {
            sentNow,
            failedNow,
            message: `Daily limit reached: ${cap} emails in the last 24 hours, counting every CC and BCC copy. The campaign paused; resume once the next slot opens.`,
          }),
        );
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
 * names the campaign rather than a recipient: they go through Kraken exactly
 * as the real email's do (so the test proves APP_URL works from outside) and
 * record nothing.
 *
 * Rendered as that recipient, it carries their photo too. It never carries
 * a copy: no Cc and no Bcc, ever, so a test reaches the signed-in person and
 * nobody else. Who the real email would copy comes back for the page to show
 * as text (wouldCc, wouldBcc).
 */
export interface TestSendResult {
  to: string;
  /** The recipient it was rendered as, if any. */
  as: string | null;
  /** The photo attached as theirs, if any. */
  photo: string | null;
  /** Who the real email to that recipient would copy; never copied on a test. */
  wouldCc: string[];
  wouldBcc: string[];
  bccMode: CampaignBccMode;
}

export async function sendTest(
  store: DataStore,
  organizationId: string,
  campaignId: string,
  deps: Pick<BatchDeps, 'sender' | 'storage' | 'appUrl'> & {
    to: string;
    actor: CampaignActor;
    recipientId?: string | null;
  },
): Promise<Result<TestSendResult>> {
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
    const copySettings = extrasAvailable(store, campaign) ? copySettingsOf(campaign) : null;
    // The recipient's photo, as their real email would carry it.
    let photo: OutgoingCampaignEmail['attachments'][number] | null = null;
    if (copySettings && sample?.photo_id) {
      const found = await store.findOne('campaign_photos', organizationId, {
        eq: { id: sample.photo_id, campaign_id: campaign.id },
      });
      const loaded = await loadPhoto(
        deps.storage,
        found,
        campaign.attachments.reduce((sum, a) => sum + a.size, 0),
      );
      if (!loaded.ok) {
        return err(
          loaded.error.code,
          `The photo for ${recipientLabel(sample)} could not be attached, so the test was not sent. ${loaded.error.message.replace(/, so this email was not sent\.$/, '.')}`,
        );
      }
      photo = loaded.value;
    }
    // A guest's personal RSVP link never goes into a test: it would let the
    // tester answer as that guest. The test shows the link's text instead.
    const { rsvp_link: _guestLink, ...sampleMerge } = sample?.merge ?? {};
    // No `copies`: the test email has no Cc and no Bcc, whatever the campaign copies.
    const email = composeCampaignEmail(
      campaign,
      { email: to, name: sample?.name ?? null, merge: sampleMerge },
      {
        signatureHtml,
        urls,
        attachments: photo ? [...attachments.value, photo] : attachments.value,
        subjectPrefix: '[Test] ',
      },
    );
    const sent = await deps.sender.send({ ...email, to });
    if (!sent.ok) return sent;
    await audit(store, organizationId, deps.actor.userId, 'campaign.test_sent', campaign.id, {
      as_recipient: Boolean(sample),
    });
    const would =
      copySettings && sample
        ? copiesFor(sample.email, {
            campaignCc: copySettings.cc,
            personalCc: cleanCopyList(sample.cc),
            bcc: copySettings.bcc,
          })
        : NO_COPIES;
    return ok({
      to,
      as: sample?.email ?? null,
      photo: photo?.filename ?? null,
      wouldCc: would.cc,
      wouldBcc: would.bcc,
      bccMode: copySettings?.bccMode ?? 'every',
    });
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
    // A link from the body as confirmed, or (an event message, D-075) this
    // recipient's own personal RSVP link exactly as the server wrote it.
    if (
      !campaign ||
      !isTrackableHref(url) ||
      !(campaign.link_allowlist.includes(url) || isOwnRsvpLink(campaign, r, url))
    ) {
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

/**
 * Whether a sent email went with copies (CC or BCC). A bounce in its thread
 * may then be about a dead copy address rather than the recipient, so it
 * counts against the recipient only when it names their address (see
 * checkReplies). copy_count says so for an email that sent normally; for one
 * settled from Sent after an interruption, the copies it would have carried
 * do: every email's CC and the person's own, BCC on every email, or the
 * first-only sample on the email that claimed it, which claims it straight
 * after that email's attempt is marked and before the next one's (they are
 * at least the send interval apart).
 */
function sentWithCopies(r: CampaignRecipient, campaign: Campaign | undefined): boolean {
  if ((r.copy_count ?? 0) > 0 || cleanCopyList(r.cc).length > 0) return true;
  if (!campaign) return false;
  const copies = copySettingsOf(campaign);
  if (copies.cc.length) return true;
  if (!copies.bcc.length) return false;
  if (copies.bccMode === 'every') return true;
  if (!copies.bccSampleAt || !r.attempted_at) return false;
  const gap = Date.parse(copies.bccSampleAt) - Date.parse(r.attempted_at);
  return gap >= 0 && gap < SEND_INTERVAL_MS;
}

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
 * server (a bounce; for an email that went with copies, only one naming the
 * recipient's own address). Also settles "may have gone out" sends whose copy
 * turned up in Sent. Reads the mailbox only; sends nothing. Run when a
 * campaign is viewed and from the daily job.
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
    const campaigns = new Map(
      (
        await listWhereIn(
          store,
          'campaigns',
          organizationId,
          {},
          'id',
          open.map((r) => r.campaign_id),
        )
      ).map((c) => [c.id, c]),
    );

    let replies = 0;
    let bounces = 0;
    let autoReplies = 0;
    for (const r of open) {
      const threadId = threadByProvider.get(r.gmail_thread_id as string);
      if (!threadId) continue;
      const after = (byThread.get(threadId) ?? [])
        .filter((m) => Date.parse(m.sent_at) > Date.parse(r.sent_at as string))
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      // Without copies, any mail server's message in the thread is the
      // recipient's bounce, as it always was. With copies it may be about a
      // copy, so only one that names the recipient's own address counts: a
      // dead CC never marks the recipient bounced or stops their replies
      // being read.
      const copied = sentWithCopies(r, campaigns.get(r.campaign_id));
      const bounce = after.find(
        (m) => BOUNCE_SENDER.test(m.from_address) && (!copied || bounceNames(m, r.email)),
      );
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
