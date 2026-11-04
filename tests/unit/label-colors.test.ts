import { describe, expect, it } from 'vitest';
import { GMAIL_LABEL_PALETTE, isGmailLabelColor, LABEL_COLOR_GRID } from '@/lib/email/label-colors';
import { DEMO_MAIL_LABELS } from '@/lib/demo/inbox-labels-fixtures';

describe("Gmail's label colours", () => {
  it('every picker swatch is a pair the Gmail API accepts', () => {
    expect(LABEL_COLOR_GRID).toHaveLength(64);
    for (const c of LABEL_COLOR_GRID) expect(isGmailLabelColor(c), c.bg).toBe(true);
    expect(new Set(GMAIL_LABEL_PALETTE).size).toBe(GMAIL_LABEL_PALETTE.length);
  });
  it('refuses any other hex, and the demo labels use the palette', () => {
    expect(isGmailLabelColor({ bg: '#123456', fg: '#ffffff' })).toBe(false);
    for (const l of DEMO_MAIL_LABELS) if (l.color) expect(isGmailLabelColor(l.color)).toBe(true);
  });
});
