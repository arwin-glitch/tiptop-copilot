import { describe, expect, it } from 'vitest';
import {
  isAutoReply,
  isAutomatedAgent,
  isPrefetch,
  withinScanWindow,
} from '@/lib/campaigns/activity';
import { campaignPhase } from '@/lib/campaigns/status';
import { isTrackedLink, parseTemplate, showsAddress, type Inline } from '@/lib/campaigns/template';

/** Telling a person from a machine, a reply from an out-of-office, and where a campaign stands. */

describe('isAutomatedAgent', () => {
  it('passes mail apps and the image proxies that stand in for readers', () => {
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
      'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17328; Pro)',
    ]) {
      expect(isAutomatedAgent(ua), ua).toBe(false);
    }
  });

  it('flags HTTP libraries, scanners, bots and no user agent at all', () => {
    for (const ua of [
      null,
      '',
      'python-requests/2.31.0',
      'curl/8.4.0',
      'Go-http-client/1.1',
      'okhttp/4.12.0',
      'Mozilla/5.0 (compatible; Barracuda Sentinel)',
      'Mimecast-URL-Protect/1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 HeadlessChrome/120.0',
    ]) {
      expect(isAutomatedAgent(ua), String(ua)).toBe(true);
    }
  });
});

describe('isPrefetch', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  it('reads the prefetch markers browsers and proxies send', () => {
    expect(isPrefetch(headers({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetch(headers({ 'sec-purpose': 'prefetch;prerender' }))).toBe(true);
    expect(isPrefetch(headers({ 'x-moz': 'prefetch' }))).toBe(true);
    expect(isPrefetch(headers({}))).toBe(false);
  });
});

describe('withinScanWindow', () => {
  const sent = '2026-10-15T12:00:00.000Z';
  it('is the first minute after the send', () => {
    expect(withinScanWindow(sent, new Date('2026-10-15T12:00:05Z'))).toBe(true);
    expect(withinScanWindow(sent, new Date('2026-10-15T12:00:59Z'))).toBe(true);
    expect(withinScanWindow(sent, new Date('2026-10-15T12:01:01Z'))).toBe(false);
    expect(withinScanWindow(null, new Date())).toBe(false);
  });
});

describe('isAutoReply', () => {
  const sent = '2026-12-22T15:00:00.000Z';
  const at = (minutes: number) => new Date(Date.parse(sent) + minutes * 60_000).toISOString();
  it('knows automatic replies by their subject, in several languages', () => {
    for (const subject of [
      'Automatic reply: TipTop Q4 update',
      'Auto-Reply: TipTop Q4 update',
      'Out of Office: TipTop Q4 update',
      'Re: Out of office',
      'Abwesenheitsnotiz: TipTop Q4 update',
      'Réponse automatique : TipTop Q4 update',
      'Respuesta automática: TipTop Q4 update',
    ]) {
      expect(isAutoReply({ subject, snippet: '', sent_at: at(400) }, sent), subject).toBe(true);
    }
  });

  it('reads the opening line of a responder that keeps "Re:", but only soon after the send', () => {
    const ooo = {
      subject: 'Re: TipTop Q4 update',
      snippet: 'I am currently out of the office with limited access to email until January 4.',
    };
    expect(isAutoReply({ ...ooo, sent_at: at(1) }, sent)).toBe(true);
    // Days later, words like these are a person writing.
    expect(isAutoReply({ ...ooo, sent_at: at(3 * 24 * 60) }, sent)).toBe(false);
  });

  it('leaves real replies alone', () => {
    for (const snippet of [
      'Thanks Nick, great quarter. Can we talk about the Fund II allocation?',
      'Congrats on the close!',
    ]) {
      expect(isAutoReply({ subject: 'Re: TipTop Q4 update', snippet, sent_at: at(2) }, sent)).toBe(
        false,
      );
    }
  });
});

describe('links that show an address', () => {
  const first = (body: string) => {
    const [block] = parseTemplate(body).blocks;
    const nodes = block && block.t === 'p' ? block.c : [];
    return nodes.find((n): n is Extract<Inline, { t: 'a' }> => n.t === 'a') as Extract<
      Inline,
      { t: 'a' }
    >;
  };

  it('bare URLs and address-like link text are never tracked', () => {
    for (const body of [
      'See https://docsend.example/view/abc',
      '[https://docsend.example/view/abc](https://docsend.example/view/abc)',
      '[docsend.example/view/abc](https://docsend.example/view/abc)',
      '[www.tiptop.example](https://www.tiptop.example)',
      '[tiptop.example](https://evil.example)',
    ]) {
      const link = first(body);
      expect(showsAddress(link), body).toBe(true);
      expect(isTrackedLink(link), body).toBe(false);
    }
  });

  it('words are tracked', () => {
    for (const body of [
      '[read the letter](https://tiptop.example/q4)',
      '[Q4 update](https://x.example)',
    ]) {
      const link = first(body);
      expect(showsAddress(link), body).toBe(false);
      expect(isTrackedLink(link), body).toBe(true);
    }
  });
});

describe('campaignPhase', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const base = {
    status: 'sending' as const,
    pause_reason: null,
    updated_at: '2026-10-15T11:59:30Z',
    last_sent_at: '2026-10-15T11:59:58Z',
  };
  it('a sending campaign nobody has driven for a while has stopped', () => {
    expect(campaignPhase(base, now)).toBe('sending');
    expect(
      campaignPhase(
        { ...base, updated_at: '2026-10-15T11:50:00Z', last_sent_at: '2026-10-15T11:50:00Z' },
        now,
      ),
    ).toBe('stalled');
  });

  it('a pause at the cap reads as the daily limit', () => {
    expect(campaignPhase({ ...base, status: 'paused', pause_reason: 'capped' }, now)).toBe(
      'capped',
    );
    expect(campaignPhase({ ...base, status: 'paused', pause_reason: 'left' }, now)).toBe('paused');
    expect(campaignPhase({ ...base, status: 'sent' }, now)).toBe('sent');
  });
});
