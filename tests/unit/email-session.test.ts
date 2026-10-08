import { describe, expect, it } from 'vitest';
import {
  buildSession,
  groupFromLabels,
  isSettled,
  sessionSummary,
  type LiveInbox,
  type SessionAnswer,
} from '@/lib/services/email-session';
import { displayName } from '@/lib/google/gmail-inbox';
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
    expect(snap.emailQueue?.items.map((i) => i.who).sort()).toEqual(['A', 'B']);
  });

  it('accumulates judgments across posts, newest per email wins, with its time', () => {
    const snap = collectFollowUps([
      {
        ts: '1791400100.000100',
        user: 'U1',
        text: post({
          run_at: '2026-10-08T12:00:00Z',
          items: [queueItem('aa00000000000001', 'deals', 'A', 'Changed since')],
        }),
      },
      {
        ts: '1791400000.000100',
        user: 'U1',
        text: post({
          run_at: '2026-10-08T11:00:00Z',
          items: [
            queueItem('aa00000000000001', 'replies', 'A', 'Old take'),
            queueItem('aa00000000000002', 'money', 'B'),
          ],
        }),
      },
    ]);
    const byId = new Map(snap.emailQueue?.items.map((i) => [i.id, i]));
    expect(byId.get('aa00000000000001')?.group).toBe('deals');
    expect(byId.size).toBe(2);
    expect(snap.emailJudgedAt['aa00000000000001']).toBe(new Date(1791400100000).toISOString());
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
    // Quick replies are Nick's too; only "nothing to answer" leaves his queue.
    expect(s.items.filter((i) => i.needsNick).map((i) => i.who)).toEqual([
      'Dana',
      'Ledgerly',
      'Tom',
      'Maya',
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

  it('follows the live inbox: answered/archived emails drop, new ones appear', () => {
    const labels = new Map([
      ['L1', '@Do ASAP'],
      ['L2', '@Ready to Archive'],
    ]);
    const inbox: LiveInbox = {
      // Dana and Ledgerly still in the inbox; Tom, Maya, Event Hub left it.
      ids: new Set([
        'aa00000000000001',
        'aa00000000000002',
        'cc00000000000001',
        'cc00000000000002',
      ]),
      meta: new Map([
        [
          'cc00000000000001',
          {
            id: 'cc00000000000001',
            who: 'New Founder',
            subject: 'Quick question',
            labelIds: ['INBOX'],
            latestAt: '2026-10-08T14:00:00Z',
            lastFromUs: false,
          },
        ],
        [
          'cc00000000000002',
          {
            id: 'cc00000000000002',
            who: 'Promo',
            subject: 'Sale',
            labelIds: ['INBOX', 'L2'],
            latestAt: '2026-10-08T14:00:00Z',
            lastFromUs: false,
          },
        ],
      ]),
      otherIds: new Set(),
      labelNames: labels,
    };
    const s = buildSession({
      snapshot: snapshotWith(items),
      answers: new Map(),
      deals: [],
      portfolio: [],
      now: NOW,
      inbox,
    });
    expect(s.items.map((i) => i.who)).toEqual(['Dana', 'Ledgerly', 'New Founder', 'Promo']);
    const fresh = s.items.find((i) => i.who === 'New Founder');
    expect(fresh?.group).toBe('new');
    expect(fresh?.needsNick).toBe(true);
    expect(s.items.find((i) => i.who === 'Promo')?.needsNick).toBe(false);
  });

  it('outside the Primary tab, shows only urgent emails', () => {
    const snap = snapshotWith([
      queueItem('dd00000000000001', 'money', 'Billing', 'Invoice past due'),
      queueItem('dd00000000000002', 'replies', 'Newsletter guy', 'Thoughts?'),
      queueItem('dd00000000000003', 'archive', 'Promo', 'Sale'),
    ]);
    const inbox: LiveInbox = {
      ids: new Set(),
      otherIds: new Set(['dd00000000000001', 'dd00000000000002', 'dd00000000000003']),
      meta: new Map(),
      labelNames: new Map(),
    };
    const s = buildSession({
      snapshot: snap,
      answers: new Map(),
      deals: [],
      portfolio: [],
      now: NOW,
      inbox,
    });
    expect(s.items.map((i) => i.who)).toEqual(['Billing']);
  });

  it('sorts unjudged emails by the triage labels', () => {
    const names = new Map([
      ['a', '@Do ASAP'],
      ['b', '@Deals to Review'],
      ['c', '@For Arwin'],
      ['d', '@Low Prio'],
    ]);
    const g = (labelIds: string[], lastFromUs = false) =>
      groupFromLabels({ labelIds, lastFromUs }, names);
    expect(g(['a'])).toBe('today');
    expect(g(['b'])).toBe('deals');
    expect(g(['c'])).toBe('replies');
    expect(g(['d'])).toBe('archive');
    expect(g(['CATEGORY_PROMOTIONS'])).toBe('archive');
    expect(g(['INBOX'])).toBe('new');
    expect(g(['a'], true)).toBe('archive');
  });

  it('drops an answer once the email changed and was judged again', () => {
    const snap = snapshotWith(items);
    const judged = snap.emailJudgedAt['aa00000000000001']!;
    const before = new Date(Date.parse(judged) - 60_000).toISOString();
    const answers = new Map<string, SessionAnswer>([
      [
        'aa00000000000001',
        { answer: 'sent', note: null, signature: 'nick', viaApp: true, at: before, by: 'Nick' },
      ],
    ]);
    const s = buildSession({ snapshot: snap, answers, deals: [], portfolio: [], now: NOW });
    expect(s.items.find((i) => i.id === 'aa00000000000001')?.answer).toBeNull();
  });

  it('reads a display name from a From header', () => {
    expect(displayName('"Jane Doe" <jane@x.com>')).toBe('Jane Doe');
    expect(displayName('Jane Doe <jane@x.com>')).toBe('Jane Doe');
    expect(displayName('jane@x.com')).toBe('jane');
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
