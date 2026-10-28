import { describe, expect, it } from 'vitest';
import { newEventDoc, sectionTemplate } from '@/lib/events/doc';
import { keyAfter, keyBetween } from '@/lib/events/fractional';
import {
  BLOCK_TYPES,
  BLOCK_VARIANTS,
  FONT_IDS,
  MAX_DOC_BYTES,
  orderedSections,
  parseEventDoc,
  parseSection,
  sectionKeySchema,
  themeKeySchema,
  THEME_KEYS,
  type EventDoc,
} from '@/lib/events/schema';
import { STARTERS } from '@/lib/events/starters';
import { getThemePreset, THEME_PRESETS } from '@/lib/events/themes';

/**
 * The EventDoc schema (D-075): the one document outsiders write into and
 * guests' browsers render on Kraken's own origin. Every rule that keeps
 * script, CSS, raw URLs and surprise keys out is pinned here.
 */

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
}

function doc(): EventDoc {
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'A fictional gathering', subheadline: '' }),
      sectionTemplate('agenda', { items: [{ time: '1:00 PM', title: 'Welcome' }] }),
      sectionTemplate('rsvp', { cta: 'RSVP' }),
    ],
    ids(),
  );
}

describe('a valid document', () => {
  it('parses, with sections in fractional order', () => {
    const d = doc();
    const parsed = parseEventDoc(d);
    expect(parsed.ok).toBe(true);
    expect(orderedSections(d.sections).map((s) => s.type)).toEqual(['hero', 'agenda', 'rsvp']);
  });

  it('every starter and every preset makes a valid document', () => {
    for (const starter of STARTERS) {
      for (const preset of THEME_PRESETS) {
        const parsed = parseEventDoc(newEventDoc(preset.theme, starter.sections, ids()));
        expect(parsed.ok ? 'ok' : parsed.issues).toBe('ok');
      }
    }
  });

  it('every block type has at least one variant and the font library is about 50 families', () => {
    for (const type of BLOCK_TYPES) expect(BLOCK_VARIANTS[type].length).toBeGreaterThan(0);
    expect(FONT_IDS.length).toBeGreaterThanOrEqual(45);
    expect(new Set(FONT_IDS).size).toBe(FONT_IDS.length);
  });
});

describe('strictness', () => {
  it('rejects an unknown key anywhere: doc, theme, section, style', () => {
    const base = doc();
    const cases: ((d: Record<string, any>) => void)[] = [
      (d) => (d.extra = 1),
      (d) => (d.theme.customCss = 'body{}'),
      (d) => (d.sections[0].html = '<b>hi</b>'),
      (d) => (d.sections[0].style.css = 'color:red'),
      (d) => (d.theme.palette.script = '#000000'),
    ];
    for (const mutate of cases) {
      const d = structuredClone(base) as unknown as Record<string, any>;
      mutate(d);
      expect(parseEventDoc(d).ok).toBe(false);
    }
  });

  it('colours are exact 6-digit hex', () => {
    for (const bad of ['red', '#fff', '#12345g', 'url(javascript:x)', '#0000000']) {
      const d = structuredClone(doc());
      (d.theme.palette as Record<string, string>).accent = bad;
      expect(parseEventDoc(d).ok).toBe(false);
    }
  });

  it('fonts and effects come from enums', () => {
    const d1 = structuredClone(doc()) as unknown as Record<string, any>;
    d1.theme.typography.display = 'Comic Sans';
    expect(parseEventDoc(d1).ok).toBe(false);
    const d2 = structuredClone(doc()) as unknown as Record<string, any>;
    d2.theme.background.engine = 'iframe';
    expect(parseEventDoc(d2).ok).toBe(false);
  });

  it('numbers are bounded', () => {
    const d = structuredClone(doc());
    d.theme.typography.bodySize = 12;
    expect(parseEventDoc(d).ok).toBe(false);
  });

  it('a variant must belong to its block', () => {
    const d = structuredClone(doc());
    d.sections[0]!.variant = 'scorecard';
    expect(parseEventDoc(d).ok).toBe(false);
  });

  it('duplicate section ids or positions are refused', () => {
    const d1 = structuredClone(doc());
    d1.sections[1]!.id = d1.sections[0]!.id;
    expect(parseEventDoc(d1).ok).toBe(false);
    const d2 = structuredClone(doc());
    d2.sections[1]!.position = d2.sections[0]!.position;
    expect(parseEventDoc(d2).ok).toBe(false);
  });

  it('caps the serialized size', () => {
    const d = structuredClone(doc());
    for (let i = 0; i < 25; i++) d.sections[0]!.props[`body${i}`] = 'x'.repeat(19_000);
    expect(JSON.stringify(d).length).toBeGreaterThan(MAX_DOC_BYTES);
    const parsed = parseEventDoc(d);
    expect(!parsed.ok && parsed.issues).toEqual(['(doc): the page is too large.']);
  });
});

