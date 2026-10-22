import { describe, expect, it } from 'vitest';
import { ogElement, renderOgImage } from '@/lib/events/og';
import { previewPage } from '@/lib/events/preview';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('share card', () => {
  it.each(['cover', 'type', 'ticket'] as const)(
    'renders the %s layout as a 1200×630 PNG',
    async (layout) => {
      const page = previewPage('tiptop-signature');
      const png = await renderOgImage({ doc: page.doc, facts: page.facts, media: {}, layout });
      expect(png).not.toBeNull();
      expect(Array.from(png!.slice(0, 8))).toEqual(PNG_MAGIC);
      const view = new DataView(png!.buffer, png!.byteOffset, png!.byteLength);
      expect(view.getUint32(16)).toBe(1200);
      expect(view.getUint32(20)).toBe(630);
    },
    60_000,
  );

  it('uses the SEO title, else the event title, never a raw merge field', () => {
    const page = previewPage('annual-letter');
    page.doc.sections.find((s) => s.type === 'hero')!.props.headline =
      '{{first_name|Friend}}, join us';
    const el = ogElement({ doc: page.doc, facts: page.facts, media: {}, layout: 'type' }, null);
    const text = JSON.stringify(el);
    expect(text).toContain(page.facts.title);
    expect(text).not.toContain('{{');
    page.doc.meta.seoTitle = 'A custom card title';
    expect(
      JSON.stringify(
        ogElement({ doc: page.doc, facts: page.facts, media: {}, layout: 'cover' }, null),
      ),
    ).toContain('A custom card title');
  });

  it('renders a dark preset in its dark palette', () => {
    const page = previewPage('boardroom-noir');
    const text = JSON.stringify(
      ogElement({ doc: page.doc, facts: page.facts, media: {}, layout: 'type' }, null),
    );
    expect(text).toContain(page.doc.theme.paletteDark.bg);
  });
});
