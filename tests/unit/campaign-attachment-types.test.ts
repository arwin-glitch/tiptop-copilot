import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_ATTACHMENT_TYPES,
  campaignAttachmentType,
  unsupportedAttachmentMessage,
} from '@/lib/campaigns/attachment-types';
import { BUCKET_BASE_MIME_TYPES, bucketAccepts } from '@/lib/storage/allowed-types';

/**
 * Which files a campaign can carry as a shared attachment, and the type each
 * is stored and sent with. A type the storage bucket refuses must be refused
 * here first, with a sentence a person can act on, never stored as
 * application/octet-stream (which the bucket refuses with a 500).
 */

describe('campaignAttachmentType', () => {
  it('keeps every supported declared type exactly as it was', () => {
    for (const type of BUCKET_BASE_MIME_TYPES) {
      expect(campaignAttachmentType('file.bin', type)).toBe(type);
    }
    expect(campaignAttachmentType('Q3 letter.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('reads a type the browser did not know from the file name', () => {
    expect(campaignAttachmentType('Letter.pdf', '')).toBe('application/pdf');
    expect(campaignAttachmentType('notes.md', '')).toBe('text/markdown');
    expect(campaignAttachmentType('notes.MD', 'application/octet-stream')).toBe('text/markdown');
    expect(campaignAttachmentType('memo.docx', 'application/octet-stream')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(campaignAttachmentType('photo.JPG', '')).toBe('image/jpeg');
  });

  it('refuses what storage would refuse: spreadsheets, zips, unknown types', () => {
    for (const [name, type] of [
      ['model.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['model.xlsx', ''],
      ['legacy.xls', 'application/vnd.ms-excel'],
      ['bundle.zip', 'application/zip'],
      ['bundle.zip', 'application/octet-stream'],
      ['mystery', ''],
      ['mystery.bin', 'application/octet-stream'],
      ['picture.heic', 'image/heic'],
      ['vector.svg', 'image/svg+xml'],
    ] as const) {
      expect(campaignAttachmentType(name, type)).toBeNull();
    }
  });

  it('only ever answers a type the bucket stores', () => {
    for (const type of CAMPAIGN_ATTACHMENT_TYPES) expect(bucketAccepts(type)).toBe(true);
    for (const name of ['a.pdf', 'a.txt', 'a.md', 'a.csv', 'a.htm', 'a.json', 'a.webp']) {
      const type = campaignAttachmentType(name, '');
      expect(type && bucketAccepts(type)).toBe(true);
    }
  });

  it('says what cannot go and what can', () => {
    expect(unsupportedAttachmentMessage('model.xlsx')).toBe(
      'model.xlsx cannot be attached: campaigns carry PDF, Word (.docx), PowerPoint (.pptx), plain text, Markdown, CSV, HTML, JSON, PNG, JPG, GIF or WebP files. Save it as one of those (a PDF works for most things) and attach it again.',
    );
  });
});
