import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAsks } from '@/lib/company-updates/asks';
import { extractMetrics } from '@/lib/company-updates/metrics';
import { setGmailWaitForTests } from '@/lib/google/gmail-get';
import { resetCompanyUpdatesCache } from '@/lib/services/company-updates';
import {
  BODY_FAIL_CODES,
  gmailAskSources,
  noBodyFailures,
  refreshPortfolioAsks,
  resetPortfolioAsks,
} from '@/lib/services/portfolio-asks';
import { keptText, resetPortfolioNumbersCache } from '@/lib/services/portfolio-numbers';
import { headAndTail, htmlToPlainText, LEFT_OUT_LINE } from '@/lib/util/text';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The asks reader against a mocked, rate-limited Gmail: every matched
 * update's body is read through transient 429s and 5xx, at most two at a
 * time; a body still not read is counted by why in the audit row (codes
 * only, no mail); and a long update keeps its end, where the asks are.
 * Fictional companies, people and mail only: this repository is public.
 */

vi.mock('@/lib/google/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/google/oauth')>()),
  getAccessToken: vi.fn(async () => ({ ok: true, value: 'test-access-value' })),
}));

const NOW = new Date('2026-10-15T15:00:00Z');
const PATH = '/gmail/v1/users/me';

const TOPICS = [
  'dental clinic',
  'regional bank',
  'freight broker',
  'school district',
  'county hospital',
  'credit union',
  'law firm',
  'vineyard',
  'charter airline',
  'ski resort',
  'pet hospital',
  'grocery chain',
  'water utility',
  'film studio',
  'shipyard',
  'botanical garden',
  'rail operator',
  'bakery franchise',
  'climbing gym',
  'opera house',
];

interface Update {
  id: string;
  from: string;
  subject: string;
  at: number;
  body: string;
}

function update(n: number, body?: string): Update {
  const ledgerly = n % 2 === 0;
  const topic = TOPICS[n % TOPICS.length] as string;
  return {
    id: `ab00000000000${String(n).padStart(3, '0')}`,
    from: ledgerly ? 'Maya Chen <maya@ledgerly.demo>' : 'Jonas Reyes <jonas@stonebridgeops.demo>',
    subject: ledgerly
      ? `Ledgerly weekly update, week ${n}`
      : `Stonebridge Ops weekly update, week ${n}`,
    at: NOW.getTime() - (n + 1) * 86_400_000,
    body:
      body ??
      [
        'Hi all,',
        '',
        'A steady week.',
        '',
        'Asks',
        `- Intros to ${topic} buyers`,
        '',
        'Thanks!',
      ].join('\n'),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A recording Gmail over these updates. `thread(id, attempt)` and
 * `meta(id, attempt)` may answer a failure instead (attempt counts from 1);
 * returning nothing serves the message.
 */
function fakeGmail(
  updates: readonly Update[],
  faults: {
    list?: (attempt: number) => Response | undefined;
    meta?: (id: string, attempt: number) => Response | undefined;
    thread?: (id: string, attempt: number) => Response | undefined;
  } = {},
) {
  const byId = new Map(updates.map((u) => [u.id, u]));
  const attempts = new Map<string, number>();
  const tried = (key: string) => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    return n;
  };
  let inFlight = 0;
  let maxThreadsAtOnce = 0;
  const threadReads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const path = url.pathname.slice(PATH.length);
      if (path === '/messages') {
        const fault = faults.list?.(tried('list'));
        if (fault) return fault;
        return json({ messages: updates.map((u) => ({ id: u.id, threadId: u.id })) });
      }
      const meta = /^\/messages\/([^/]+)$/.exec(path);
      if (meta && url.searchParams.get('format') === 'metadata') {
        const id = decodeURIComponent(meta[1] as string);
        const fault = faults.meta?.(id, tried(`meta:${id}`));
        if (fault) return fault;
        const u = byId.get(id);
        if (!u) return json({ error: { code: 404 } }, 404);
        return json({
          id: u.id,
          threadId: u.id,
          labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
          snippet: 'A steady week.',
          internalDate: String(u.at),
          payload: {
            headers: [
              { name: 'From', value: u.from },
              { name: 'To', value: 'nick@tiptop.demo' },
              { name: 'Subject', value: u.subject },
            ],
          },
        });
      }
      const thread = /^\/threads\/([^/]+)$/.exec(path);
      if (thread) {
        const id = thread[1] as string;
        threadReads.push(id);
        inFlight += 1;
        maxThreadsAtOnce = Math.max(maxThreadsAtOnce, inFlight);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const fault = faults.thread?.(id, tried(`thread:${id}`));
          if (fault) return fault;
          const u = byId.get(id);
          if (!u) return json({ error: { code: 404 } }, 404);
          return json({
            id: u.id,
            messages: [
              {
                id: u.id,
                labelIds: ['INBOX'],
                internalDate: String(u.at),
                payload: {
                  mimeType: 'text/plain',
                  headers: [
                    { name: 'From', value: u.from },
                    { name: 'Subject', value: u.subject },
                  ],
                  body: { data: Buffer.from(u.body).toString('base64url') },
                },
              },
            ],
          });
        } finally {
          inFlight -= 1;
        }
      }
      throw new Error(`unexpected Gmail request ${url.pathname}`);
    }),
  );
  return { threadReads, maxThreadsAtOnce: () => maxThreadsAtOnce };
}

