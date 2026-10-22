import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventPage } from '@/components/events/render/event-page';
import { blockRegistry, BLOCK_PROPS, CORE_BLOCKS, EXTRA_BLOCKS } from '@/lib/events/blocks';
import {
  PUBLIC_VIEWER,
  SAMPLE_GUEST_VIEWER,
  type EventPageProps,
  type EventRenderMode,
} from '@/lib/events/contracts';
import { placeSection, sectionTemplate } from '@/lib/events/doc';
import { previewPage } from '@/lib/events/preview';
import {
  BLOCK_TYPES,
  BLOCK_VARIANTS,
  parseEventDoc,
  type BlockType,
  type EventDoc,
} from '@/lib/events/schema';
import { STARTERS, getStarter } from '@/lib/events/starters';
import { THEME_PRESETS, getThemePreset } from '@/lib/events/themes';
import { demoEvents } from '@/lib/demo/events-fixtures';

const validators = {
  validateProps: blockRegistry.validateProps,
  validateTheme: blockRegistry.validateTheme,
};

function render(props: Partial<EventPageProps> & { doc: EventDoc }): string {
  const page = previewPage('tiptop-signature');
  return renderToStaticMarkup(
    createElement(EventPage, {
      facts: page.facts,
      media: page.media,
      viewer: PUBLIC_VIEWER,
      mode: 'live',
      rsvp: page.rsvp,
      ...props,
    }),
  );
}

describe('block registry', () => {
  it('defines every block type with its schema variants', () => {
    expect(blockRegistry.list().map((d) => d.type)).toEqual(BLOCK_TYPES);
    expect([...CORE_BLOCKS, ...EXTRA_BLOCKS].sort()).toEqual([...BLOCK_TYPES].sort());
    for (const type of BLOCK_TYPES) {
      const def = blockRegistry.get(type);
      expect(def?.variants).toEqual(BLOCK_VARIANTS[type]);
      expect(def?.label.length).toBeGreaterThan(0);
      expect(def?.description.length).toBeGreaterThan(10);
    }
  });

  it.each(BLOCK_TYPES)('%s: defaults validate and every field is a real prop', (type) => {
    const def = blockRegistry.get(type)!;
    const { variant, props } = def.defaults();
    expect(blockRegistry.validateProps(type, variant, props)).toEqual([]);
    const shape = (BLOCK_PROPS[type] as unknown as { shape?: Record<string, unknown> }).shape;
    if (shape) for (const field of def.fields) expect(Object.keys(shape)).toContain(field.key);
    expect(typeof def.summary(props)).toBe('string');
  });

  it('accepts empty props for every type and variant (a new section starts empty)', () => {
    for (const type of BLOCK_TYPES) {
      for (const variant of BLOCK_VARIANTS[type]) {
        expect(blockRegistry.validateProps(type, variant, {})).toEqual([]);
      }
    }
  });

  it('refuses unknown props, wrong layouts, unsafe links and media URLs', () => {
    expect(blockRegistry.validateProps('hero', 'centered', { color: '#fff' }).join()).toMatch(
      /color/,
    );
    expect(blockRegistry.validateProps('hero', 'poster', {})[0]).toMatch(/not a hero layout/);
    expect(
      blockRegistry.validateProps('hero', 'centered', { ctaHref: 'javascript:alert(1)' }),
    ).not.toEqual([]);
    expect(
      blockRegistry.validateProps('gallery', 'grid', {
        images: [{ media: { mediaId: 'https://x.example/a.png' } }],
      }),
    ).not.toEqual([]);
    expect(
      blockRegistry.validateProps('hero', 'centered', { headline: 'x'.repeat(161) }),
    ).not.toEqual([]);
    expect(
      blockRegistry.validateProps('embed', 'inline', {
        provider: 'youtube',
        embedId: '"><script>',
      }),
    ).not.toEqual([]);
    expect(
      blockRegistry.validateProps('embed', 'inline', {
        provider: 'youtube',
        embedId: 'dQw4w9WgXcQ',
      }),
    ).toEqual([]);
  });

  it('marks gated and call links owner-only', () => {
    expect(blockRegistry.isOwnerOnlyProp('materials', 'items')).toBe(true);
    expect(blockRegistry.isOwnerOnlyProp('join_remote', 'href')).toBe(true);
    expect(blockRegistry.isOwnerOnlyProp('hero', 'headline')).toBe(false);
  });

  it('summarises sections in one line', () => {
    expect(blockRegistry.get('agenda')!.summary({ heading: 'The day', items: [{}, {}] })).toBe(
      'Agenda: The day – 2 items',
    );
    expect(blockRegistry.get('hero')!.summary({ headline: 'Hello' })).toBe('Cover: Hello');
  });
});

