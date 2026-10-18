import { describe, expect, it } from 'vitest';
import { opensInline } from '@/lib/email/attachment-types';

/**
 * Which inbox attachments open in a new tab. Everything else is a plain
 * download, which never leaves the page (and leaves no blank window in the
 * desktop app).
 */
describe('opensInline', () => {
  it('opens PDFs and common images in a tab', () => {
    for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(opensInline(type)).toBe(true);
    }
    expect(opensInline('Application/PDF')).toBe(true);
  });

  it('downloads everything else, including anything that could run script', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/octet-stream',
      '',
    ]) {
      expect(opensInline(type)).toBe(false);
    }
    expect(opensInline(null)).toBe(false);
    expect(opensInline(undefined)).toBe(false);
  });
});
