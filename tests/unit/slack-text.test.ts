import { describe, expect, it } from 'vitest';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { parseBriefingRelayMessage } from '@/lib/services/briefing';

const TICK = String.fromCharCode(96);
const wrap = (json: string) => ['BRIEFING_PAYLOAD_V1', TICK + json + TICK].join('\n');

describe('unwrapSlackText', () => {
  it('unwraps bare and labelled links, then the entities', () => {
    expect(unwrapSlackText('a <https://x.dev/p?q=1> b')).toBe('a https://x.dev/p?q=1 b');
    expect(unwrapSlackText('<https://x.dev|x.dev>')).toBe('https://x.dev');
    expect(unwrapSlackText('Q&amp;A &lt;3 &gt;')).toBe('Q&A <3 >');
  });

  it('does not treat an escaped less-than as a link', () => {
    expect(unwrapSlackText('&lt;https://x.dev&gt;')).toBe('<https://x.dev>');
  });
});

describe('a briefing relay message as Slack actually returns it', () => {
  const body = (url: string) =>
    `{"kind": "afternoon", "date_key": "2026-09-21", "title": "T", "summary": "S", "source_url": "${url}"}`;

  it('parses when Slack has wrapped the source_url in link markup', () => {
    const p = parseBriefingRelayMessage(wrap(body('<https://claude.ai/artifact/88nPt3xPFmL2NvSFkjrZ6L>')));
    expect(p?.source_url).toBe('https://claude.ai/artifact/88nPt3xPFmL2NvSFkjrZ6L');
  });

  it('parses the labelled form too', () => {
    const p = parseBriefingRelayMessage(
      wrap(body('<https://claude.ai/artifact/abc|claude.ai/artifact/abc>')),
    );
    expect(p?.source_url).toBe('https://claude.ai/artifact/abc');
  });

  it('still parses a plain URL', () => {
    expect(parseBriefingRelayMessage(wrap(body('https://claude.ai/artifact/abc')))?.kind).toBe(
      'afternoon',
    );
  });
});
