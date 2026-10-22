import { describe, expect, it } from 'vitest';
import { LineAssembler, joinText, type AssembledLine } from '@/lib/capture/lines';

/** Vendor pieces into transcript lines (D-076, WS3). */

function collect() {
  const lines: AssembledLine[] = [];
  const asm = new LineAssembler((l) => lines.push(l));
  return { lines, asm };
}

const piece = (
  text: string,
  startMs: number,
  endMs: number,
  speakerLabel: string | null = 'S1',
  confidence: number | null = 0.9,
) => ({ track: 'system' as const, speakerLabel, startMs, endMs, text, confidence });

describe('joining words', () => {
  it('spaces words and keeps punctuation on the word before it', () => {
    expect(joinText('We closed', 'the round')).toBe('We closed the round');
    expect(joinText('the round', '.')).toBe('the round.');
    expect(joinText('Hi', ', Dana')).toBe('Hi, Dana');
    expect(joinText('', 'Hello')).toBe('Hello');
    expect(joinText('Up', '20%')).toBe('Up 20%');
  });
});

describe('the line assembler', () => {
  it('joins one voice’s pieces into one line and closes it at the end of a sentence', () => {
    const { lines, asm } = collect();
    asm.add(piece('We make picking robots', 0, 1800));
    asm.add(piece('for small warehouses.', 1900, 3200));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: 'We make picking robots for small warehouses.',
      startMs: 0,
      endMs: 3200,
      pieces: 2,
      speakerLabel: 'S1',
    });
    expect(lines[0]?.confidence).toBeCloseTo(0.9);
  });

  it('starts a new line when the voice changes', () => {
    const { lines, asm } = collect();
    asm.add(piece('So the margin is', 0, 1000, 'S1'));
    asm.add(piece('What about churn', 1100, 2000, 'S2'));
    expect(lines.map((l) => l.text)).toEqual(['So the margin is']);
    asm.flush();
    expect(lines.map((l) => l.speakerLabel)).toEqual(['S1', 'S2']);
  });

  it('starts a new line after a pause, and closes an idle one', () => {
    const { lines, asm } = collect();
    asm.add(piece('Okay', 0, 400));
    asm.add(piece('next topic', 2500, 3200)); // 2.1 s later
    expect(lines.map((l) => l.text)).toEqual(['Okay']);
    asm.tick(4000);
    expect(lines).toHaveLength(1);
    asm.tick(5800); // 2.6 s after the last word
    expect(lines.map((l) => l.text)).toEqual(['Okay', 'next topic']);
  });

  it('shows the line being built, and ignores empty pieces', () => {
    const { lines, asm } = collect();
    asm.add(piece('   ', 0, 100));
    expect(asm.current()).toBeNull();
    asm.add(piece('Half a', 0, 500));
    expect(asm.current()?.text).toBe('Half a');
    expect(lines).toHaveLength(0);
  });

  it('passes whole turns (AssemblyAI, the mock) through as they are', () => {
    const { lines, asm } = collect();
    asm.add(piece('Hi! Glad to finally meet.', 10_000, 13_000, 'S2'));
    expect(lines).toEqual([
      expect.objectContaining({ text: 'Hi! Glad to finally meet.', pieces: 1 }),
    ]);
  });
});