describe('the asks reader against a rate-limited Gmail', () => {
  let harness: Harness;
  let waits: number[];

  beforeEach(async () => {
    harness = await createHarness({ now: NOW });
    resetPortfolioAsks();
    resetCompanyUpdatesCache();
    resetPortfolioNumbersCache();
    waits = [];
    setGmailWaitForTests(async (ms) => {
      waits.push(ms);
    });
  });

  afterEach(async () => {
    setGmailWaitForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetPortfolioAsks();
    resetCompanyUpdatesCache();
    resetPortfolioNumbersCache();
    await harness.dispose();
  });

  const auditRows = async () =>
    (
      await harness.store.list('audit_events', harness.auth.organizationId, {
        eq: { action: 'portfolio.asks_read' },
      })
    ).map((e) => (e as { metadata: Record<string, unknown> }).metadata);

  const run = () =>
    refreshPortfolioAsks(harness.store, harness.auth.organizationId, {
      now: () => NOW,
      read: gmailAskSources,
      trigger: 'view',
    });

  it('reads all 20 matched bodies through transient 429s, two at a time', async () => {
    const updates = Array.from({ length: 20 }, (_, n) => update(n));
    const gmail = fakeGmail(updates, {
      list: (attempt) => (attempt === 1 ? json({ error: { code: 429 } }, 429) : undefined),
      // Some headers fail once with a 503 or a 403 rate limit.
      meta: (id, attempt) => {
        if (attempt > 1) return undefined;
        if (id.endsWith('3')) return json({}, 503);
        if (id.endsWith('7')) {
          return json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, 403);
        }
        return undefined;
      },
      // Every body is rate limited at first, some twice, one with Retry-After.
      thread: (id, attempt) => {
        if (attempt === 1) return json({}, 429, id.endsWith('5') ? { 'retry-after': '2' } : {});
        if (attempt === 2 && id.endsWith('0')) return json({}, 429);
        return undefined;
      },
    });

    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 20, asks: 20, added: 20, failed: 0 });
    expect(gmail.maxThreadsAtOnce()).toBeLessThanOrEqual(2);
    // Retry-After was honoured, and the batches were paced.
    expect(waits).toContain(2_000);
    expect(waits.filter((ms) => ms === 250)).toHaveLength(9);

    const [row] = await auditRows();
    expect(row).toMatchObject({
      trigger: 'view',
      state: 'ok',
      messages_listed: 20,
      metadata_read: 20,
      updates_matched: 20,
      emails_scanned: 20,
      bodies_failed: 0,
      body_fail_codes: noBodyFailures(),
      asks_found: 20,
      inserted: 20,
      error: null,
    });
  });

  it('counts each body it could not read by why, with codes only', async () => {
    const updates = Array.from({ length: 12 }, (_, n) => update(n));
    const [gone, deleted, forbidden, limited, broken] = updates.map((u) => u.id);
    fakeGmail(updates, {
      thread: (id) => {
        if (id === gone || id === deleted) return json({ error: { code: 404 } }, 404);
        if (id === forbidden)
          return json({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403);
        if (id === limited) return json({ error: { code: 429 } }, 429);
        if (id === broken) return json({}, 500);
        return undefined;
      },
    });

    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 7, asks: 7, added: 7 });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      updates_matched: 12,
      emails_scanned: 7,
      bodies_failed: 5,
      body_fail_codes: {
        ...noBodyFailures(),
        not_found: 2,
        gmail_4xx: 1,
        rate_limited: 1,
        gmail_5xx: 1,
      },
    });
    expect(Object.keys(row?.body_fail_codes as object).sort()).toEqual([...BODY_FAIL_CODES].sort());
    // No mail in the audit row: no subject, sender or ask.
    const audit = JSON.stringify(row);
    expect(audit).not.toContain('Ledgerly weekly update');
    expect(audit).not.toContain('maya@ledgerly.demo');
    expect(audit).not.toContain('buyers');
  });

  it('stops within its deadline when Gmail keeps rate limiting, counting the rest as deadline', async () => {
    const updates = Array.from({ length: 20 }, (_, n) => update(n));
    fakeGmail(updates, { thread: () => json({}, 429, { 'retry-after': '20' }) });
    const start = Date.now();
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => start + elapsed);
    setGmailWaitForTests(async (ms) => {
      waits.push(ms);
      elapsed += ms;
    });

    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 0, asks: 0 });
    // Two minutes for the read, and one pacing pause past it at most.
    expect(elapsed).toBeLessThanOrEqual(120_000 + 250);
    const [row] = await auditRows();
    const codes = row?.body_fail_codes as Record<string, number>;
    expect(row?.bodies_failed).toBe(20);
    expect(codes.deadline).toBeGreaterThan(0);
    expect((codes.rate_limited ?? 0) + (codes.deadline ?? 0)).toBe(20);
  });

  it('finds the asks at the end of an update longer than the text it keeps', async () => {
    const filler = Array.from(
      { length: 600 },
      (_, i) => `Line ${i}: notes on the pilot with the county clinics went as planned this week.`,
    );
    const body = [
      'Hi all,',
      '',
      'ARR reached $910K this month.',
      '',
      ...filler,
      '',
      'Asks',
      '- Intros to two hospital CFOs in the Midwest',
      '- A Head of Clinical Operations candidate',
      '',
      'Thanks,',
      'Maya',
    ].join('\n');
    expect(body.length).toBeGreaterThan(40_000);
    // Only the start, as before, would lose them.
    expect(extractAsks(body.slice(0, 20_000))).toEqual([]);

    fakeGmail([update(0, body)]);
    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 1, asks: 2, added: 2 });
  });

  it('counts a body that came back with no text as empty, not as read', async () => {
    const updates = Array.from({ length: 6 }, (_, n) => update(n, n < 2 ? '' : undefined));
    fakeGmail(updates);
    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 4, asks: 4 });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      updates_matched: 6,
      emails_scanned: 4,
      bodies_failed: 2,
      body_fail_codes: { ...noBodyFailures(), empty: 2 },
    });
  });

  it('never reads asks from an older update quoted under a long reply', async () => {
    fakeGmail([update(0, longReplyOverQuotedUpdate('outlook'))]);
    const result = await run();
    expect(result).toMatchObject({ state: 'ok', updates: 1, asks: 1, added: 1 });
    const stored = await harness.store.list('portfolio_updates', harness.auth.organizationId, {});
    expect(JSON.stringify(stored)).toContain('Series B leads');
    expect(JSON.stringify(stored)).not.toContain('hospital CFOs');
  });
});

