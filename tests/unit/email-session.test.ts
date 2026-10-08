import { describe, expect, it } from 'vitest';
import {
  buildSession,
  isSettled,
  sessionSummary,
  type SessionAnswer,
} from '@/lib/services/email-session';
import { collectFollowUps, type FollowUpsSnapshot } from '@/lib/services/follow-ups';
import { buildReplyMime, stripQuoted } from '@/lib/google/gmail-send';
import { swapSignOff } from '@/components/followups/email-session-client';
import { ARWIN_SIGNATURE_HTML } from '@/lib/email/signatures';

/** The email session: order, Arwin's pile, answers, context, and the outgoing email. */

const NOW = new Date('2026-10-08T15:00:00Z');

const EMPTY: FollowUpsSnapshot = collectFollowUps([]);

const queueItem = (id: string, group: string, who: string, about = 'Something', extra = {}) => ({
  id,
  who,
  about,
  group,
  call: group === 'archive' ? 'archive' : 'reply',
  flags: [],
  draft: 'on_thread',
  why: null,
  waiting_since: '2026-10-05T15:00:00Z',
  ...extra,
});

const post = (value: unknown) => `EMAIL_QUEUE_V1\n\`${JSON.stringify(value)}\``;

function snapshotWith(items: unknown[], extra: Partial<FollowUpsSnapshot> = {}): FollowUpsSnapshot {
  const snap = collectFollowUps([
    { ts: '1791400000.000100', user: 'U1', text: post({ run_at: '2026-10-08T11:00:00Z', items }) },
  ]);
  return { ...snap, ...extra };
}

describe('EMAIL_QUEUE_V1', () => {
  it('parses and joins parts of the newest run', () => {
    const run = '2026-10-08T11:00:00Z';
    const snap = collectFollowUps([
      {
        ts: '1791400002.000100',
        user: 'U1',
        text: post({ run_at: run, part: 2, items: [queueItem('aa00000000000002', 'money', 'B')] }),
      },
      {
        ts: '1791400001.000100',
        user: 'U1',
        text: post({ run_at: run, part: 1, items: [queueItem('aa00000000000001', 'today', 'A')] }),
      },
    ]);
    expect(snap.emailQueue?.items.map((i) => i.who)).toEqual(['A', 'B']);
  });

  it('rejects an unknown group', () => {
    const snap = collectFollowUps([
      {
        ts: '1791400001.000100',
        user: 'U1',
        text: post({
          run_at: '2026-10-08T11:00:00Z',
          items: [queueItem('aa00000000000001', 'someday', 'A')],
        }),
      },
    ]);
    expect(snap.emailQueue).toBeNull();
  });
});

describe('buildSession', () => {
  const items = [
    queueItem('aa00000000000005', 'replies', 'Maya'),
    queueItem('aa00000000000003', 'deals', 'Tom', 'Harbor Labs closing this week'),
    queueItem('aa00000000000001', 'today', 'Dana'),
    queueItem('aa00000000000006', 'archive', 'Event Hub'),
    queueItem('aa00000000000002', 'money', 'Ledgerly'),
  ];

  it('orders by urgency and splits Nick from Arwin', () => {
    const s = buildSession({
      snapshot: snapshotWith(items),
      answers: new Map(),
      deals: [],
      portfolio: [],
      now: NOW,
    });
    expect(s.items.map((i) => i.who)).toEqual(['Dana', 'Ledgerly', 'Tom', 'Maya', 'Event Hub']);
    expect(s.items.filter((i) => i.needsNick).map((i) => i.who)).toEqual([
      'Dana',
      'Ledgerly',
      'Tom',
    ]);
    expect(s.items[0]?.waitingDays).toBe(3);
  });

  it('adds radar people with no queued email, once', () => {
    const snap = snapshotWith(items, {
      relationships: {
        run_at: '2026-10-08T13:00:00Z',
        waiting: [
          {
            who: 'Tom',
            company: 'Harbor Labs',
            kind: 'portfolio',
            thread_id: 'bb00000000000001',
            since: '2026-10-01T00:00:00Z',
            days: 7,
          },
          {
            who: 'Grace Okafor',
            company: 'Lakeside',
            kind: 'prospective_lp',
            thread_id: 'bb00000000000002',
            since: '2026-10-04T00:00:00Z',
            days: 4,
            note: 'Asked for the deck',
          },
        ],
        cold: [],
      },
    });
    const s = buildSession({
      snapshot: snap,
      answers: new Map(),
      deals: [],
      portfolio: [],
      now: NOW,
    });
    const waiting = s.items.filter((i) => i.group === 'waiting');
    expect(waiting.map((i) => i.who)).toEqual(['Grace Okafor']);
    expect(waiting[0]?.needsNick).toBe(true);
  });

  it('links a deal, a portfolio company at risk and a Fund II LP by name', () => {
    const snap = snapshotWith(
      [queueItem('aa00000000000003', 'deals', 'Tom', 'Harbor Labs closing; Lakeside asked too')],
      {
        portfolioHealth: {
          run_at: '2026-10-08T12:00:00Z',
          companies: [{ name: 'Harbor Labs', flag: 'risk', asks: [] }],
        },
        lpPipeline: {
          run_at: '2026-10-08T12:00:00Z',
          fund: 'Fund II',
          lps: [{ who: 'Grace', firm: 'Lakeside', kind: 'family_office', stage: 'meeting' }],
        },
      },
    );
    const s = buildSession({
      snapshot: snap,
      answers: new Map(),
      deals: [{ id: 'd1', company_name: 'Harbor Labs', stage: 'diligence' }],
      portfolio: [{ id: 'p1', name: 'Harbor Labs' }],
      now: NOW,
    });
    expect(s.items[0]?.context.map((c) => c.kind)).toEqual(['deal', 'portfolio', 'risk', 'lp']);
    expect(s.items[0]?.context[0]?.href).toBe('/deals/d1');
  });

  it('does not match a name inside another word', () => {
    const snap = snapshotWith([queueItem('aa00000000000003', 'deals', 'Harlow Smith', 'Catch up')]);
    const s = buildSession({
      snapshot: snap,
      answers: new Map(),
      deals: [{ id: 'd1', company_name: 'Arlow', stage: 'lead' }],
      portfolio: [],
      now: NOW,
    });
    expect(s.items[0]?.context).toEqual([]);
  });

  it('applies answers: settled items leave the count, Later and "I\'ll handle it" do not', () => {
    const answer = (a: SessionAnswer['answer']): SessionAnswer => ({
      answer: a,
      note: null,
      signature: null,
      viaApp: false,
      at: NOW.toISOString(),
      by: 'Nick',
    });
    const answers = new Map([
      ['aa00000000000001', answer('sent')],
      ['aa00000000000002', answer('later')],
      ['aa00000000000005', answer('stop')],
    ]);
    const s = buildSession({
      snapshot: snapshotWith(items),
      answers,
      deals: [],
      portfolio: [],
      now: NOW,
    });
    const maya = s.items.find((i) => i.who === 'Maya');
    expect(maya?.needsNick).toBe(true);
    expect(isSettled(answers.get('aa00000000000001')!)).toBe(true);
    expect(isSettled(answers.get('aa00000000000002')!)).toBe(false);
    const summary = sessionSummary(s);
    expect(summary.answered).toBe(1);
    expect(summary.forNick).toBe(3);
    expect(summary.forArwin).toBe(1);
  });

  it('is empty without a queue or radar', () => {
    expect(
      buildSession({ snapshot: EMPTY, answers: new Map(), deals: [], portfolio: [], now: NOW })
        .state,
    ).toBe('empty');
  });
});

