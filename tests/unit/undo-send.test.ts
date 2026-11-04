import { describe, expect, it } from 'vitest';
import { parseUndoSend, UNDO_SEND_CHOICES, undoSeconds } from '@/lib/email/undo-send';

describe('Undo Send period', () => {
  it("offers Gmail's four choices", () => {
    expect([...UNDO_SEND_CHOICES]).toEqual(['5', '10', '20', '30']);
  });

  it('reads a stored choice, and anything else as 10 seconds (never less than the old 8)', () => {
    expect(parseUndoSend('30')).toBe('30');
    expect(parseUndoSend('5')).toBe('5');
    expect(parseUndoSend(null)).toBe('10');
    expect(parseUndoSend('8')).toBe('10');
    expect(parseUndoSend('<script>')).toBe('10');
    expect(undoSeconds(parseUndoSend('20'))).toBe(20);
  });
});