describe('props guards (before any block registry)', () => {
  it('link-ish keys must be allowed hrefs, at any depth', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '{{rsvp_link}}']) {
      const d = structuredClone(doc());
      d.sections[1]!.props.items = [{ title: 'x', href: bad }];
      expect(parseEventDoc(d).ok).toBe(false);
    }
    const ok = structuredClone(doc());
    ok.sections[1]!.props.items = [
      { title: 'x', url: 'https://example.com', link: 'mailto:a@example.com' },
    ];
    expect(parseEventDoc(ok).ok).toBe(true);
  });

  it('media is referenced by id, never by URL', () => {
    const d = structuredClone(doc());
    d.sections[0]!.props.mediaId = 'https://evil.example/x.png';
    expect(parseEventDoc(d).ok).toBe(false);
    const d2 = structuredClone(doc());
    d2.sections[0]!.props.mediaId = '00000000-0000-4000-8000-0000000000aa';
    expect(parseEventDoc(d2).ok).toBe(true);
  });

  it('props keys are plain identifiers and nesting is bounded', () => {
    const d = structuredClone(doc());
    (d.sections[0]!.props as Record<string, unknown>)['__proto__x'] = 1;
    expect(parseEventDoc(d).ok).toBe(false);
    const deep = structuredClone(doc());
    deep.sections[0]!.props.a = { b: { c: { d: { e: { f: { g: 1 } } } } } };
    expect(parseEventDoc(deep).ok).toBe(false);
  });

  it('the registry hook can refuse what the generic guards allow', () => {
    const parsed = parseEventDoc(doc(), {
      validateProps: (type) => (type === 'agenda' ? ['items: unknown field'] : []),
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issues[0]).toMatch(/agenda|items/);
  });
});

describe('per-key schemas for ops', () => {
  it('every theme key has a schema, and section field keys too', () => {
    const theme = getThemePreset('tiptop-signature').theme;
    for (const key of THEME_KEYS) {
      expect(themeKeySchema(key).safeParse(theme[key]).success).toBe(true);
    }
    expect(sectionKeySchema('visibility').safeParse({ mode: 'going', tags: [] }).success).toBe(
      true,
    );
    expect(sectionKeySchema('visibility').safeParse({ mode: 'secret', tags: [] }).success).toBe(
      false,
    );
  });

  it('parseSection checks one section', () => {
    expect(parseSection(doc().sections[0]).ok).toBe(true);
    expect(parseSection({ ...doc().sections[0], type: 'script' }).ok).toBe(false);
  });
});

describe('fractional positions', () => {
  it('sorts lexicographically and inserts between neighbours', () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
    const sections = [
      { id: 'x', position: a },
      { id: 'y', position: b },
    ];
    const afterX = keyAfter(sections, 'x');
    expect(afterX > a && afterX < b).toBe(true);
    expect(keyAfter(sections, null) < a).toBe(true);
    expect(keyAfter(sections, 'missing') > b).toBe(true);
  });
});
