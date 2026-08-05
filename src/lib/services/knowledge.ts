import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import { envLimits } from '@/lib/config/env';
import { extractDocument, isSupportedMimeType, sniffMimeType } from '@/lib/documents/extract';
import { splitPages } from '@/lib/documents/pages';
import { getStorage, getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import type {
  KnowledgeChunk,
  KnowledgeDocType,
  KnowledgeDocument,
  NetworkContact,
} from '@/lib/types/domain';
import { newId, sha256 } from '@/lib/util/hash';
import { sanitizeFilename, truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Knowledge base: uploaded documents, page-aware chunking, full-text retrieval
 * and the network contact list.
 *
 * Retrieval goes through a provider interface so a vector implementation can be
 * added later without touching callers. Postgres full-text search is the
 * default because it needs no additional service and no embedding provider.
 */

/* ------------------------------------------------------ retrieval provider */

export interface RetrievalHit {
  documentId: string;
  documentTitle: string;
  docType: KnowledgeDocType;
  chunkId: string;
  page: number | null;
  section: string | null;
  text: string;
  score: number;
}

export interface RetrievalProvider {
  readonly kind: 'postgres_fts' | 'vector';
  search(organizationId: string, query: string, limit: number): Promise<RetrievalHit[]>;
}

export class FullTextRetrievalProvider implements RetrievalProvider {
  readonly kind = 'postgres_fts' as const;

  async search(organizationId: string, query: string, limit = 8): Promise<RetrievalHit[]> {
    const store = getStore();
    const hits = await store.search('knowledge_chunks', organizationId, query, ['text'], {}, limit);
    const docs = new Map<string, KnowledgeDocument>();
    const out: RetrievalHit[] = [];

    for (const hit of hits) {
      const chunk = hit.row as KnowledgeChunk;
      let doc = docs.get(chunk.document_id);
      if (!doc) {
        const loaded = (await store.get(
          'knowledge_documents',
          organizationId,
          chunk.document_id,
        )) as KnowledgeDocument | null;
        if (!loaded) continue;
        doc = loaded;
        docs.set(doc.id, doc);
      }
      out.push({
        documentId: doc.id,
        documentTitle: doc.title,
        docType: doc.doc_type,
        chunkId: chunk.id,
        page: chunk.page,
        section: chunk.section,
        text: chunk.text,
        score: hit.rank,
      });
    }
    return out;
  }
}

let retrievalSingleton: RetrievalProvider | null = null;

export function getRetrievalProvider(): RetrievalProvider {
  if (!retrievalSingleton) retrievalSingleton = new FullTextRetrievalProvider();
  return retrievalSingleton;
}

/* ----------------------------------------------------------------- upload */

export interface UploadInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  title?: string;
  docType: KnowledgeDocType;
}

export async function uploadDocument(
  auth: AuthContext,
  input: UploadInput,
): Promise<Result<{ document: KnowledgeDocument; chunks: number; contactsImported: number }>> {
  const limits = envLimits();
  const store = getStore();

  if (input.bytes.byteLength > limits.maxAttachmentBytes) {
    return err(
      'too_large',
      `That file is ${(input.bytes.byteLength / 1_048_576).toFixed(1)} MB, over the ${(limits.maxAttachmentBytes / 1_048_576).toFixed(0)} MB limit.`,
    );
  }

  const sniffed = sniffMimeType(input.bytes, input.mimeType);
  if (!isSupportedMimeType(sniffed)) {
    return err(
      'unsupported_media_type',
      `${input.filename} is a ${sniffed} file, which cannot be read. Supported: PDF, DOCX, PPTX, text, Markdown, CSV, HTML and images.`,
    );
  }

  const contentHash = sha256(input.bytes);
  const existing = (await store.findOne('knowledge_documents', auth.organizationId, {
    eq: { content_hash: contentHash },
  })) as KnowledgeDocument | null;
  if (existing) {
    return err('conflict', `That exact file is already uploaded as "${existing.title}".`);
  }

  const extracted = await extractDocument({
    bytes: input.bytes,
    filename: input.filename,
    mimeType: sniffed,
  });
  if (!extracted.ok) return extracted;

  const safeFilename = sanitizeFilename(input.filename);
  const documentId = newId();
  const objectPath = `${auth.organizationId}/knowledge/${documentId}/${safeFilename}`;
  const put = await getStorage().put(objectPath, input.bytes, sniffed);

  const now = new Date().toISOString();
  const document: KnowledgeDocument = {
    id: documentId,
    organization_id: auth.organizationId,
    title: input.title?.trim() || input.filename,
    doc_type: input.docType,
    filename: input.filename,
    safe_filename: safeFilename,
    mime_type: sniffed,
    size_bytes: input.bytes.byteLength,
    storage_path: put.ok ? objectPath : null,
    page_count: extracted.value.pageCount,
    extraction_confidence: extracted.value.confidence,
    extraction_error: extracted.value.note,
    needs_review: extracted.value.needsReview,
    content_hash: contentHash,
    chunk_count: 0,
    uploaded_by: auth.userId,
    created_at: now,
    updated_at: now,
  };
  await store.insert('knowledge_documents', document);

  const chunks = chunkDocument(auth.organizationId, document, extracted.value.text);
  if (chunks.length > 0) {
    await store.insertMany('knowledge_chunks', chunks);
    await store.update('knowledge_documents', auth.organizationId, documentId, {
      chunk_count: chunks.length,
    });
  }

  let contactsImported = 0;
  if (input.docType === 'network_csv') {
    const imported = await importNetworkCsv(
      auth,
      new TextDecoder().decode(input.bytes),
      documentId,
    );
    if (imported.ok) contactsImported = imported.value.imported;
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'knowledge.uploaded',
    entityType: 'knowledge_document',
    entityId: documentId,
    metadata: {
      doc_type: input.docType,
      mime_type: sniffed,
      pages: extracted.value.pageCount,
      chunks: chunks.length,
      confidence: extracted.value.confidence,
      contacts_imported: contactsImported,
    },
  });

  return ok({
    document: { ...document, chunk_count: chunks.length },
    chunks: chunks.length,
    contactsImported,
  });
}

