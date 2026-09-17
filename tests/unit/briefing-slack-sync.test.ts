import { describe, expect, it } from 'vitest';
import { toPayload } from '../../scripts/briefing-slack-sync.mjs';

/**
 * The briefing-card relay's pure half.
 *
 * The two mistakes that would hurt: relaying a human message (the routine's
 * own teaser, or Arwin replying in the same DM) as though it were a payload,
 * and accepting a payload missing a field the webhook requires — either
 * would post garbage, or nothing at all, to the Today page.
 */

const MORNING_PAYLOAD = {
  kind: 'morning',
  date_key: '2026-09-18',
  title: 'Morning Brief — Friday, Sep 18, 2026',
  summary: 'Empty calendar. Two act-today items.',
  source_url: 'https://claude.ai/artifact/abc-123',
};

function relayMessage(payload: unknown, ts = '1785200000.000100') {
  return { ts, text: `BRIEFING_PAYLOAD_V1\n\`${JSON.stringify(payload)}\`` };
}

describe('payload extraction', () => {
  it('parses a well-formed relay message', () => {
    expect(toPayload(relayMessage(MORNING_PAYLOAD))).toEqual(MORNING_PAYLOAD);
  });

  it('unescapes Slack entities without misreading the backtick-wrapped JSON', () => {
    const payload = { ...MORNING_PAYLOAD, title: 'Q1 &amp; Q2 review' };
    expect(toPayload(relayMessage(payload))?.title).toBe('Q1 & Q2 review');
  });

  it("rejects the routine's own human-facing teaser message", () => {
    const teaser = {
      ts: '1785200000.000200',
      text: "Sep 18: quiet morning, 0 meetings.\nhttps://claude.ai/artifact/abc-123\nBoth links are private — open each and set it to 'Anyone with the link' before sending to Nick.",
    };
    expect(toPayload(teaser)).toBeNull();
  });

  it('rejects a plain message from Arwin in the same DM', () => {
    expect(
      toPayload({ ts: '1785200000.000300', text: 'stop including DocuSign items' }),
    ).toBeNull();
  });

  it('rejects a marker line with no backtick-wrapped JSON', () => {
    expect(toPayload({ ts: '1785200000.000400', text: 'BRIEFING_PAYLOAD_V1' })).toBeNull();
  });

  it('rejects malformed JSON inside the backticks', () => {
    expect(
      toPayload({ ts: '1785200000.000500', text: 'BRIEFING_PAYLOAD_V1\n`{not valid json`' }),
    ).toBeNull();
  });

  it('rejects a payload with an unrecognized kind', () => {
    const payload = { ...MORNING_PAYLOAD, kind: 'evening' };
    expect(toPayload(relayMessage(payload))).toBeNull();
  });

  it('rejects a payload missing a required field', () => {
    const { title: _title, ...rest } = MORNING_PAYLOAD;
    expect(toPayload(relayMessage(rest))).toBeNull();
  });

  it('accepts the dossier kind with no source_url', () => {
    const payload = {
      kind: 'dossier',
      date_key: '2026-09-18',
      title: "Nick's Friday Dossier",
      summary: 'No one to prep for today.',
    };
    expect(toPayload(relayMessage(payload))).toEqual(payload);
  });
});
