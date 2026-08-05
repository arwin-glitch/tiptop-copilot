import 'server-only';
import { CitationRegistry } from '@/lib/ai/citations';
import { fenceUntrusted, type UntrustedBlock } from '@/lib/security/injection';
import { splitPages } from '@/lib/documents/pages';
import type { DataStore } from '@/lib/db/store';
import type {
  Citation,
  Deal,
  DealDecision,
  DealNote,
  DealSource,
  EmailAttachment,
  EmailMessage,
} from '@/lib/types/domain';
import { truncate } from '@/lib/util/text';

/**
 * Assembles the evidence bundle for a deal: the fenced source text a model
 * sees, and the citation registry that validates whatever it cites back.
 *
 * Both halves come from the same pass, which is the point — a model can only
 * cite something that was actually put in front of it, and the registry is the
 * proof.
 */

export interface EvidenceBundle {
  registry: CitationRegistry;
  blocks: UntrustedBlock[];
  fenced: string;
  /** Content hashes of every source, for cache reuse and idempotency. */
  sourceHashes: string[];
  sourceCount: number;
  counts: {
    documents: number;
    founderClaims: number;
    thirdParty: number;
  };
}

const MAX_CHARS_PER_SOURCE = 24_000;

export async function buildDealEvidence(
  store: DataStore,
  organizationId: string,
  deal: Deal,
  options: { maxAttachments?: number } = {},
): Promise<EvidenceBundle> {
  const registry = new CitationRegistry();
  const blocks: UntrustedBlock[] = [];
  const sourceHashes: string[] = [];
  let documents = 0;
  let founderClaims = 0;
  let thirdParty = 0;

  const sources = (await store.list('deal_sources', organizationId, {
    eq: { deal_id: deal.id },
  })) as DealSource[];

  const messageIds = sources.filter((s) => s.kind === 'email_message').map((s) => s.ref_id);
  const attachmentIds = sources.filter((s) => s.kind === 'attachment').map((s) => s.ref_id);

  for (const id of messageIds) {
    if (!id) continue;
    const message = (await store.get('email_messages', organizationId, id)) as EmailMessage | null;
    if (!message) continue;
    const text = message.body_text ?? message.snippet;
    const citationId = `email:${message.id}`;
    registry.add({
      id: citationId,
      kind: 'email',
      ref_id: message.id,
      label: message.subject ?? '(no subject)',
      page: null,
      section: null,
      url: null,
      occurred_at: message.sent_at,
      retrieved_at: message.body_fetched_at,
      publisher: message.from_address,
      excerpt: truncate(text, 240),
    });
    blocks.push({
      sourceId: citationId,
      sourceKind: 'email',
      label: `Email from ${message.from_name ?? message.from_address}: ${message.subject ?? '(no subject)'}`,
      text: truncate(text, MAX_CHARS_PER_SOURCE),
      occurredAt: message.sent_at,
    });
    if (message.body_hash) sourceHashes.push(message.body_hash);
    // Anything the company itself wrote is a founder claim until corroborated.
    const isFromCompany = deal.domain
      ? message.from_address.toLowerCase().endsWith(`@${deal.domain}`)
      : false;
    if (isFromCompany) founderClaims++;
    else thirdParty++;
  }

  const attachmentLimit = options.maxAttachments ?? 5;
  let used = 0;
  for (const id of attachmentIds) {
    if (!id || used >= attachmentLimit) continue;
    const attachment = (await store.get(
      'email_attachments',
      organizationId,
      id,
    )) as EmailAttachment | null;
    if (!attachment?.extracted_text) continue;
    used++;
    documents++;
    if (attachment.content_hash) sourceHashes.push(attachment.content_hash);

    // One block per page, so a citation can carry a real page number.
    const pages = splitPages(attachment.extracted_text);
    for (const page of pages) {
      const citationId = `attachment:${attachment.id}:p${page.page}`;
      registry.add({
        id: citationId,
        kind: 'attachment',
        ref_id: attachment.id,
        label: attachment.filename,
        page: page.page,
        section: null,
        url: null,
        occurred_at: attachment.created_at,
        retrieved_at: attachment.updated_at,
        publisher: null,
        excerpt: truncate(page.text, 240),
      });
      blocks.push({
        sourceId: citationId,
        sourceKind: 'attachment',
        label: `${attachment.filename}, page ${page.page}`,
        text: truncate(page.text, MAX_CHARS_PER_SOURCE),
        page: page.page,
        occurredAt: attachment.created_at,
      });
    }
  }

  // Nick's own notes are evidence too, and are labelled distinctly.
  const notes = (await store.list(
    'deal_notes',
    organizationId,
    { eq: { deal_id: deal.id } },
    { orderBy: [{ field: 'created_at', direction: 'desc' }], limit: 10 },
  )) as DealNote[];
  for (const note of notes) {
    const citationId = `note:${note.id}`;
    registry.add({
      id: citationId,
      kind: 'note',
      ref_id: deal.id,
      label: `Note from ${new Date(note.created_at).toISOString().slice(0, 10)}`,
      page: null,
      section: null,
      url: null,
      occurred_at: note.created_at,
      retrieved_at: null,
      publisher: null,
      excerpt: truncate(note.body, 240),
    });
    blocks.push({
      sourceId: citationId,
      sourceKind: 'nick_note',
      label: 'Note written by Nick in TipTop Copilot',
      text: truncate(note.body, 4_000),
      occurredAt: note.created_at,
    });
  }

  return {
    registry,
    blocks,
    fenced: fenceUntrusted(blocks),
    sourceHashes,
    sourceCount: blocks.length,
    counts: { documents, founderClaims, thirdParty },
  };
}

/**
 * Prior decisions, registered as citable sources so a recommendation that
 * leans on precedent has to point at the specific decision it leaned on.
 */
export async function loadPriorDecisions(
  store: DataStore,
  organizationId: string,
  excludeDealId: string,
  limit = 8,
): Promise<{
  decisions: {
    deal_id: string;
    company: string;
    decision: string;
    rationale: string;
    decided_at: string;
  }[];
  citations: Citation[];
}> {
  const decisions = (await store.list(
    'deal_decisions',
    organizationId,
    {},
    { orderBy: [{ field: 'decided_at', direction: 'desc' }], limit: limit * 2 },
  )) as DealDecision[];

  const out: {
    deal_id: string;
    company: string;
    decision: string;
    rationale: string;
    decided_at: string;
  }[] = [];
  const citations: Citation[] = [];

  for (const decision of decisions) {
    if (decision.deal_id === excludeDealId) continue;
    if (out.length >= limit) break;
    const deal = (await store.get('deals', organizationId, decision.deal_id)) as Deal | null;
    if (!deal) continue;
    out.push({
      deal_id: deal.id,
      company: deal.company_name,
      decision: decision.decision,
      rationale: decision.rationale,
      decided_at: decision.decided_at,
    });
    citations.push({
      id: `decision:${decision.id}`,
      kind: 'prior_decision',
      ref_id: deal.id,
      label: `${deal.company_name} — ${decision.decision}`,
      page: null,
      section: null,
      url: null,
      occurred_at: decision.decided_at,
      retrieved_at: null,
      publisher: null,
      excerpt: truncate(decision.rationale, 240),
    });
  }

  return { decisions: out, citations };
}