const TARGET_CHUNK_CHARS = 1_400;
const CHUNK_OVERLAP_CHARS = 160;

/**
 * Page-aware chunking. Chunks never span a page boundary, so every chunk can
 * carry the exact page it came from — which is what makes "deck, page 4" a real
 * citation rather than a guess.
 */
export function chunkDocument(
  organizationId: string,
  document: KnowledgeDocument,
  pageMarkedText: string,
): KnowledgeChunk[] {
  const pages = splitPages(pageMarkedText);
  const chunks: KnowledgeChunk[] = [];
  let index = 0;

  for (const page of pages) {
    const paragraphs = page.text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
    let buffer = '';

    const flush = () => {
      const text = buffer.trim();
      if (text.length === 0) return;
      chunks.push({
        id: sha256(`${document.id}:${index}`).slice(0, 32),
        organization_id: organizationId,
        document_id: document.id,
        chunk_index: index,
        page: page.page,
        section: firstHeading(text),
        text,
        created_at: document.created_at,
      });
      index++;
      buffer = text.length > CHUNK_OVERLAP_CHARS ? text.slice(-CHUNK_OVERLAP_CHARS) : '';
    };

    for (const paragraph of paragraphs) {
      if (buffer.length + paragraph.length > TARGET_CHUNK_CHARS && buffer.length > 0) flush();
      buffer += (buffer ? '\n\n' : '') + paragraph;
      // A single oversized paragraph still has to be split somewhere.
      while (buffer.length > TARGET_CHUNK_CHARS * 1.6) {
        const cut = buffer.lastIndexOf(' ', TARGET_CHUNK_CHARS);
        const head = buffer.slice(0, cut > 0 ? cut : TARGET_CHUNK_CHARS);
        const tail = buffer.slice(head.length);
        buffer = head;
        flush();
        buffer = tail;
      }
    }
    if (buffer.trim().length > 0) {
      const text = buffer.trim();
      chunks.push({
        id: sha256(`${document.id}:${index}`).slice(0, 32),
        organization_id: organizationId,
        document_id: document.id,
        chunk_index: index,
        page: page.page,
        section: firstHeading(text),
        text,
        created_at: document.created_at,
      });
      index++;
    }
  }

  return chunks;
}

