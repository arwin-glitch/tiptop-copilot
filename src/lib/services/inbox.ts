import 'server-only';
import { PROMPTS } from '@/lib/ai/prompts';
import { emailClassificationSchema } from '@/lib/ai/schemas';
import type { AuthContext } from '@/lib/auth/session';
import { envLimits } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { extractDocument } from '@/lib/documents/extract';
import type { EmailProvider, RawEmailHeader } from '@/lib/email/provider';
import { getAI, getEmailProvider, getStorage, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { fenceUntrusted, scanForInjection } from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import { log } from '@/lib/security/redact';
import type {
  EmailAttachment,
  EmailCategory,
  EmailMessage,
  EmailThread,
  Integration,
  PortfolioCompany,
  SyncRun,
  Deal,
} from '@/lib/types/domain';
import { ingestGranolaNote, isGranolaNoteEmail, parseGranolaEmail } from '@/lib/services/meetings';
import { newId, sha256, syncIdempotencyKey } from '@/lib/util/hash';
import { emailDomain, sanitizeFilename, snippet } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Inbox intelligence.
 *
 * Privacy posture, deliberately: a routine sync stores metadata and a snippet
 * only. Full bodies and attachments are fetched when the user opens a message,
 * when the classifier judges the message consequential, or when deep automatic
 * analysis has been explicitly enabled. That keeps the default footprint small
 * without making the product feel half-connected.
 *
 * Idempotency: every message upserts on
 * `(organization_id, provider, provider_message_id)` and every run records a
 * deterministic idempotency key. Re-running a sync is a no-op by construction,
 * not by a retry counter.
 */

export interface SyncResult {
  seen: number;
  created: number;
  updated: number;
  classified: number;
  deepFetched: number;
  cursor: string | null;
  fellBackToFullSync: boolean;
  runId: string;
}

export async function getPrimaryIntegration(
  store: DataStore,
  organizationId: string,
): Promise<Integration | null> {
  const rows = (await store.list(
    'integrations',
    organizationId,
    { eq: { provider: 'google' } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 1 },
  )) as Integration[];
  return rows[0] ?? null;
}

export async function syncMailbox(
  auth: AuthContext,
  options: { lookbackDays?: number; maxMessages?: number; force?: boolean } = {},
): Promise<Result<SyncResult>> {
  const store = getStore();
  const limits = envLimits();
  const integration = await getPrimaryIntegration(store, auth.organizationId);
  const provider = getEmailProvider(integration);

  if (!provider) {
    return err(
      'not_configured',
      'No mailbox is connected. Connect Google Workspace in Settings to sync email.',
      { stillUsable: 'Deals, portfolio, knowledge and tasks work without a mailbox connection.' },
    );
  }
  if (!integration) {
    return err('not_configured', 'No mailbox integration record exists yet.');
  }

  const lookbackDays = options.lookbackDays ?? limits.defaultLookbackDays;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const maxMessages = Math.min(
    options.maxMessages ?? limits.maxEmailsPerSync,
    limits.maxEmailsPerSync,
  );

  const idempotencyKey = syncIdempotencyKey({
    organizationId: auth.organizationId,
    integrationId: integration.id,
    provider: 'google',
    cursor: integration.sync_cursor ?? 'initial',
    windowStart: since.slice(0, 13), // hour granularity
  });

  // An identical run that already succeeded is returned as-is rather than
  // repeated. This is what makes a retried webhook or double-click safe.
  const priorRun = (await store.findOne('sync_runs', auth.organizationId, {
    eq: { idempotency_key: idempotencyKey, status: 'succeeded' },
  })) as SyncRun | null;
  if (priorRun && !options.force) {
    return ok({
      seen: priorRun.items_seen,
      created: 0,
      updated: 0,
      classified: 0,
      deepFetched: 0,
      cursor: integration.sync_cursor,
      fellBackToFullSync: false,
      runId: priorRun.id,
    });
  }

  const run: SyncRun = {
    id: newId(),
    organization_id: auth.organizationId,
    integration_id: integration.id,
    kind: 'gmail',
    idempotency_key: idempotencyKey,
    status: 'running',
    items_seen: 0,
    items_created: 0,
    items_updated: 0,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  // The upsert keys on the idempotency key, so a forced re-run of an existing
  // key reuses that row's id. Every later update has to target the id the
  // store actually holds, not the one we just generated.
  const runRow = await store.upsert('sync_runs', run, [
    'organization_id',
    'integration_id',
    'idempotency_key',
  ]);
  const runId = runRow.row.id;

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'integration.sync_started',
    entityType: 'integration',
    entityId: integration.id,
    metadata: { lookback_days: lookbackDays, max_messages: maxMessages },
  });

  const listed = await provider.listMessages({
    cursor: integration.sync_cursor,
    since,
    maxResults: maxMessages,
  });

  if (!listed.ok) {
    await store.update('sync_runs', auth.organizationId, runId, {
      status: 'failed',
      error: listed.error.message,
      finished_at: new Date().toISOString(),
    });
    await store.update('integrations', auth.organizationId, integration.id, {
      last_sync_error: listed.error.message,
      status: listed.error.code === 'provider_unauthorized' ? 'needs_reauth' : integration.status,
    });
    return listed;
  }

  let created = 0;
  let updated = 0;
  let classified = 0;
  let deepFetched = 0;

  const deals = (await store.list('deals', auth.organizationId, {
    eq: { is_archived: false },
  })) as Deal[];
  const portfolio = (await store.list('portfolio_companies', auth.organizationId, {
    eq: { is_archived: false },
  })) as PortfolioCompany[];

  for (const header of listed.value.messages) {
    const threadResult = await upsertThread(store, auth.organizationId, header);
    const existing = (await store.findOne('email_messages', auth.organizationId, {
      eq: { provider: 'google', provider_message_id: header.providerMessageId },
    })) as EmailMessage | null;

    const row = toEmailMessageRow(auth.organizationId, header, threadResult.id, existing);
    const result = await store.upsert('email_messages', row, [
      'organization_id',
      'provider',
      'provider_message_id',
    ]);
    if (result.created) created++;
    else updated++;

    // A Granola note travelling as email is transport, not correspondence.
    // Promote it to a meeting note before classification would waste a model
    // call on it. Needs no AI, so it works with the provider switched off.
    if (isGranolaNoteEmail(header.subject)) {
      const promoted = await promoteGranolaEmail(auth, result.row.id);
      if (promoted) continue;
      // Parse failed: fall through and treat it as ordinary email, visible in
      // the Inbox — a broken Zap template must not make messages disappear.
    }

    // Classify only what we have not classified before, or what changed.
    if (!existing || existing.category === 'unknown') {
      const classification = await classifyMessage(auth, result.row.id, {
        deals,
        portfolio,
        provider,
      });
      if (classification.ok) {
        classified++;
        if (classification.value.warrantsDeepFetch && limits.autoAnalyzeEnabled) {
          const fetched = await fetchFullMessage(auth, result.row.id);
          if (fetched.ok) deepFetched++;
        }
      }
    }
  }

  await store.update('sync_runs', auth.organizationId, runId, {
    status: 'succeeded',
    items_seen: listed.value.messages.length,
    items_created: created,
    items_updated: updated,
    finished_at: new Date().toISOString(),
  });
  await store.update('integrations', auth.organizationId, integration.id, {
    sync_cursor: listed.value.nextCursor,
    last_sync_at: new Date().toISOString(),
    last_sync_error: null,
    status: 'connected',
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'integration.sync_finished',
    entityType: 'integration',
    entityId: integration.id,
    metadata: { seen: listed.value.messages.length, created, updated, classified, deepFetched },
  });

  return ok({
    seen: listed.value.messages.length,
    created,
    updated,
    classified,
    deepFetched,
    cursor: listed.value.nextCursor,
    fellBackToFullSync: listed.value.fellBackToFullSync,
    runId,
  });
}

