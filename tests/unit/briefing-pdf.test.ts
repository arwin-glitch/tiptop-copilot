import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parseBriefingText, renderBriefingPdf } from '@/lib/briefing/pdf';

const base = {
  kind: 'morning' as const,
  title: 'Morning Brief — Wednesday, Sep 30, 2026',
  date_key: '2026-09-30',
  posted_at: '2026-09-30T11:31:00Z',
};

describe('parseBriefingText', () => {
  it('finds headings, bullets and paragraph gaps', () => {
    const blocks = parseBriefingText(
      'GOING STALE — COULD COST MONEY\n- Vendor invoice, 4th notice\n\nAct today:\nReply to Maya.\n\n\n1. First\n2) Second',
    );
    expect(blocks).toEqual([
      { type: 'heading', text: 'GOING STALE — COULD COST MONEY', danger: true },
      { type: 'bullet', text: 'Vendor invoice, 4th notice', marker: '•' },
      { type: 'gap' },
      { type: 'heading', text: 'Act today', danger: false },
      { type: 'para', text: 'Reply to Maya.' },
      { type: 'gap' },
      { type: 'bullet', text: 'First', marker: '1.' },
      { type: 'bullet', text: 'Second', marker: '2)' },
    ]);
  });

  it('does not treat a long sentence ending in a colon as a heading', () => {
    const line = `${'Nick said the following about the round and the terms '.repeat(2)}:`;
    expect(parseBriefingText(line)).toEqual([{ type: 'para', text: line }]);
  });
});

describe('renderBriefingPdf', () => {
  it('builds a readable PDF even with arrows, emoji and very long text', async () => {
    const summary = [
      'GOING STALE — COULD COST MONEY',
      '🔴 Harborline Fund Admin → wire instructions, 6th ask since Sep 1 ✓',
      ...Array.from({ length: 120 }, (_, i) => `- Item ${i}: ${'word '.repeat(30)}`),
      `A${'x'.repeat(400)}`,
    ].join('\n');
    const bytes = await renderBriefingPdf({ ...base, summary }, { timeZone: 'America/Chicago' });

    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe(base.title);
  });

  it('renders a one-line dossier', async () => {
    const bytes = await renderBriefingPdf(
      {
        ...base,
        kind: 'dossier',
        title: "Nick's Wednesday Dossier",
        summary: 'No meetings today.',
      },
      { timeZone: 'America/Chicago' },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