/**
 * A new update longer than the text kept (about 23,000 characters, its ARR
 * near the top and its asks at the end) over the July update it replies to,
 * quoted with no "> " marks: an Outlook plain-text reply, a Gmail HTML reply
 * read as text (its blockquote gone), or that HTML itself in a plain part.
 */
function longReplyOverQuotedUpdate(style: 'outlook' | 'gmail' | 'html'): string {
  const filler = (word: string, n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${word} note ${i}: the rollout with the county clinics went to plan this week.`,
    );
  const latest = [
    'Hi all,',
    '',
    'ARR reached $1.4M this month.',
    '',
    ...filler('October', 340),
    '',
    'Asks',
    '- Intros to Series B leads',
    '',
    'Thanks,',
    'Maya',
  ];
  const july = [
    'Hi all,',
    '',
    'ARR reached $600K this month.',
    '',
    ...filler('July', 100),
    '',
    'Asks',
    '- Intros to hospital CFOs in Ohio',
    '- A VP Engineering candidate',
    '',
    'Thanks,',
    'Maya',
  ];
  if (style === 'outlook') {
    return [
      ...latest,
      '',
      '________________________________',
      'From: Maya Chen <maya@ledgerly.demo>',
      'Sent: Tuesday, July 14, 2026 9:02 AM',
      'To: Nick <nick@tiptop.demo>',
      'Subject: Ledgerly July update',
      '',
      ...july,
    ].join('\n');
  }
  const header = 'On Tue, Jul 14, 2026 at 9:02 AM Maya Chen <maya@ledgerly.demo> wrote:';
  if (style === 'gmail') return [...latest, '', header, '', ...july].join('\n');
  const paras = (lines: string[]) => lines.map((l) => `<p>${l || '&nbsp;'}</p>`).join('');
  return `<div dir="ltr">${paras(latest)}<div class="gmail_quote"><div class="gmail_attr">${header.replace('<', '&lt;').replace('>', '&gt;')}<br></div><blockquote class="gmail_quote">${paras(july)}</blockquote></div></div>`;
}

describe('a long reply keeps its own end, not the update it quotes', () => {
  it.each(['outlook', 'gmail'] as const)(
    'a %s reply: only the new asks, and the new ARR',
    (style) => {
      const text = longReplyOverQuotedUpdate(style);
      // The new update alone is over the limit, so its own middle goes too.
      expect(text.indexOf('ARR reached $600K')).toBeGreaterThan(22_000);
      // Keeping the end alone would read the quoted July asks as this email's own.
      const naive = extractAsks(headAndTail(text, 20_000, 6_000)).map((a) => a.text);
      expect(naive).toContain('Intros to hospital CFOs in Ohio');

      const kept = keptText(text);
      expect(kept).toContain(LEFT_OUT_LINE);
      expect(kept).not.toContain('July note');
      expect(extractAsks(kept).map((a) => a.text)).toEqual(['Intros to Series B leads']);
      expect(extractMetrics(kept, { company: 'Ledgerly' }).revenue).toMatchObject({
        amount: 1_400_000,
        kind: 'ARR',
      });
    },
  );

  it('a Gmail HTML reply, read as text with its blockquote gone', () => {
    const text = htmlToPlainText(longReplyOverQuotedUpdate('html'));
    const kept = keptText(text);
    expect(extractAsks(kept).map((a) => a.text)).toEqual(['Intros to Series B leads']);
    expect(extractMetrics(kept, { company: 'Ledgerly' }).revenue?.amount).toBe(1_400_000);
  });

  it('HTML sent in a plain part is read as text before it is cut', () => {
    const kept = keptText(longReplyOverQuotedUpdate('html'));
    expect(kept).not.toContain('<p>');
    expect(kept).not.toContain('July note');
    expect(extractAsks(kept).map((a) => a.text)).toEqual(['Intros to Series B leads']);
  });

  it('a short message is kept exactly as it is, quoted history and all', () => {
    const short = ['ARR reached $1.4M.', '', 'On Tue, Jul 14 Maya wrote:', '> ARR $600K'].join(
      '\n',
    );
    expect(keptText(short)).toBe(short);
  });

  it('a forward is not cut at the forwarded header', () => {
    const forward = [
      ...Array.from({ length: 450 }, (_, i) => `Intro line ${i}, kept in full to pass the limit.`),
      '---------- Forwarded message ---------',
      'From: Maya Chen <maya@ledgerly.demo>',
      'Date: Tue, Jul 14, 2026 at 9:02 AM',
      '',
      'Asks',
      '- Intros to Series B leads',
    ].join('\n');
    expect(forward.length).toBeGreaterThan(20_000);
    expect(keptText(forward)).toContain('- Intros to Series B leads');
  });
});

describe('a long text keeps its start and its end', () => {
  const lines = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix} line ${i} of the update, written in full.`);

  it('keeps the head and the tail around one marker line, cut at line ends', () => {
    const text = ['ARR reached $910K this month.', ...lines('Middle', 1_000)].join('\n');
    const kept = headAndTail(text, 20_000, 6_000);
    expect(kept.length).toBeLessThanOrEqual(20_000 + LEFT_OUT_LINE.length + 4);
    expect(kept.startsWith('ARR reached $910K this month.')).toBe(true);
    expect(kept.endsWith('Middle line 999 of the update, written in full.')).toBe(true);
    expect(kept.split(LEFT_OUT_LINE)).toHaveLength(2);
    const [head = '', tail = ''] = kept.split(`\n\n${LEFT_OUT_LINE}\n\n`);
    // Whole lines on both sides of the cut.
    expect(
      head
        .split('\n')
        .every((l) => l === 'ARR reached $910K this month.' || /written in full\.$/.test(l)),
    ).toBe(true);
    expect(
      tail.split('\n').every((l) => /^Middle line \d+ of the update, written in full\.$/.test(l)),
    ).toBe(true);
    // A text within the limit is left as it is.
    expect(headAndTail('Short update.', 20_000, 6_000)).toBe('Short update.');
  });

  it('the numbers in the head still read', () => {
    const text = ['ARR reached $910K this month.', ...lines('Middle', 1_000)].join('\n');
    const kept = headAndTail(text, 20_000, 6_000);
    expect(extractMetrics(kept, { company: 'Ledgerly' }).revenue).toMatchObject({
      amount: 910_000,
      kind: 'ARR',
    });
  });

  it('the marker is never part of an ask, and no section runs across it', () => {
    // The asks heading and its first item fall just before the cut.
    const head = ['Hi all,', '', ...lines('Early', 270), '', 'Asks', '- Intros to two seed funds'];
    const tail = [...lines('Late', 120), '', 'Thanks,', 'Maya'];
    const text = [...head, ...lines('Middle', 400), ...tail].join('\n');
    const kept = headAndTail(text, 20_000, 6_000);
    expect(kept).toContain('- Intros to two seed funds');
    expect(kept).toContain(LEFT_OUT_LINE);
    const asks = extractAsks(kept);
    expect(asks.map((a) => a.text)).toEqual(['Intros to two seed funds']);
    expect(JSON.stringify(asks)).not.toContain('left out');
    expect(JSON.stringify(asks)).not.toContain('Late line');

    // A marker inside a list ends the list there.
    const listed = extractAsks(
      ['Asks', '- Intros to two seed funds', '', LEFT_OUT_LINE, '', '- A design partner'].join(
        '\n',
      ),
    );
    expect(listed.map((a) => a.text)).toEqual(['Intros to two seed funds']);
  });

  it('an HTML body is read as text on each side of the cut', () => {
    const html = `<p>Hi all,</p><p>${'Filler. '.repeat(10)}</p>\n\n${LEFT_OUT_LINE}\n\n<p><b>Asks</b></p><ul><li>Intros to two seed funds</li><li>A design partner</li></ul>`;
    expect(extractAsks(html).map((a) => a.text)).toEqual([
      'Intros to two seed funds',
      'A design partner',
    ]);
  });
});