async function upsertThread(
  store: DataStore,
  organizationId: string,
  header: RawEmailHeader,
): Promise<EmailThread> {
  const existing = (await store.findOne('email_threads', organizationId, {
    eq: { provider: 'google', provider_thread_id: header.providerThreadId },
  })) as EmailThread | null;

  const row: EmailThread = {
    id: existing?.id ?? newId(),
    organization_id: organizationId,
    provider: 'google',
    provider_thread_id: header.providerThreadId,
    subject: existing?.subject ?? header.subject,
    last_message_at:
      existing && Date.parse(existing.last_message_at) > Date.parse(header.sentAt)
        ? existing.last_message_at
        : header.sentAt,
    message_count: (existing?.message_count ?? 0) + (existing ? 0 : 1),
    created_at: existing?.created_at ?? header.sentAt,
    updated_at: new Date().toISOString(),
  };
  const result = await store.upsert('email_threads', row, [
    'organization_id',
    'provider',
    'provider_thread_id',
  ]);
  return result.row;
}

function toEmailMessageRow(
  organizationId: string,
  header: RawEmailHeader,
  threadId: string,
  existing: EmailMessage | null,
): EmailMessage {
  return {
    id: existing?.id ?? newId(),
    organization_id: organizationId,
    thread_id: threadId,
    provider: 'google',
    provider_message_id: header.providerMessageId,
    subject: header.subject,
    snippet: header.snippet,
    from_name: header.from.name,
    from_address: header.from.address,
    to_addresses: header.to.map((t) => t.address),
    cc_addresses: header.cc.map((c) => c.address),
    labels: header.labels,
    is_unread: header.isUnread,
    sent_at: header.sentAt,
    // Preserve anything already fetched; a metadata sync must not erase a body.
    body_text: existing?.body_text ?? null,
    body_fetched_at: existing?.body_fetched_at ?? null,
    body_hash: existing?.body_hash ?? null,
    has_attachments: header.hasAttachments,
    category: existing?.category ?? 'unknown',
    category_confidence: existing?.category_confidence ?? null,
    category_source: existing?.category_source ?? null,
    importance: existing?.importance ?? null,
    is_ignored: existing?.is_ignored ?? false,
    linked_deal_id: existing?.linked_deal_id ?? null,
    linked_portfolio_company_id: existing?.linked_portfolio_company_id ?? null,
    injection_flagged: existing?.injection_flagged ?? false,
    created_at: existing?.created_at ?? header.sentAt,
    updated_at: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------- classification */

export interface ClassificationResult {
  category: EmailCategory;
  confidence: number;
  importance: number;
  warrantsDeepFetch: boolean;
  containsInstructionToAi: boolean;
}

export async function classifyMessage(
  auth: AuthContext,
  messageId: string,
  context?: {
    deals?: Deal[];
    portfolio?: PortfolioCompany[];
    provider?: EmailProvider;
  },
): Promise<Result<ClassificationResult>> {
  const store = getStore();
  const message = (await store.get(
    'email_messages',
    auth.organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return err('not_found', 'That email does not exist.');

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const deals =
    context?.deals ??
    ((await store.list('deals', auth.organizationId, { eq: { is_archived: false } })) as Deal[]);
  const portfolio =
    context?.portfolio ??
    ((await store.list('portfolio_companies', auth.organizationId, {
      eq: { is_archived: false },
    })) as PortfolioCompany[]);

  const promptContext = {
    subject: message.subject,
    from_address: message.from_address,
    from_name: message.from_name,
    to_addresses: message.to_addresses,
    labels: message.labels,
    sent_at: message.sent_at,
    has_attachments: message.has_attachments,
    snippet: message.snippet,
    deal_domains: deals.map((d) => d.domain).filter((d): d is string => Boolean(d)),
    portfolio_domains: portfolio.map((p) => p.domain).filter((d): d is string => Boolean(d)),
    lp_domains: [] as string[],
  };

  const scan = scanForInjection(`${message.subject ?? ''}\n${message.snippet}`);

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'fast',
    operation: 'email.classify',
    promptVersion: PROMPTS.emailClassification.version,
    system: PROMPTS.emailClassification.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(promptContext)}</context>

<sources>
${fenceUntrusted([
  {
    sourceId: `email:${message.id}`,
    sourceKind: 'email',
    label: message.subject ?? '(no subject)',
    text: message.snippet,
    occurredAt: message.sent_at,
  },
])}
</sources>

Classify this message.`,
      },
    ],
    schema: emailClassificationSchema,
    maxTokens: 2_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'email.classify',
    promptVersion: PROMPTS.emailClassification.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;
  const output = response.value.value;

  // Deterministic detection is authoritative for the flag; the model's opinion
  // can only add to it, never clear it.
  const flagged = scan.highestSeverity === 'high' || output.contains_instruction_to_ai;

  const linkedPortfolio = portfolio.find(
    (p) => p.domain && emailDomain(message.from_address) === p.domain,
  );
  const linkedDeal = deals.find((d) => d.domain && emailDomain(message.from_address) === d.domain);

  await store.update('email_messages', auth.organizationId, messageId, {
    category: output.category,
    category_confidence: output.confidence,
    category_source: 'model',
    importance: output.importance,
    injection_flagged: flagged,
    linked_portfolio_company_id: message.linked_portfolio_company_id ?? linkedPortfolio?.id ?? null,
    linked_deal_id: message.linked_deal_id ?? linkedDeal?.id ?? null,
  });

  if (flagged) {
    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'security.injection_flagged',
      entityType: 'email_message',
      entityId: messageId,
      metadata: {
        patterns: scan.signals.slice(0, 3).map((s) => s.pattern),
        model_agreed: output.contains_instruction_to_ai,
      },
    });
  }

  return ok({
    category: output.category,
    confidence: output.confidence,
    importance: output.importance,
    warrantsDeepFetch: output.warrants_deep_fetch,
    containsInstructionToAi: flagged,
  });
}

/** Manual re-classification by the user always wins over the model's. */
export async function setCategory(
  auth: AuthContext,
  messageId: string,
  category: EmailCategory,
): Promise<Result<true>> {
  const store = getStore();
  const message = await store.get('email_messages', auth.organizationId, messageId);
  if (!message) return err('not_found', 'That email does not exist.');
  await store.update('email_messages', auth.organizationId, messageId, {
    category,
    category_source: 'human',
    category_confidence: 1,
  });
  return ok(true);
}

export async function ignoreMessage(
  auth: AuthContext,
  messageId: string,
  ignored = true,
): Promise<Result<true>> {
  const store = getStore();
  const message = await store.get('email_messages', auth.organizationId, messageId);
  if (!message) return err('not_found', 'That email does not exist.');
  await store.update('email_messages', auth.organizationId, messageId, { is_ignored: ignored });
  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'email.ignored',
    entityType: 'email_message',
    entityId: messageId,
    metadata: { ignored },
  });
  return ok(true);
}

/* ------------------------------------------------------------- deep fetch */

/**
 * Fetch the full body and attachments for one message.
 *
 * This is the only place message content enters storage, and it is always a
 * deliberate act: the user opened it, the classifier flagged it, or automatic
 * deep analysis is switched on.
 */
/**
 * Turn a Granola transport email into a meeting note.
 *
 * Returns true only when the envelope parsed and the note was ingested; the
 * email is then marked ignored and categorised by rule, because its entire
 * content now lives somewhere more visible. On any failure it returns false
 * and the email stays exactly as it arrived — a mis-mapped Zap template gets
 * a visible email in the Inbox rather than a silently swallowed note.
 */
export async function promoteGranolaEmail(auth: AuthContext, messageId: string): Promise<boolean> {
  const store = getStore();

  // The routine sync stores metadata only; the envelope lives in the body.
  const fetched = await fetchFullMessage(auth, messageId);
  if (!fetched.ok) return false;

  const message = (await store.get(
    'email_messages',
    auth.organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return false;

  const payload = parseGranolaEmail(message.subject, message.body_text);
  if (!payload) return false;

  const ingested = await ingestGranolaNote(store, auth.organizationId, payload);
  if (!ingested.ok) return false;

  await store.update('email_messages', auth.organizationId, messageId, {
    is_ignored: true,
    category: 'administrative',
    category_source: 'rule',
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'meeting_note.ingested_from_email',
    entityType: 'email_message',
    entityId: messageId,
    metadata: { note_id: ingested.value.id, flagged: ingested.value.flagged },
  });

  return true;
}

export async function fetchFullMessage(
  auth: AuthContext,
  messageId: string,
): Promise<Result<{ bodyFetched: boolean; attachments: number }>> {
  const store = getStore();
  const message = (await store.get(
    'email_messages',
    auth.organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return err('not_found', 'That email does not exist.');
  if (message.body_text) {
    const existing = (await store.list('email_attachments', auth.organizationId, {
      eq: { message_id: messageId },
    })) as EmailAttachment[];
    return ok({ bodyFetched: false, attachments: existing.length });
  }

  const integration = await getPrimaryIntegration(store, auth.organizationId);
  const provider = getEmailProvider(integration);
  if (!provider) {
    return err('not_configured', 'No mailbox is connected, so the full message cannot be fetched.');
  }

  const full = await provider.getMessage(message.provider_message_id);
  if (!full.ok) return full;

  const scan = scanForInjection(full.value.bodyText);
  await store.update('email_messages', auth.organizationId, messageId, {
    body_text: full.value.bodyText,
    body_fetched_at: new Date().toISOString(),
    body_hash: sha256(full.value.bodyText),
    injection_flagged: message.injection_flagged || scan.highestSeverity === 'high',
  });

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'email.body_fetched',
    entityType: 'email_message',
    entityId: messageId,
    metadata: { attachments: full.value.attachments.length, injection_flagged: scan.flagged },
  });

  const limits = envLimits();
  let stored = 0;
  for (const ref of full.value.attachments) {
    if (stored >= limits.maxAttachmentsPerAnalysis) break;
    if (ref.sizeBytes > limits.maxAttachmentBytes) {
      await store.upsert(
        'email_attachments',
        buildAttachmentRow(auth.organizationId, messageId, ref, {
          error: `File is ${(ref.sizeBytes / 1_048_576).toFixed(1)} MB, over the ${(limits.maxAttachmentBytes / 1_048_576).toFixed(0)} MB limit. Download it from the mailbox instead.`,
        }),
        ['message_id', 'provider_attachment_id'],
      );
      continue;
    }

    const row = buildAttachmentRow(auth.organizationId, messageId, ref, {});
    const upserted = await store.upsert('email_attachments', row, [
      'message_id',
      'provider_attachment_id',
    ]);
    stored++;

    const bytes = await provider.getAttachment(
      message.provider_message_id,
      ref.providerAttachmentId,
    );
    if (!bytes.ok) {
      await store.update('email_attachments', auth.organizationId, upserted.row.id, {
        extraction_error: bytes.error.message,
        needs_review: true,
      });
      continue;
    }

    const objectPath = `${auth.organizationId}/attachments/${upserted.row.id}/${row.safe_filename}`;
    const put = await getStorage().put(objectPath, bytes.value, ref.mimeType);

    const extracted = await extractDocument({
      bytes: bytes.value,
      filename: ref.filename,
      mimeType: ref.mimeType,
    });

    await store.update('email_attachments', auth.organizationId, upserted.row.id, {
      storage_path: put.ok ? objectPath : null,
      extracted_text: extracted.ok ? extracted.value.text : null,
      page_count: extracted.ok ? extracted.value.pageCount : null,
      extraction_confidence: extracted.ok ? extracted.value.confidence : 'low',
      extraction_error: extracted.ok ? null : extracted.error.message,
      needs_review: extracted.ok ? extracted.value.needsReview : true,
      content_hash: sha256(bytes.value),
    });

    await recordAudit(store, {
      organizationId: auth.organizationId,
      userId: auth.userId,
      action: 'attachment.extracted',
      entityType: 'email_attachment',
      entityId: upserted.row.id,
      metadata: {
        mime_type: ref.mimeType,
        pages: extracted.ok ? extracted.value.pageCount : null,
        confidence: extracted.ok ? extracted.value.confidence : 'failed',
      },
    });
  }

  return ok({ bodyFetched: true, attachments: stored });
}

function buildAttachmentRow(
  organizationId: string,
  messageId: string,
  ref: { providerAttachmentId: string; filename: string; mimeType: string; sizeBytes: number },
  extra: { error?: string },
): EmailAttachment {
  const now = new Date().toISOString();
  return {
    id: sha256(`${messageId}:${ref.providerAttachmentId}`).slice(0, 32),
    organization_id: organizationId,
    message_id: messageId,
    provider_attachment_id: ref.providerAttachmentId,
    filename: ref.filename,
    safe_filename: sanitizeFilename(ref.filename),
    mime_type: ref.mimeType,
    size_bytes: ref.sizeBytes,
    storage_path: null,
    extracted_text: null,
    page_count: null,
    extraction_confidence: null,
    extraction_error: extra.error ?? null,
    needs_review: Boolean(extra.error),
    content_hash: null,
    created_at: now,
    updated_at: now,
  };
}

/* ------------------------------------------------------------------ views */

export interface InboxFilters {
  category?: EmailCategory;
  unreadOnly?: boolean;
  search?: string;
  sinceDays?: number;
  includeIgnored?: boolean;
  limit?: number;
}

export async function listInbox(
  organizationId: string,
  filters: InboxFilters = {},
): Promise<EmailMessage[]> {
  const store = getStore();
  const filter: Parameters<typeof store.list>[2] = { eq: {} };
  if (filters.category) filter.eq!.category = filters.category;
  if (filters.unreadOnly) filter.eq!.is_unread = true;
  if (!filters.includeIgnored) filter.eq!.is_ignored = false;
  if (filters.sinceDays) {
    filter.gte = {
      sent_at: new Date(Date.now() - filters.sinceDays * 86_400_000).toISOString(),
    };
  }
  if (filters.search) {
    filter.textSearch = {
      columns: ['subject', 'snippet', 'from_address', 'from_name', 'body_text'],
      query: filters.search,
    };
  }
  return (await store.list('email_messages', organizationId, filter, {
    orderBy: [{ field: 'sent_at', direction: 'desc' }],
    limit: filters.limit ?? 100,
  })) as EmailMessage[];
}

export async function getMessageDetail(
  organizationId: string,
  messageId: string,
): Promise<{
  message: EmailMessage;
  attachments: EmailAttachment[];
  thread: EmailMessage[];
} | null> {
  const store = getStore();
  const message = (await store.get(
    'email_messages',
    organizationId,
    messageId,
  )) as EmailMessage | null;
  if (!message) return null;
  const [attachments, thread] = await Promise.all([
    store.list('email_attachments', organizationId, {
      eq: { message_id: messageId },
    }) as Promise<EmailAttachment[]>,
    store.list(
      'email_messages',
      organizationId,
      { eq: { thread_id: message.thread_id } },
      { orderBy: [{ field: 'sent_at', direction: 'asc' }] },
    ) as Promise<EmailMessage[]>,
  ]);
  return { message, attachments, thread };
}

/** Delete every synchronised mailbox record for this organization. */
export async function deleteSyncedEmail(auth: AuthContext): Promise<Result<{ deleted: number }>> {
  const store = getStore();
  let deleted = 0;
  deleted += await store.removeWhere('email_attachments', auth.organizationId, {});
  deleted += await store.removeWhere('email_messages', auth.organizationId, {});
  deleted += await store.removeWhere('email_threads', auth.organizationId, {});
  deleted += await store.removeWhere('sync_runs', auth.organizationId, { eq: { kind: 'gmail' } });

  const integration = await getPrimaryIntegration(store, auth.organizationId);
  if (integration) {
    await store.update('integrations', auth.organizationId, integration.id, {
      sync_cursor: null,
      last_sync_at: null,
    });
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'integration.data_deleted',
    entityType: 'integration',
    entityId: integration?.id ?? null,
    metadata: { rows_deleted: deleted, scope: 'email' },
  });
  log.info('Deleted synchronised email data', { organizationId: auth.organizationId, deleted });
  return ok({ deleted });
}

export function messageSnippet(message: EmailMessage): string {
  return snippet(message.body_text ?? message.snippet, 220);
}