function firstHeading(text: string): string | null {
  const line = text.split('\n')[0]?.trim() ?? '';
  if (!line) return null;
  const looksLikeHeading = line.length < 80 && !line.endsWith('.') && /^[A-Z#]/.test(line);
  return looksLikeHeading ? line.replace(/^#+\s*/, '') : null;
}

/* --------------------------------------------------------------- network */

export async function importNetworkCsv(
  auth: AuthContext,
  csvText: string,
  sourceDocumentId: string | null = null,
): Promise<Result<{ imported: number; skipped: number; errors: string[] }>> {
  const Papa = (await import('papaparse')).default;
  const parsed = Papa.parse<Record<string, string>>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  });

  if (parsed.data.length === 0) {
    return err('invalid_input', 'No rows were found in that CSV.');
  }

  const store = getStore();
  const existing = (await store.list(
    'network_contacts',
    auth.organizationId,
    {},
  )) as NetworkContact[];
  const seen = new Set(existing.map((c) => (c.email ?? c.full_name).toLowerCase()));

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  for (const [index, row] of parsed.data.entries()) {
    const fullName = (row.full_name ?? row.name ?? '').trim();
    if (!fullName) {
      errors.push(`Row ${index + 2}: no name column found.`);
      continue;
    }
    const email = (row.email ?? '').trim().toLowerCase() || null;
    const key = (email ?? fullName).toLowerCase();
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    const contact: NetworkContact = {
      id: newId(),
      organization_id: auth.organizationId,
      full_name: fullName,
      email,
      company: (row.company ?? '').trim() || null,
      title: (row.title ?? row.role ?? '').trim() || null,
      relationship: (row.relationship ?? '').trim() || null,
      expertise: (row.expertise ?? row.tags ?? '')
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      geography: (row.geography ?? row.location ?? '').trim() || null,
      notes: (row.notes ?? '').trim() || null,
      source_document_id: sourceDocumentId,
      created_at: now,
      updated_at: now,
    };
    await store.insert('network_contacts', contact);
    imported++;
  }

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'network.imported',
    entityType: 'network_contact',
    entityId: sourceDocumentId,
    metadata: { imported, skipped, errors: errors.length },
  });

  return ok({ imported, skipped, errors });
}

export async function listNetworkContacts(
  organizationId: string,
  search?: string,
): Promise<NetworkContact[]> {
  const store = getStore();
  const filter = search
    ? {
        textSearch: {
          columns: ['full_name', 'company', 'title', 'relationship', 'notes'],
          query: search,
        },
      }
    : {};
  return (await store.list('network_contacts', organizationId, filter, {
    orderBy: [{ field: 'full_name', direction: 'asc' }],
  })) as NetworkContact[];
}

/* ----------------------------------------------------------------- views */

export async function listDocuments(
  organizationId: string,
  docType?: KnowledgeDocType,
): Promise<KnowledgeDocument[]> {
  const store = getStore();
  return (await store.list(
    'knowledge_documents',
    organizationId,
    docType ? { eq: { doc_type: docType } } : {},
    { orderBy: [{ field: 'created_at', direction: 'desc' }] },
  )) as KnowledgeDocument[];
}

export async function getDocument(
  organizationId: string,
  documentId: string,
): Promise<{ document: KnowledgeDocument; chunks: KnowledgeChunk[] } | null> {
  const store = getStore();
  const document = (await store.get(
    'knowledge_documents',
    organizationId,
    documentId,
  )) as KnowledgeDocument | null;
  if (!document) return null;
  const chunks = (await store.list(
    'knowledge_chunks',
    organizationId,
    { eq: { document_id: documentId } },
    { orderBy: [{ field: 'chunk_index', direction: 'asc' }] },
  )) as KnowledgeChunk[];
  return { document, chunks };
}

export async function deleteDocument(auth: AuthContext, documentId: string): Promise<Result<true>> {
  const store = getStore();
  const document = (await store.get(
    'knowledge_documents',
    auth.organizationId,
    documentId,
  )) as KnowledgeDocument | null;
  if (!document) return err('not_found', 'That document does not exist.');

  await store.removeWhere('knowledge_chunks', auth.organizationId, {
    eq: { document_id: documentId },
  });
  if (document.storage_path) {
    await getStorage().remove(document.storage_path);
  }
  await store.remove('knowledge_documents', auth.organizationId, documentId);

  await recordAudit(store, {
    organizationId: auth.organizationId,
    userId: auth.userId,
    action: 'knowledge.deleted',
    entityType: 'knowledge_document',
    entityId: documentId,
    metadata: { title: document.title, doc_type: document.doc_type },
  });
  return ok(true);
}

/** Search across knowledge chunks, returning citation-ready hits. */
export async function searchKnowledge(
  organizationId: string,
  query: string,
  limit = 8,
): Promise<RetrievalHit[]> {
  if (!query.trim()) return [];
  return getRetrievalProvider().search(organizationId, query, limit);
}

export function hitExcerpt(hit: RetrievalHit): string {
  return truncate(hit.text.replace(/\s+/g, ' '), 300);
}
