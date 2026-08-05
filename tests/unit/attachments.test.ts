import { afterEach, describe, expect, it } from 'vitest';
import { extractDocument, isSupportedMimeType, sniffMimeType } from '@/lib/documents/extract';
import {
  PAGE_MARKER_PREFIX,
  joinPages,
  pageForQuote,
  plainDocumentText,
  splitPages,
} from '@/lib/documents/pages';
import { resetEnvCache } from '@/lib/config/env';
import { sanitizeFilename } from '@/lib/util/text';

/**
 * Page-aware extraction is what lets a claim cite "deck, page 4". These tests
 * cover the round trip (pages → single column → pages) and the failure
 * behaviour: a document that cannot be parsed is recorded with low confidence
 * and `needsReview`, never discarded and never silently empty.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

afterEach(() => {
  delete process.env.MAX_ATTACHMENT_PAGES;
  delete process.env.MAX_DOCUMENT_CHARS;
  delete process.env.MAX_ATTACHMENT_BYTES;
  resetEnvCache();
});

describe('page round trip', () => {
  it('joins and splits back to the same pages', () => {
    const pages = [
      { page: 1, text: 'Vetrix — vertical AI for veterinary practices' },
      { page: 2, text: 'The problem: clinics lose 90 minutes a day to charting' },
      { page: 3, text: '$340K ARR across 22 clinics' },
    ];
    expect(splitPages(joinPages(pages))).toEqual(pages);
  });

  it('treats unmarked text as a single page rather than losing it', () => {
    expect(splitPages('just some text')).toEqual([{ page: 1, text: 'just some text' }]);
  });

  it('preserves non-contiguous page numbers', () => {
    const pages = [
      { page: 2, text: 'second' },
      { page: 7, text: 'seventh' },
    ];
    expect(splitPages(joinPages(pages))).toEqual(pages);
  });

  it('keeps text that appears before the first marker', () => {
    const text = `preamble\n${PAGE_MARKER_PREFIX}1]\nbody`;
    const pages = splitPages(text);
    expect(pages[0]).toEqual({ page: 1, text: 'preamble' });
    expect(pages[1]).toEqual({ page: 1, text: 'body' });
  });

  it('is empty-safe', () => {
    expect(splitPages(null)).toEqual([]);
    expect(splitPages(undefined)).toEqual([]);
    expect(splitPages('')).toEqual([]);
  });
});

describe('plainDocumentText', () => {
  it('strips markers for display without merging words together', () => {
    const text = joinPages([
      { page: 1, text: 'first page' },
      { page: 2, text: 'second page' },
    ]);
    const plain = plainDocumentText(text);
    expect(plain).not.toContain('[page');
    expect(plain).toContain('first page');
    expect(plain).toContain('second page');
    expect(plain).not.toMatch(/first pagesecond/);
  });
});

describe('pageForQuote', () => {
  const deck = joinPages([
    { page: 1, text: 'Vetrix: vertical AI for veterinary practices' },
    { page: 4, text: '$340K ARR across 22 clinics, growing 18% month over month' },
    { page: 8, text: 'Raising $3M seed at a $15M cap' },
  ]);

  it('finds the page a quote came from', () => {
    expect(pageForQuote(deck, '$340K ARR across 22 clinics')).toBe(4);
    expect(pageForQuote(deck, 'Raising $3M seed')).toBe(8);
  });

  it('is case-insensitive', () => {
    expect(pageForQuote(deck, 'raising $3m seed')).toBe(8);
  });

  it('returns null rather than guessing a page for a quote that is not there', () => {
    expect(pageForQuote(deck, 'we have 400 enterprise logos')).toBeNull();
    expect(pageForQuote(deck, '   ')).toBeNull();
    expect(pageForQuote(null, 'anything')).toBeNull();
  });
});

describe('sniffMimeType', () => {
  it('trusts magic bytes over the declared type', () => {
    // A "PDF" that is really a PNG must not reach the PDF parser.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMimeType(png, 'application/pdf')).toBe('image/png');

    const pdf = bytes('%PDF-1.7\n...');
    expect(sniffMimeType(pdf, 'text/plain')).toBe('application/pdf');
  });

  it('keeps the declared Office type for a zip container', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(sniffMimeType(zip, docx)).toBe(docx);
    expect(sniffMimeType(zip, 'application/pdf')).toBe('application/zip');
  });

  it('falls back to the declared type when nothing matches', () => {
    expect(sniffMimeType(bytes('hello'), 'text/plain')).toBe('text/plain');
  });
});

describe('isSupportedMimeType', () => {
  it('ignores charset parameters and case', () => {
    expect(isSupportedMimeType('TEXT/PLAIN; charset=utf-8')).toBe(true);
    expect(isSupportedMimeType('application/x-msdownload')).toBe(false);
  });
});

describe('extractDocument', () => {
  it('extracts plain text as one page', async () => {
    const result = await extractDocument({
      bytes: bytes(
        'Vetrix does vertical AI for veterinary practices. $340K ARR across 22 clinics.',
      ),
      filename: 'notes.txt',
      mimeType: 'text/plain',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pageCount).toBe(1);
    expect(result.value.confidence).toBe('high');
    expect(result.value.needsReview).toBe(false);
    expect(result.value.text).toContain('$340K ARR');
  });

  it('splits plain text on form feeds into real pages', async () => {
    const result = await extractDocument({
      bytes: bytes(`page one content here\fpage two content here\fpage three content here`),
      filename: 'deck.txt',
      mimeType: 'text/plain',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.pageCount).toBe(3);
    expect(result.value.pages[2]).toEqual({ page: 3, text: 'page three content here' });
  });

  it('converts HTML to text and never keeps markup', async () => {
    const result = await extractDocument({
      bytes: bytes('<html><body><p>Hello</p><script>alert(1)</script><p>World</p></body></html>'),
      filename: 'email.html',
      mimeType: 'text/html',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.text).not.toContain('<');
    expect(result.value.text).not.toContain('alert(1)');
    expect(result.value.text).toContain('Hello');
    expect(result.value.text).toContain('World');
  });

  it('pages a CSV so a citation can point at a row range', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => `contact-${i},x@y.demo`).join('\n');
    const result = await extractDocument({
      bytes: bytes(`name,email\n${rows}`),
      filename: 'network.csv',
      mimeType: 'text/csv',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.pageCount).toBeGreaterThan(1);
    expect(result.value.note).toContain('200 rows');
  });

  it('flags an image for review instead of pretending to have read it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await extractDocument({
      bytes: png,
      filename: 'screenshot.png',
      mimeType: 'image/png',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.text).toBe('');
    expect(result.value.confidence).toBe('low');
    expect(result.value.needsReview).toBe(true);
    expect(result.value.note).toContain('No text was extracted locally');
  });

  it('records a near-empty document as low confidence needing review', async () => {
    const result = await extractDocument({
      bytes: bytes('hi'),
      filename: 'tiny.txt',
      mimeType: 'text/plain',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.confidence).toBe('low');
    expect(result.value.needsReview).toBe(true);
    expect(result.value.note).toContain('scanned or image-only');
  });

  it('refuses an unsupported type with a message naming what is supported', async () => {
    const result = await extractDocument({
      bytes: bytes('MZ\u0090'),
      filename: 'thing.exe',
      mimeType: 'application/x-msdownload',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_media_type');
      expect(result.error.message).toContain('PDF, DOCX, PPTX');
    }
  });

  it('refuses a file over the configured byte ceiling', async () => {
    process.env.MAX_ATTACHMENT_BYTES = '64';
    resetEnvCache();

    const result = await extractDocument({
      bytes: bytes('x'.repeat(200)),
      filename: 'big.txt',
      mimeType: 'text/plain',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('too_large');
  });

  it('truncates at the page ceiling and says that it did', async () => {
    process.env.MAX_ATTACHMENT_PAGES = '2';
    resetEnvCache();

    const page = (n: number) =>
      `Slide ${n}: this page carries enough text to count as real content.`;
    const result = await extractDocument({
      bytes: bytes([page(1), page(2), page(3)].join('\f')),
      filename: 'deck.txt',
      mimeType: 'text/plain',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.pageCount).toBe(2);
    expect(result.value.truncated).toBe(true);
    expect(result.value.note).toContain('truncated');
  });

  it('truncates at the character ceiling', async () => {
    process.env.MAX_DOCUMENT_CHARS = '50';
    resetEnvCache();

    const result = await extractDocument({
      bytes: bytes('a'.repeat(500)),
      filename: 'long.txt',
      mimeType: 'text/plain',
    });
    if (!result.ok) throw new Error('extraction failed');
    expect(result.value.truncated).toBe(true);
    expect(result.value.pages[0]!.text.length).toBeLessThanOrEqual(50);
  });
});

describe('sanitizeFilename', () => {
  it('neutralises path traversal and separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitizeFilename('C:\\temp\\deck.pdf')).not.toContain('\\');
  });

  it('keeps a readable name and a lowercased extension', () => {
    expect(sanitizeFilename('Vetrix Seed Deck.PDF')).toBe('Vetrix-Seed-Deck.pdf');
  });

  it('strips newlines used for header injection', () => {
    expect(sanitizeFilename('deck.pdf\r\nContent-Type: text/html')).not.toContain('\n');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('...')).toBeTruthy();
    expect(sanitizeFilename('   ')).toBe('file');
  });
});
