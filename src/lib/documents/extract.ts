import 'server-only';
import { envLimits } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import type { ExtractedPage, ExtractionConfidence } from '@/lib/types/domain';
import { htmlToPlainText, truncate } from '@/lib/util/text';
import { err, ok, type Result } from '@/lib/util/result';
import { joinPages } from './pages';

/**
 * Local, page-aware text extraction.
 *
 * Page boundaries are preserved so a claim can cite "deck, page 4". When a
 * document cannot be parsed cleanly — an image-only PDF, an exotic PPTX — the
 * result is recorded with low confidence and `needsReview: true` rather than
 * thrown away. A partially-read deck that says so is far more useful than a
 * deal that will not open.
 */

export interface ExtractInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ExtractOutput {
  /** Page-marked text, ready to store in a single column. */
  text: string;
  pages: ExtractedPage[];
  pageCount: number;
  confidence: ExtractionConfidence;
  needsReview: boolean;
  truncated: boolean;
  note: string | null;
}

const SUPPORTED = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'text/html',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function isSupportedMimeType(mimeType: string): boolean {
  return SUPPORTED.has(mimeType.toLowerCase().split(';')[0]?.trim() ?? '');
}

/**
 * Magic-byte sniffing. The client-declared Content-Type is a hint, not a fact:
 * a `.pdf` that is actually a zip must not be handed to the PDF parser.
 */
export function sniffMimeType(bytes: Uint8Array, declared: string): string {
  const head = Array.from(bytes.slice(0, 8));
  const startsWith = (sig: number[]) => sig.every((b, i) => head[i] === b);

  if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
    // A zip container: DOCX, PPTX and XLSX all look like this. Trust the
    // declared Office type, otherwise treat it as an unknown archive.
    if (declared.includes('wordprocessingml') || declared.includes('presentationml')) {
      return declared;
    }
    return 'application/zip';
  }
  return declared;
}

export async function extractDocument(input: ExtractInput): Promise<Result<ExtractOutput>> {
  const limits = envLimits();
  if (input.bytes.byteLength > limits.maxAttachmentBytes) {
    return err(
      'too_large',
      `This file is ${(input.bytes.byteLength / 1_048_576).toFixed(1)} MB, over the configured ${(limits.maxAttachmentBytes / 1_048_576).toFixed(0)} MB limit.`,
    );
  }

  const actual = sniffMimeType(input.bytes, input.mimeType);
  const base = actual.toLowerCase().split(';')[0]?.trim() ?? '';

  try {
    switch (base) {
      case 'application/pdf':
        return finish(
          await extractPdf(input.bytes),
          limits.maxDocumentChars,
          limits.maxAttachmentPages,
        );
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return finish(
          await extractDocx(input.bytes),
          limits.maxDocumentChars,
          limits.maxAttachmentPages,
        );
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return finish(
          await extractPptx(input.bytes),
          limits.maxDocumentChars,
          limits.maxAttachmentPages,
        );
      case 'text/plain':
      case 'text/markdown':
      case 'application/json':
        return finish(
          extractPlain(input.bytes),
          limits.maxDocumentChars,
          limits.maxAttachmentPages,
        );
      case 'text/csv':
      case 'application/csv':
        return finish(extractCsv(input.bytes), limits.maxDocumentChars, limits.maxAttachmentPages);
      case 'text/html':
        return finish(extractHtml(input.bytes), limits.maxDocumentChars, limits.maxAttachmentPages);
      case 'image/png':
      case 'image/jpeg':
      case 'image/gif':
      case 'image/webp':
        // No local OCR. The file is stored and flagged so it can be reviewed by
        // hand or sent to the vision model on explicit request.
        return ok({
          text: '',
          pages: [],
          pageCount: 0,
          confidence: 'low',
          needsReview: true,
          truncated: false,
          note: 'Image file. No text was extracted locally — open it to read the contents, or run an analysis to have the model read it.',
        });
      default:
        return err(
          'unsupported_media_type',
          `${input.filename} is a ${base || 'unrecognised'} file. Supported types are PDF, DOCX, PPTX, text, Markdown, CSV, HTML and images.`,
        );
    }
  } catch (error) {
    log.warn('Document extraction failed', {
      filename: input.filename,
      mimeType: base,
      reason: (error as Error)?.message,
    });
    return ok({
      text: '',
      pages: [],
      pageCount: 0,
      confidence: 'low',
      needsReview: true,
      truncated: false,
      note: `Could not parse this file. It is stored and can be opened directly. (${truncate((error as Error)?.message ?? 'unknown error', 120)})`,
    });
  }
}

interface RawExtraction {
  pages: ExtractedPage[];
  confidence: ExtractionConfidence;
  note: string | null;
}

