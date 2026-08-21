import { describe, expect, it } from 'vitest';
import {
  isBlockedUnfurl,
  isGranolaMessage,
  toPayload,
  unescapeSlackText,
} from '../../scripts/granola-slack-sync.mjs';

/**
 * The Slack poller's pure half.
 *
 * The two mistakes that would hurt: forwarding a human's message from the
 * channel as though it were a meeting note, and giving the same note a
 * different identity than the Mac watcher gives it — which would fork one
 * meeting into two rows instead of letting the fuller version replace the
 * summary.
 */

const GRANOLA_POST = {
  ts: '1785200000.000100',
  text: '*Vetrix — corpus licensing walk-through*\nPriya walked through the licensing question. Year-six rights are capped.\n<https://notes.granola.ai/d/abc-123-def|View note>',
  bot_profile: { name: 'Granola' },
};

describe('message filtering', () => {
  it('accepts a post from the Granola app', () => {
    expect(isGranolaMessage(GRANOLA_POST)).toBe(true);
  });

  it('accepts a Granola-linked post even when the bot name is missing', () => {
    expect(isGranolaMessage({ ts: '1.2', text: 'see https://notes.granola.ai/d/x' })).toBe(true);
  });

  it('rejects a human chatting in the same channel', () => {
    expect(
      isGranolaMessage({ ts: '1.2', text: 'love these granola summaries, keep them coming' }),
    ).toBe(false);
  });
});

describe('payload shape', () => {
  it('uses the Granola note id as identity, so the Mac watcher converges on the same row', () => {
    const payload = toPayload(GRANOLA_POST);
    expect(payload?.external_id).toBe('abc-123-def');
  });

  it('falls back to the Slack timestamp when no note link is present', () => {
    const payload = toPayload({
      ts: '1785200000.000200',
      text: 'Weekly sync summary',
      bot_profile: { name: 'Granola' },
    });
    expect(payload?.external_id).toBe('slack-1785200000.000200');
  });

  it('takes the first line as the title, stripped of Slack formatting', () => {
    expect(toPayload(GRANOLA_POST)?.title).toBe('Vetrix — corpus licensing walk-through');
  });

  it('sends no attendees rather than inventing them — recovery is the server calendar match', () => {
    const payload = toPayload(GRANOLA_POST);
    expect(payload?.attendee_emails).toBe('');
    expect(payload?.attendee_names).toBe('');
  });

  it('carries the note link as source_url', () => {
    expect(toPayload(GRANOLA_POST)?.source_url).toBe('https://notes.granola.ai/d/abc-123-def');
  });
});

describe('unescapeSlackText', () => {
  it('renders Slack link syntax readably and unescapes entities', () => {
    expect(unescapeSlackText('see <https://x.com|the site> &amp; more')).toBe(
      'see the site (https://x.com) & more',
    );
  });
});

describe('blocked link previews', () => {
  // Verbatim from #granola-notes: what Slack posts when the note is private.
  const BLOCKED = {
    ts: '1787321022.387009',
    text: '*<https://notes.granola.ai/t/aa8eaf4e-88f2-48c8-a9c8-2e08115e4479|Granola meeting notes>*\nBeautiful meeting notes, powered by AI. No bots, no busywork.\n\n:lock: *Private meeting notes*\nLog in to Granola to view this note',
    bot_profile: { name: 'Nick Tippmann (with Granola)' },
  };

  it('refuses a post that is only a blocked preview', () => {
    // It looks like a Granola message and carries a real note id, so every
    // earlier check passes — this is the one that has to stop it.
    expect(isGranolaMessage(BLOCKED)).toBe(true);
    expect(toPayload(BLOCKED)).toBeNull();
  });

  it('would otherwise have filed marketing copy as a meeting record', () => {
    expect(isBlockedUnfurl(BLOCKED.text)).toBe(true);
    expect(isBlockedUnfurl('Vetrix sync — Priya confirmed the cap.')).toBe(false);
  });
});