describe('starters', () => {
  it('ships the five TipTop starters plus Blank', () => {
    expect(STARTERS.map((s) => s.id)).toEqual([
      'agm-day-evening',
      'founder-golf',
      'dinner-salon',
      'demo-day',
      'holiday-party',
      'blank',
    ]);
    expect(getStarter(undefined).id).toBe('blank');
  });

  it.each(STARTERS.map((s) => [s.id, s] as const))(
    '%s validates with its preset',
    (_id, starter) => {
      let n = 0;
      const doc = previewPage(starter.themePresetId, { starterId: starter.id }).doc;
      expect(parseEventDoc(doc, validators)).toMatchObject({ ok: true });
      const raw = {
        ...doc,
        sections: starter.sections.map((t) =>
          placeSection(t, `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, `a${n}`),
        ),
      };
      expect(parseEventDoc(raw, validators)).toMatchObject({ ok: true });
      expect(THEME_PRESETS.some((p) => p.id === starter.themePresetId)).toBe(true);
    },
  );

  it('uses fictional copy only (no real emails, links or addresses)', () => {
    const text = JSON.stringify(STARTERS);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/tiptop\.vc|Capital Factory|Clutch|Arena Modern|Davis St/i);
  });

  it('gates the AGM pre-reads to LPs', () => {
    const materials = getStarter('agm-day-evening').sections.find((s) => s.type === 'materials');
    expect(materials?.visibility).toEqual({ mode: 'tags', tags: ['LP'] });
  });

  it('keeps the demo store’s event pages valid under the strict registry', () => {
    const { events } = demoEvents(new Date('2026-10-22T12:00:00Z'));
    for (const event of events) {
      expect(parseEventDoc(event.draft_doc, validators)).toMatchObject({ ok: true });
    }
  });
});

describe('the guest renderer', () => {
  const base = previewPage('tiptop-signature');

  it('keeps the DOM contract (root, sections, studio fields)', () => {
    const live = render({ doc: base.doc });
    expect(live).toMatch(/<main id="main" data-event-root=""/);
    for (const s of base.doc.sections) {
      expect(live).toContain(`data-section-id="${s.id}"`);
      expect(live).toContain(`data-block="${s.type}"`);
    }
    expect(live).not.toContain('data-field=');
    const studio = render({
      doc: base.doc,
      mode: 'studio',
      selectedSectionId: base.doc.sections[0]!.id,
    });
    expect(studio).toContain('data-field="props.headline"');
    expect(studio).toContain('data-selected="true"');
  });

  it('renders every block type and variant without throwing', () => {
    let n = 0;
    for (const type of BLOCK_TYPES as BlockType[]) {
      for (const variant of BLOCK_VARIANTS[type]) {
        const template = sectionTemplate(type, blockRegistry.get(type)!.defaults().props, variant);
        const section = placeSection(
          template,
          `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
          'a0',
        );
        for (const mode of ['live', 'studio', 'og'] as EventRenderMode[]) {
          const html = render({ doc: { ...base.doc, sections: [section] }, mode });
          expect(html).toContain(`data-block="${type}"`);
        }
      }
    }
  });

  it('renders every preset with sample content', () => {
    for (const preset of THEME_PRESETS) {
      const page = previewPage(preset.id, { intro: true });
      const html = renderToStaticMarkup(
        createElement(EventPage, {
          ...page,
          viewer: SAMPLE_GUEST_VIEWER,
          mode: 'live',
          rsvp: page.rsvp,
        }),
      );
      expect(html).toContain(`data-preset="${preset.id}"`);
      expect(html).toContain('--ev-l-bg:');
    }
  });

  it('renders outsider text as text, never markup', () => {
    const doc = structuredClone(base.doc);
    const hero = doc.sections.find((s) => s.type === 'hero')!;
    hero.props.headline = '<script>alert(1)</script>';
    hero.props.subheadline = '<img src=x onerror=alert(1)>';
    const html = render({ doc });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('personalises on invite links and shows the fallback publicly', () => {
    const doc = structuredClone(base.doc);
    doc.sections.find((s) => s.type === 'hero')!.props.headline =
      "{{first_name|Friend}}, you're invited";
    expect(render({ doc, viewer: SAMPLE_GUEST_VIEWER })).toContain('Sarah, you&#x27;re invited');
    expect(render({ doc })).toContain('Friend, you&#x27;re invited');
  });

  it('plays the intro only on live and preview pages, addressed to the guest', () => {
    const page = previewPage('envelope-wax-seal', { intro: true });
    const live = renderToStaticMarkup(
      createElement(EventPage, { ...page, viewer: SAMPLE_GUEST_VIEWER, mode: 'live' }),
    );
    expect(live).toContain('class="ev-intro"');
    expect(live).toContain('Dear Sarah,');
    const studio = renderToStaticMarkup(
      createElement(EventPage, { ...page, viewer: SAMPLE_GUEST_VIEWER, mode: 'studio' }),
    );
    expect(studio).not.toContain('class="ev-intro"');
    const og = renderToStaticMarkup(
      createElement(EventPage, { ...page, viewer: PUBLIC_VIEWER, mode: 'og' }),
    );
    expect(og).not.toContain('class="ev-intro"');
    expect(og).not.toContain('ev-pause');
  });

  it('shows the Pause control only for looping themes on live pages', () => {
    expect(render({ doc: previewPage('starfield').doc })).toContain('Pause animations');
    expect(render({ doc: previewPage('monochrome-gallery').doc })).not.toContain(
      'Pause animations',
    );
    expect(render({ doc: previewPage('starfield').doc, motion: 'off' })).not.toContain(
      'Pause animations',
    );
  });

  it('marks the motion level for reduced and off previews', () => {
    expect(render({ doc: base.doc, motion: 'reduced' })).toContain('data-motion="reduced"');
    expect(render({ doc: base.doc, motion: 'full' })).toContain('data-motion-force="true"');
  });

  it('hides agenda items tied to a session the viewer cannot see', () => {
    const doc = structuredClone(base.doc);
    const agenda = doc.sections.find((s) => s.type === 'agenda')!;
    agenda.props.items = [
      { time: '1:00 PM', title: 'Open to all' },
      {
        time: '6:00 PM',
        title: 'Reception only',
        sessionId: '00000000-0000-4000-8000-00000000dead',
      },
    ];
    const html = render({ doc });
    expect(html).toContain('Open to all');
    expect(html).not.toContain('Reception only');
  });

  it('shows the cancelled state with the host’s message', () => {
    const html = render({
      doc: base.doc,
      facts: { ...base.facts, cancelled: { message: 'We will be in touch.' } },
    });
    expect(html).toContain('This event has been cancelled');
    expect(html).toContain('We will be in touch.');
  });

  it('keeps the address hidden until the reveal rule allows it', () => {
    const facts = {
      ...base.facts,
      venue: { ...base.facts.venue!, address: null, revealed: false, revealRule: 'going' as const },
    };
    const html = render({ doc: base.doc, facts });
    expect(html).toContain('The address is shared with confirmed guests.');
    expect(html).not.toContain('google.com/maps/dir');
  });

  it('builds directions links from the revealed address', () => {
    expect(render({ doc: base.doc })).toContain(
      'https://www.google.com/maps/dir/?api=1&amp;destination=100%20Example%20Avenue%2C%20Springfield',
    );
  });

  it('uses only preset fonts the page declares', () => {
    const t = getThemePreset('boardroom-noir').theme;
    const html = render({ doc: previewPage('boardroom-noir').doc });
    expect(html).toContain(`ev-${t.typography.display}`);
  });
});