function finish(raw: RawExtraction, maxChars: number, maxPages: number): Result<ExtractOutput> {
  let pages = raw.pages.filter((p) => p.text.trim().length > 0);
  let truncated = false;

  if (pages.length > maxPages) {
    pages = pages.slice(0, maxPages);
    truncated = true;
  }

  let total = 0;
  const capped: ExtractedPage[] = [];
  for (const page of pages) {
    if (total >= maxChars) {
      truncated = true;
      break;
    }
    const remaining = maxChars - total;
    const text = page.text.length > remaining ? page.text.slice(0, remaining) : page.text;
    if (text.length < page.text.length) truncated = true;
    capped.push({ page: page.page, text });
    total += text.length;
  }

  // A document that produced almost nothing is a parse failure in disguise.
  const looksEmpty = total < 40;
  const confidence: ExtractionConfidence = looksEmpty ? 'low' : raw.confidence;

  return ok({
    text: joinPages(capped),
    pages: capped,
    pageCount: capped.length,
    confidence,
    needsReview: confidence === 'low',
    truncated,
    note: looksEmpty
      ? 'Very little text was recovered. This is often a scanned or image-only document; review it manually.'
      : truncated
        ? `Extraction was truncated at the configured limits (${maxPages} pages / ${maxChars.toLocaleString()} characters).`
        : raw.note,
  });
}

/* ------------------------------------------------------------------- pdf */

async function extractPdf(bytes: Uint8Array): Promise<RawExtraction> {
  try {
    // Dynamic import: pdfjs is Node-only and must not enter the client bundle.
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> };
      GlobalWorkerOptions: { workerSrc: string };
    };
    pdfjs.GlobalWorkerOptions.workerSrc = '';

    const doc = await pdfjs.getDocument({
      data: bytes,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;

    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ page: i, text });
    }

    const withText = pages.filter((p) => p.text.length > 20).length;
    const confidence: ExtractionConfidence =
      withText === 0 ? 'low' : withText / Math.max(1, pages.length) > 0.7 ? 'high' : 'medium';

    return {
      pages,
      confidence,
      note:
        confidence === 'low'
          ? 'No selectable text found. This is likely a scanned or image-only PDF.'
          : confidence === 'medium'
            ? 'Some pages produced little or no text; those pages may be images.'
            : null,
    };
  } catch (error) {
    log.warn('pdfjs extraction failed', { reason: (error as Error)?.message });
    return {
      pages: [],
      confidence: 'low',
      note: 'The PDF could not be parsed. It is stored and can be opened directly.',
    };
  }
}

interface PdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<{
    getTextContent: () => Promise<{ items: ({ str?: string } | Record<string, unknown>)[] }>;
  }>;
}

/* ------------------------------------------------------------------ docx */

async function extractDocx(bytes: Uint8Array): Promise<RawExtraction> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
  };
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  // Word has no page concept in the XML; split on explicit page breaks where
  // present, otherwise treat the document as one logical page.
  const chunks = result.value.split(/\f|\n{4,}/).filter((c) => c.trim().length > 0);
  const pages: ExtractedPage[] =
    chunks.length > 1
      ? chunks.map((text, i) => ({ page: i + 1, text: text.trim() }))
      : [{ page: 1, text: result.value.trim() }];
  return {
    pages,
    confidence: result.value.trim().length > 40 ? 'high' : 'low',
    note:
      chunks.length > 1
        ? null
        : 'Word documents have no fixed pagination; the whole document is treated as one page for citation purposes.',
  };
}

/* ------------------------------------------------------------------ pptx */

async function extractPptx(bytes: Uint8Array): Promise<RawExtraction> {
  const JSZip = (await import('jszip')).default;
  const { XMLParser } = await import('fast-xml-parser');

  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parser = new XMLParser({ ignoreAttributes: true, textNodeName: '#text' });
  const pages: ExtractedPage[] = [];

  for (const name of slideFiles) {
    const xml = await zip.files[name]?.async('string');
    if (!xml) continue;
    const parsed = parser.parse(xml) as unknown;
    const text = collectText(parsed).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ page: slideNumber(name), text });
  }

  const withText = pages.filter((p) => p.text.length > 10).length;
  return {
    pages,
    confidence:
      withText === 0 ? 'low' : withText / Math.max(1, pages.length) > 0.6 ? 'high' : 'medium',
    note:
      withText < pages.length
        ? 'Some slides contained only images or diagrams and produced no text.'
        : null,
  };
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/** Depth-limited walk collecting every `a:t` text run in a PPTX slide. */
function collectText(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 40 || node === null || node === undefined) return out;
  if (typeof node === 'string') {
    if (node.trim()) out.push(node.trim());
    return out;
  }
  if (typeof node === 'number' || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, depth + 1, out);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'a:t' || key === '#text') {
      collectText(value, depth + 1, out);
    } else {
      collectText(value, depth + 1, out);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ text */

function extractPlain(bytes: Uint8Array): RawExtraction {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const chunks = text.split(/\f/).filter((c) => c.trim().length > 0);
  return {
    pages:
      chunks.length > 1
        ? chunks.map((t, i) => ({ page: i + 1, text: t.trim() }))
        : [{ page: 1, text: text.trim() }],
    confidence: 'high',
    note: null,
  };
}

function extractHtml(bytes: Uint8Array): RawExtraction {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return {
    pages: [{ page: 1, text: htmlToPlainText(html) }],
    confidence: 'high',
    note: 'HTML was converted to plain text. Markup is never rendered.',
  };
}

function extractCsv(bytes: Uint8Array): RawExtraction {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Chunk into readable pages so a citation can point at a row range.
  const perPage = 200;
  const pages: ExtractedPage[] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push({ page: pages.length + 1, text: lines.slice(i, i + perPage).join('\n') });
  }
  return {
    pages: pages.length > 0 ? pages : [{ page: 1, text: '' }],
    confidence: 'high',
    note: lines.length > perPage ? `CSV split into pages of ${perPage} rows for citation.` : null,
  };
}
