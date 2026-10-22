import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  clipText,
  rowCount,
  softOptionalText,
  softRows,
  softText,
  softTextList,
} from '@/lib/relay/soft-fields';

/** The relay readers' soft display text and row-by-row lists (D-073). All text is invented. */

describe('clipText', () => {
  it('leaves text that fits alone, exactly at the limit included', () => {
    expect(clipText('Board prep', 40)).toBe('Board prep');
    const exact = 'a'.repeat(39) + 'b';
    expect(clipText(exact, 40)).toBe(exact);
    expect(clipText('', 10)).toBe('');
  });

  it('trims first, so surrounding whitespace never costs room or triggers a cut', () => {
    expect(clipText('   Board prep \n\t', 10)).toBe('Board prep');
    expect(clipText('  \n  ', 10)).toBe('');
  });

  it('cuts at the last word break, with an ellipsis, inside the limit', () => {
    const out = clipText('Bring the revised pilot plan and the hiring update', 30);
    expect(out).toBe('Bring the revised pilot plan…');
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('keeps the whole word when the cut lands right before a space', () => {
    // "Bring the revised pilot" is 23 characters; room before the ellipsis is 23.
    expect(clipText('Bring the revised pilot plan', 24)).toBe('Bring the revised pilot…');
  });

  it('never leaves a comma, colon or dash dangling before the ellipsis', () => {
    expect(clipText('Agenda: pricing, hiring, runway, and the board deck', 26)).toBe(
      'Agenda: pricing, hiring…',
    );
    expect(clipText('Two asks — intro to a design partner', 14)).toBe('Two asks…');
  });

  it('cuts mid-word only when there is no word break in the second half', () => {
    const url = `See https://notes.example/${'x'.repeat(80)}`;
    const out = clipText(url, 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('See https://notes.example/xxx')).toBe(true);
    expect(clipText('x'.repeat(400), 300)).toBe(`${'x'.repeat(299)}…`);
  });

  it('keeps line breaks inside the text and cuts on them like spaces', () => {
    expect(clipText('First line here\nsecond line goes on and on', 22)).toBe('First line here…');
  });

  it('never splits an emoji, a flag or an accented letter', () => {
    const emoji = `${'word '.repeat(3)}🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉`;
    for (let max = 10; max <= emoji.length; max++) {
      const out = clipText(emoji, max);
      expect(out.length).toBeLessThanOrEqual(max);
      // A lone surrogate would show as a broken glyph.
      expect(out).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
    const flags = '🇺🇸🇲🇽🇨🇦🇧🇷🇯🇵';
    // Each flag is four UTF-16 units: a cut keeps whole flags only.
    expect(clipText(flags, 10)).toBe('🇺🇸🇲🇽…');
    const family = 'Team 👩‍👩‍👧‍👦 offsite';
    expect(clipText(family, 12)).toBe('Team…');
    const accented = 'Café Café Café';
    const out = clipText(accented, 8);
    expect(out).toBe('Café…');
    expect(out.normalize('NFC')).toBe('Café…');
  });

  it('handles CJK text with no spaces by cutting at a whole character', () => {
    const cjk = '投資委員会の準備資料を送付してください'.repeat(3);
    const out = clipText(cjk, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('softText and softOptionalText', () => {
  const required = softText(30);
  const optional = softOptionalText(30);

  it('cut long text rather than refuse it, and keep it within the limit', () => {
    const long = 'Bring the revised pilot plan and the hiring update';
    expect(required.parse(long)).toBe('Bring the revised pilot plan…');
    expect(optional.parse(long)).toBe('Bring the revised pilot plan…');
  });

  it('still refuse a blank required value and anything that is not text', () => {
    expect(required.safeParse('   ').success).toBe(false);
    expect(required.safeParse(undefined).success).toBe(false);
    expect(required.safeParse(42).success).toBe(false);
    expect(optional.safeParse(42).success).toBe(false);
  });

  it('read a blank or missing optional value as null', () => {
    expect(optional.parse('  ')).toBeNull();
    expect(optional.parse(null)).toBeNull();
    expect(optional.parse(undefined)).toBeUndefined();
    const row = z.object({ note: optional }).parse({});
    expect(row.note ?? null).toBeNull();
  });
});

describe('softTextList', () => {
  const names = softTextList(3, 12);

  it('keeps at most the limit, each cut to fit, blanks and non-text left out', () => {
    expect(names.parse(['Jo Anne Example', '', 7, 'Bo Kim', 'Cy Lee', 'Di Moe'])).toEqual([
      'Jo Anne…',
      'Bo Kim',
      'Cy Lee',
    ]);
  });

  it('reads missing as empty and one name alone as a list of one', () => {
    expect(names.parse(undefined)).toEqual([]);
    expect(names.parse(null)).toEqual([]);
    expect(names.parse('Bo Kim')).toEqual(['Bo Kim']);
    expect(z.object({ who: names }).parse({}).who).toEqual([]);
  });
});

describe('softRows and rowCount', () => {
  const ROW = z.object({ kind: z.enum(['a', 'b']), title: softText(10) });
  const rows = softRows(ROW, 3);

  it('leaves out a row that fails, keeping the rest in order', () => {
    expect(rows.parse([{ kind: 'a', title: 'One' }, { kind: 'x', title: 'Two' }, 7])).toEqual([
      { kind: 'a', title: 'One' },
    ]);
  });

  it('reads no more than the limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'b', title: `T${i}` }));
    expect(rows.parse(many).map((r) => r.title)).toEqual(['T0', 'T1', 'T2']);
  });

  it('still refuses something that is not a list', () => {
    expect(rows.safeParse({ kind: 'a' }).success).toBe(false);
    expect(rows.safeParse(undefined).success).toBe(false);
  });

  it('counts the rows sent and kept, so a reader knows what it left out', () => {
    const sent = { events: [1, 2, 3], other: [1], notAList: 'x' };
    expect(rowCount(sent, ['events', 'other'])).toBe(4);
    expect(rowCount(sent, ['notAList', 'missing'])).toBe(0);
    expect(rowCount(null, ['events'])).toBe(0);
  });
});
