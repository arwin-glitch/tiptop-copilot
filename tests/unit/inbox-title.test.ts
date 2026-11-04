import { describe, expect, it } from 'vitest';
import { inboxTitle } from '@/components/inbox/live-inbox';

describe("Gmail's unread count in the tab title", () => {
  it('adds, updates and drops the count on the Inbox title only', () => {
    expect(inboxTitle(42, 'Inbox · TipTop Kraken')).toBe('Inbox (42) · TipTop Kraken');
    expect(inboxTitle(1234, 'Inbox (42) · TipTop Kraken')).toBe('Inbox (1,234) · TipTop Kraken');
    expect(inboxTitle(0, 'Inbox (42) · TipTop Kraken')).toBe('Inbox · TipTop Kraken');
    expect(inboxTitle(null, 'Inbox (7) · TipTop Kraken')).toBe('Inbox · TipTop Kraken');
    expect(inboxTitle(5, 'Today · TipTop Kraken')).toBe('Today · TipTop Kraken');
  });
});
