import 'server-only';
import { PROMPTS } from '@/lib/ai/prompts';
import { draftReplySchema } from '@/lib/ai/schemas';
import type { AuthContext } from '@/lib/auth/session';
import { getAI, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import {
  fenceUntrusted,
  UNTRUSTED_CONTENT_RULE,
  type UntrustedBlock,
} from '@/lib/security/injection';
import { checkAiBudget, recordAiUsage } from '@/lib/security/limits';
import type {
  Deal,
  DealAnalysis,
  DraftKind,
  EmailMessage,
  GeneratedDraft,
  PortfolioCompany,
} from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { latestAnalysis } from './deal-analysis';

/**
 * Draft generation.
 *
 * This product has no send capability and requests no send scope. Every draft
 * is stored with `sent: false` — a literal, permanently false field — so the UI
 * can state that plainly rather than leaving the user to infer it.
 */

export interface CreateDraftInput {
  kind: DraftKind;
  dealId?: string | null;
  portfolioCompanyId?: string | null;
  emailMessageId?: string | null;
  /** Extra instruction from the user, e.g. "mention we met at the dinner". */
  guidance?: string;
}

export async function createDraft(
  auth: AuthContext,
  input: CreateDraftInput,
): Promise<Result<GeneratedDraft>> {
  const store = getStore();

  const budget = await checkAiBudget(store, auth.organizationId, auth.userId);
  if (!budget.ok) return budget;

  const blocks: UntrustedBlock[] = [];
  let deal: Deal | null = null;
  let analysis: DealAnalysis | null = null;
  let portfolio: PortfolioCompany | null = null;
  let sourceMessage: EmailMessage | null = null;
  const recipients: string[] = [];

  if (input.dealId) {
    deal = (await store.get('deals', auth.organizationId, input.dealId)) as Deal | null;
    if (!deal) return err('not_found', 'That deal does not exist.');
    analysis = await latestAnalysis(auth.organizationId, input.dealId);

    const people = await store.list('deal_people', auth.organizationId, {
      eq: { deal_id: input.dealId },
    });
    for (const p of people) {
      if (p.email) recipients.push(p.email);
    }
  }

  if (input.portfolioCompanyId) {
    portfolio = (await store.get(
      'portfolio_companies',
      auth.organizationId,
      input.portfolioCompanyId,
    )) as PortfolioCompany | null;
    if (!portfolio) return err('not_found', 'That portfolio company does not exist.');
    const contacts = await store.list('portfolio_contacts', auth.organizationId, {
      eq: { portfolio_company_id: input.portfolioCompanyId },
    });
    for (const c of contacts) {
      if (c.email) recipients.push(c.email);
    }
  }

  if (input.emailMessageId) {
    sourceMessage = (await store.get(
      'email_messages',
      auth.organizationId,
      input.emailMessageId,
    )) as EmailMessage | null;
    if (sourceMessage) {
      recipients.unshift(sourceMessage.from_address);
      blocks.push({
        sourceId: `email:${sourceMessage.id}`,
        sourceKind: 'email',
        label: `Message being replied to: ${sourceMessage.subject ?? '(no subject)'}`,
        text: truncate(sourceMessage.body_text ?? sourceMessage.snippet, 12_000),
        occurredAt: sourceMessage.sent_at,
      });
    }
  }

  const recipientName =
    sourceMessage?.from_name?.split(' ')[0] ??
    (recipients[0] ? recipients[0].split('@')[0] : null) ??
    'there';

  const context = {
    kind: input.kind,
    company_name: deal?.company_name ?? portfolio?.name ?? null,
    recipient_first_name: recipientName,
    subject: sourceMessage?.subject ?? null,
    guidance: input.guidance ?? null,
    missing_information: analysis?.missing_information ?? [],
    diligence_questions: analysis?.diligence_questions ?? [],
    reason:
      input.kind === 'pass'
        ? (analysis?.biggest_concern ?? deal?.outcome ?? '')
        : (analysis?.recommended_next_step ?? ''),
    recommendation: analysis?.recommendation ?? null,
  };

  const ai = getAI();
  const response = await ai.generateStructured({
    tier: 'deep',
    operation: 'draft.reply',
    promptVersion: PROMPTS.draftReply.version,
    system: PROMPTS.draftReply.system,
    messages: [
      {
        role: 'user',
        content: `<context>${JSON.stringify(context)}</context>

${UNTRUSTED_CONTENT_RULE}

<sources>
${fenceUntrusted(blocks)}
</sources>

Write the draft. This will be reviewed and sent by Nick himself — the product cannot send email.`,
      },
    ],
    schema: draftReplySchema,
    maxTokens: 4_000,
  });

  await recordAiUsage(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    operation: 'draft.reply',
    promptVersion: PROMPTS.draftReply.version,
    usage: response.ok ? response.value.usage : null,
    ok: response.ok,
    errorCode: response.ok ? null : response.error.code,
  });

  if (!response.ok) return response;

  const now = new Date().toISOString();
  const draft: GeneratedDraft = {
    id: newId(),
    organization_id: auth.organizationId,
    kind: input.kind,
    subject: response.value.value.subject,
    body: response.value.value.body,
    to_addresses: Array.from(new Set(recipients)).slice(0, 5),
    deal_id: input.dealId ?? null,
    portfolio_company_id: input.portfolioCompanyId ?? null,
    email_message_id: input.emailMessageId ?? null,
    sent: false,
    model: response.value.usage.model,
    prompt_version: PROMPTS.draftReply.version,
    created_by: auth.userId,
    created_at: now,
    updated_at: now,
  };
  await store.insert('generated_drafts', draft);

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'draft.created',
    entityType: 'generated_draft',
    entityId: draft.id,
    metadata: {
      kind: input.kind,
      deal_id: input.dealId ?? null,
      recipients: draft.to_addresses.length,
      sent: false,
    },
  });

  return ok(draft);
}

export async function listDrafts(
  organizationId: string,
  filters: { dealId?: string; portfolioCompanyId?: string; limit?: number } = {},
): Promise<GeneratedDraft[]> {
  const store = getStore();
  const filter: Parameters<typeof store.list>[2] = { eq: {} };
  if (filters.dealId) filter.eq!.deal_id = filters.dealId;
  if (filters.portfolioCompanyId) filter.eq!.portfolio_company_id = filters.portfolioCompanyId;
  return (await store.list('generated_drafts', organizationId, filter, {
    orderBy: [{ field: 'created_at', direction: 'desc' }],
    limit: filters.limit ?? 50,
  })) as GeneratedDraft[];
}

export async function updateDraft(
  auth: AuthContext,
  draftId: string,
  patch: { subject?: string; body?: string; to_addresses?: string[] },
): Promise<Result<GeneratedDraft>> {
  const store = getStore();
  const draft = await store.get('generated_drafts', auth.organizationId, draftId);
  if (!draft) return err('not_found', 'That draft does not exist.');
  const updated = (await store.update(
    'generated_drafts',
    auth.organizationId,
    draftId,
    patch,
  )) as GeneratedDraft;
  return ok(updated);
}

/**
 * Copy-ready plain text. There is deliberately no `sendDraft` function in this
 * module — sending is out of scope for the product, not merely unimplemented.
 */
export function draftAsPlainText(draft: GeneratedDraft): string {
  return [
    draft.to_addresses.length > 0 ? `To: ${draft.to_addresses.join(', ')}` : null,
    `Subject: ${draft.subject}`,
    '',
    draft.body,
  ]
    .filter((l) => l !== null)
    .join('\n');
}