describe('outgoing email', () => {
  it('swaps the sign-off name only on the last line', () => {
    expect(swapSignOff('Hi Nick,\n\nThanks!\n\nBest,\nNick\n', 'arwin')).toBe(
      'Hi Nick,\n\nThanks!\n\nBest,\nArwin',
    );
    expect(swapSignOff('Best,\nArwin', 'nick')).toBe('Best,\nNick');
    expect(swapSignOff('No sign-off here', 'arwin')).toBe('No sign-off here');
  });

  it('builds a threaded reply with the chosen signature', () => {
    const mime = buildReplyMime({
      from: 'nick@tiptop.vc',
      to: 'Jane <jane@example.com>',
      cc: '',
      subject: 'Re: Data room',
      inReplyTo: '<abc@mail.example.com>',
      references: '<abc@mail.example.com>',
      body: 'Hi Jane,\n\nSounds good.\n\nBest,\nArwin',
      signatureHtml: '<div>Arwin Reyes</div><div>Executive Assistant, TipTop Ventures</div>',
    });
    expect(mime).toContain('In-Reply-To: <abc@mail.example.com>');
    expect(mime).toContain('From: nick@tiptop.vc');
    expect(mime).not.toMatch(/^Cc:/m);
    const parts = mime.split(/\r\n\r\n/);
    const html = Buffer.from(parts.at(-1)!.split('\r\n')[0]!, 'base64').toString('utf8');
    expect(html).toContain('Executive Assistant, TipTop Ventures');
    expect(html).toContain('<div>Sounds good.</div>');
  });

  it("sends Arwin's real Gmail signature with its links", () => {
    const mime = buildReplyMime({
      from: 'nick@tiptop.vc',
      to: 'jane@example.com',
      cc: '',
      subject: 'Re: Hi',
      inReplyTo: '',
      references: '',
      body: 'Thanks!\n\nBest,\nArwin',
      signatureHtml: ARWIN_SIGNATURE_HTML,
    });
    const parts = mime.split(/\r\n\r\n/);
    const html = Buffer.from(parts.at(-1)!.split('\r\n')[0]!, 'base64').toString('utf8');
    expect(html).toContain('href="https://www.linkedin.com/in/arwin-angelo-reyes-36699b228/"');
    expect(html).toContain('href="http://tiptop.vc/"');
    expect(html).toContain('Executive Assistant to Nick Tippmann');
  });

  it('keeps header injection out', () => {
    const mime = buildReplyMime({
      from: 'nick@tiptop.vc',
      to: 'jane@example.com\r\nBcc: evil@example.com',
      cc: '',
      subject: 'Hi',
      inReplyTo: '',
      references: '',
      body: 'x',
      signatureHtml: null,
    });
    expect(mime).not.toMatch(/^Bcc:/m);
  });

  it('drops the quoted history under a draft', () => {
    expect(
      stripQuoted('Thanks!\n\nOn Tue, Oct 6, 2026 at 9:00 AM Jane <j@x.com> wrote:\n> old'),
    ).toBe('Thanks!');
  });
});
