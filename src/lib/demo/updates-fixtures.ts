import type { SlackMessage, UpdateSource } from '@/lib/updates/types';

/**
 * Demo and test data for the Updates tab: a fake Slack workspace.
 *
 * Every name, company, address, id and link in this file is invented. The
 * repository is public — never paste real Slack text here, even to reproduce
 * a parsing bug; write an invented message with the same shape instead.
 *
 * Times are relative to `now` and always at least an hour old, so the demo
 * never shows a report as still posting.
 */

export const DEMO_UPDATE_SOURCES: readonly UpdateSource[] = [
  {
    key: 'harbor',
    group: 'dealflow',
    label: 'Harbor Angels',
    channelId: 'CDEMO0000H1',
    channelName: 'harbor-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'rocket',
  },
  {
    key: 'pitchline',
    group: 'dealflow',
    label: 'Pitchline',
    channelId: 'CDEMO0000P1',
    channelName: 'pitchline-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'radar',
  },
  {
    key: 'scout',
    group: 'dealflow',
    label: 'Scout Desk',
    channelId: 'CDEMO0000S1',
    channelName: 'scout-desk-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'handshake',
  },
  {
    key: 'syndicate',
    group: 'dealflow',
    label: 'Syndicate Inbox',
    channelId: 'CDEMO0000Y1',
    channelName: 'syndicate-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'rocket',
  },
  {
    key: 'digest',
    group: 'digest',
    label: 'Update Digest',
    channelId: 'CDEMO0000D1',
    channelName: 'update-digest',
    cadence: 'Mon & Fri · month start/end',
    staleAfterDays: 5,
    icon: 'mailbox',
  },
];

const HARBOR = 'CDEMO0000H1';
const PITCHLINE = 'CDEMO0000P1';
const SCOUT = 'CDEMO0000S1';
const SYNDICATE = 'CDEMO0000Y1';
const DIGEST = 'CDEMO0000D1';

const EA = 'U0DEMOEA001';
const GP = 'U0DEMOGP001';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface DemoSlack {
  history: Record<string, SlackMessage[]>;
  replies: Record<string, SlackMessage[]>;
  errors: Record<string, string>;
}

/** The most recent instant on one of `weekdays` (UTC) at hh:mm, at least an hour before now. */
function lastSlot(now: Date, weekdays: number[], hour: number, minute: number): number {
  const limit = now.getTime() - HOUR;
  const d = new Date(limit);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  for (let i = 0; i < 9; i++) {
    if (weekdays.includes(new Date(t).getUTCDay()) && t <= limit) return t;
    t -= DAY;
  }
  return t;
}

function ts(ms: number, n = 100): string {
  return `${Math.floor(ms / 1000)}.${String(n).padStart(6, '0')}`;
}

function fmt(ms: number, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(ms);
}
const longDate = (ms: number) =>
  fmt(ms, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = (ms: number) => fmt(ms, { month: 'short', day: 'numeric' });
const year = (ms: number) => fmt(ms, { year: 'numeric' });
function range(start: number, end: number): string {
  const sameMonth = fmt(start, { month: 'short' }) === fmt(end, { month: 'short' });
  const tail = sameMonth ? fmt(end, { day: 'numeric' }) : shortDate(end);
  return `${shortDate(start)}–${tail}, ${year(end)}`;
}

const lines = (...parts: string[]) => parts.join('\n');
const gmail = (id: string) =>
  `<https://mail.google.com/mail/?authuser=demo@example.com#all/${id}|Open in Gmail>`;

function post(at: number, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { ts: ts(at), user: EA, text, ...extra };
}

function thread(parent: SlackMessage, replies: { at: number; text: string; user?: string }[]) {
  const messages = replies.map((r, i) => ({
    ts: ts(r.at, 200 + i),
    user: r.user ?? EA,
    text: r.text,
    thread_ts: parent.ts,
  }));
  parent.reply_count = messages.length;
  parent.latest_reply = messages[messages.length - 1]?.ts;
  return [{ ...parent, thread_ts: parent.ts }, ...messages];
}

export function buildDemoSlack(now: Date): DemoSlack {
  const replies: Record<string, SlackMessage[]> = {};
  const addThread = (
    channel: string,
    parent: SlackMessage,
    items: { at: number; text: string; user?: string }[],
  ) => {
    replies[`${channel}:${parent.ts}`] = thread(parent, items);
  };

  /* ---------------------------------------------- Harbor Angels (thread) */
  const h0 = lastSlot(now, [5], 12, 5);
  const harborLatest = post(
    h0,
    lines(
      `_Harbor Angels Deal Flow — Weekly Update | ${range(h0 - WEEK, h0)}_`,
      '',
      '3 new deals surfaced this week (climate hardware 1, digital health 1, legal software 1) — no overlap with prior reports. No material updates on anything reported earlier. Fastest-moving: the Fernway Health round, which closes next Thursday.',
      '_(New deals, deadlines &amp; risks in thread below_ :thread:_)_',
      '*Sent using* Claude',
    ),
  );
  addThread(HARBOR, harborLatest, [
    {
      at: h0 + 9_000,
      text: lines(
        '_New Deals (Not Previously Reported)_',
        '1. _Lumen Grid Robotics_ — Direct SAFE, $1.5M at a $12M cap. Inspection robots for electrical substations.',
        '◦ 4 utilities on paid pilots; $310K ARR.',
        '◦ Second-time founders (prior exit to an industrial OEM).',
        '2. _Fernway Health_ — Priced seed, $3M at $14M pre. Remote physio programmes for employers.',
        '◦ 22 employer contracts; 118% net revenue retention.',
        '◦ Founder contact: <mailto:founder@fernway.example|founder@fernway.example>',
        '*Sent using* Claude',
      ),
    },
    {
      at: h0 + 19_000,
      text: lines(
        "New Deals (cont'd)",
        '3. _Quillmark Labs_ — SAFE, $900K at an $8M cap. Contract-review assistant for small law firms.',
        '◦ 40 paying firms; six-week median sales cycle.',
        '',
        '_Upcoming Deadlines &amp; Meetings_',
        '• Thu — Fernway Health round closes (allocation requests by Wednesday)',
        '• Tue — Lumen Grid Robotics founder call; agenda at <javascript:alert(1)|Unsafe link>',
        '_Sent using_ Claude',
        '*Sent using* Claude',
      ),
    },
    {
      at: h0 + 45 * MINUTE,
      user: GP,
      text: "Let's pass on Quillmark for now. Can you ask Fernway for the data room before Wednesday?",
    },
  ]);
  const harborEarlier = post(
    h0 - WEEK,
    lines(
      `_Harbor Angels Deal Flow — Weekly Update | ${range(h0 - 2 * WEEK, h0 - WEEK)}_`,
      '',
      '_Executive Summary_',
      '• 2 new deals this week — both B2B, no overlap with prior reports.',
      '• No material updates on earlier deals.',
      '',
      '_New Deals (Not Previously Reported)_',
      '1. _Brightkettle Foods_ — Convertible note, $600K. Shelf-stable broths for grocery chains. → Next: request the deck.',
      '2. _Tallow Data_ — SAFE, $1.2M at a $10M cap. Warehouse energy analytics. → Next: book a founder call.',
      '',
      '_Action Items_',
      '• Request the deck — Brightkettle Foods',
      '• Book a founder call — Tallow Data',
      '_Risks / Watch List_',
      '• Brightkettle Foods — revenue figures are self-reported.',
      '*Sent using* Claude',
    ),
  );

  /* ------------------------------------------------ Pitchline (sections) */
  const p0 = lastSlot(now, [5], 12, 7);
  const pitchlineLatest = post(
    p0,
    lines(
      'PITCHLINE DEALFLOW — WEEKLY REPORT',
      `Review window: Fri ${shortDate(p0 - WEEK)} 12:01 AM – Fri ${shortDate(p0)} 12:00 AM, ${year(p0)}`,
      `Baseline: Prior report dated ${shortDate(p0 - WEEK)}. Deduplicated against it and all earlier reports.`,
      '',
      '=== EXECUTIVE SUMMARY ===',
      '• 2 net-new inbound deals this cycle: Orbitline Freight (freight-audit software) and Saltbloom (seaweed packaging).',
      '• Best thesis fit: Orbitline Freight — B2B software with paying customers.',
      '• One deal is marked confidential — see its entry.',
      '=== NEW DEALS (NOT PREVIOUSLY REPORTED) ===',
      '',
      '1. ORBITLINE FREIGHT — <mailto:deals@pitchline.example|deals@pitchline.example> / Casey Morrow, Founder &amp; CEO',
      '• Deal Type: Seed, raising $2M. Freight-invoice auditing for mid-size shippers.',
      '• Key Highlights:',
      '◦ $240K ARR across 31 shippers.',
      '◦ Recovers 3.1% of freight spend on average.',
      '• Required Next Steps: Review the <https://decks.example/pitch/123|Deck>; open a fit call or decline.',
      '2. SALTBLOOM — <mailto:deals@pitchline.example|deals@pitchline.example> / Priya Venn, Founder',
      '• Deal Type: Pre-seed, raising $650K. Seaweed-based food packaging.',
      '• CONFIDENTIAL — do not forward: the founder shared lab data under NDA.',
      '=== MATERIAL UPDATES TO PREVIOUSLY REPORTED DEALS ===',
      '• None. No developments on earlier deals this cycle.',
      '=== ACTION ITEMS ===',
      '• Review the deck and reply. Owner: GP. Due: next Friday. Related: Orbitline Freight.',
      '=== UPCOMING DEADLINES &amp; MEETINGS ===',
      '• Wed — Saltbloom intro call, 10:00 AM CT.',
      '=== RISKS / WATCH LIST ===',
      '• Saltbloom — lab results are unaudited.',
      '=== WHAT IS NEW SINCE PREVIOUS REPORT ===',
      '• Two new deals after a quiet week.',
      '_Sent using_ Claude',
      '*Sent using* Claude',
    ),
  );
  const pitchlineEarlier = post(
    p0 - WEEK,
    lines(
      'PITCHLINE DEALFLOW — WEEKLY REPORT',
      `Review window: Fri ${shortDate(p0 - 2 * WEEK)} 12:01 AM – Fri ${shortDate(p0 - WEEK)} 12:00 AM, ${year(p0)}`,
      `Baseline: Prior report dated ${shortDate(p0 - 2 * WEEK)}. Deduplicated against it.`,
      '',
      '=== EXECUTIVE SUMMARY ===',
      '• No net-new inbound deals this cycle.',
      '• One earlier lead, Juniper Row Studio, has gone quiet since its intro call.',
      '=== NEW DEALS (NOT PREVIOUSLY REPORTED) ===',
      '• None. Every in-window email was already reported.',
      '=== MATERIAL UPDATES TO PREVIOUSLY REPORTED DEALS ===',
      '• None.',
      '=== ACTION ITEMS ===',
      '• Send a short check-in to Juniper Row Studio. Owner: EA. Due: Tuesday.',
      '=== UPCOMING DEADLINES &amp; MEETINGS ===',
      '• No scheduled meetings or hard deadlines this cycle.',
      '=== RISKS / WATCH LIST ===',
      '• No new risks this cycle.',
      '=== WHAT IS NEW SINCE PREVIOUS REPORT ===',
      '• A quiet week — no new deals.',
      '*Sent using* Claude',
    ),
  );

  /* ---------------------------------------------------- Scout Desk (ruled) */
  const s0 = lastSlot(now, [5], 12, 9);
  const rule = '========================================';
  const scoutLatest = post(
    s0,
    lines(
      'SCOUT DESK — WEEKLY DEAL-FLOW UPDATE (INCREMENTAL)',
      `Window: Fri ${shortDate(s0 - WEEK)} 12:01 AM – Fri ${shortDate(s0)} 12:00 AM (CT)`,
      `Baseline: prior incremental report posted ${shortDate(s0 - WEEK)}. Only net-new or changed items below.`,
      '',
      rule,
      'EXECUTIVE SUMMARY',
      '• 2 new company pitches this week: Tidelock Marine and Wrenfield Labs.',
      '• Imminent: the Tidelock Marine pitch/Q&amp;A on Tuesday at 11:00 AM CT.',
      rule,
      'NEW DEALS (NOT PREVIOUSLY REPORTED)',
      '1. TIDELOCK MARINE',
      '• Type: Company pitch. Hull-cleaning robots for commercial ports.',
      '• Highlights: 3 port pilots; raising $1.8M.',
      '• Next steps: attend the pitch on Tuesday; review the deck.',
      '2. WRENFIELD LABS',
      '• Type: Company pitch. Lab-inventory software for biotech startups.',
      '• Highlights: $180K ARR; 60 labs live.',
      '• Next steps: request the data room.',
      rule,
      'MATERIAL UPDATES TO PREVIOUSLY REPORTED DEALS',
      '• None. No new developments on earlier deals.',
      rule,
      'ACTION ITEMS',
      '• Confirm attendance for the Tidelock Marine pitch. Due: Monday.',
      rule,
      'UPCOMING DEADLINES &amp;amp; MEETINGS',
      '• Tue 11:00 AM CT — Tidelock Marine pitch/Q&amp;A',
      rule,
      'RISKS / WATCH LIST',
      '• Wrenfield Labs — single-founder company.',
      rule,
      "WHAT'S NEW vs. LAST REPORT: two new pitches; nothing changed on earlier deals.",
      '*Sent using* Claude',
    ),
  );
  const scoutEarlier = post(
    s0 - WEEK,
    lines(
      'SCOUT DESK — WEEKLY DEAL-FLOW UPDATE',
      `Window: Fri ${shortDate(s0 - 2 * WEEK)} 12:01 AM – Fri ${shortDate(s0 - WEEK)} 12:00 AM (CT)`,
      'Note: This is the first report for this channel — all items below are net-new (baseline).',
      '',
      rule,
      'EXECUTIVE SUMMARY',
      '• 1 company pitch shared by the partner: Emberwick Energy.',
      rule,
      'NEW DEALS (NOT PREVIOUSLY REPORTED)',
      '1. EMBERWICK ENERGY',
      '• Type: Company pitch. Heat-pump retrofits for small offices.',
      '• Highlights: 14 installs; raising $1M.',
      rule,
      'MATERIAL UPDATES TO PREVIOUSLY REPORTED DEALS',
      '• None. This is the baseline report.',
      '*Sent using* Claude',
    ),
  );
  const scoutChatter = { ts: ts(s0 + 30 * MINUTE, 300), user: GP, text: 'Nice!' };
  const scoutJoin = {
    ts: ts(s0 - 3 * WEEK, 400),
    user: GP,
    subtype: 'channel_join',
    text: `<@${GP}> has joined the channel`,
  };

  /* ------------------------------------------------------- Update Digest */
  const d0 = lastSlot(now, [1, 5], 13, 35);
  const weekly = post(
    d0,
    lines(
      `:mailbox_with_mail: Weekly digest — ${longDate(d0)} — covering ${shortDate(d0 - 4 * DAY)} – ${shortDate(d0)}, ${year(d0)}`,
      '3 updates (3 weekly / 0 monthly)',
      '',
      'Running on _ROSTER v2_. Each update is a threaded reply below, weekly first.',
      '',
      'Three things worth your attention:',
      '• _Cobalt Orchard_ needs a signed board consent before its next close.',
      '• _Fieldnote Analytics_ grew revenue 9% month over month and hired a CFO.',
      '• _Brassfinch Weekly_ reports a slower seed market for hardware.',
      '_No issue this period from:_ Juniper Row Studio (monthly, next due in two weeks).',
      '*Sent using* Claude',
    ),
  );
  addThread(DIGEST, weekly, [
    {
      at: d0 + 9_000,
      text: lines(
        '── _Fieldnote Analytics — Weekly Founder Note_ (weekly)',
        `From: Avery Lin <mailto:avery@fieldnote.example> | Subject: "Weekly note" | Received: ${longDate(d0 - DAY)}`,
        `Period: week of ${shortDate(d0 - 7 * DAY)}`,
        '',
        'Key takeaways:',
        '• Revenue up 9% month over month; a CFO starts next week.',
        '• Two enterprise pilots converted to annual contracts.',
        'Metrics: $84K MRR; 61 customers; no churn this month',
        // The broken form a routine sometimes posts: a line break inside the link.
        'Link: <https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000001',
        'Ledger|mail.google.com/mail?authuser=demo@example.com#…>: 0f00000000000001',
        '',
        '── ✲ _Brassfinch Weekly_ (weekly, Fridays)',
        `From: Brassfinch <mailto:hello@brassfinch.example> | Subject: "Hardware seed check-in" | Received: ${longDate(d0 - 2 * DAY)}`,
        `Period: week of ${shortDate(d0 - 7 * DAY)}`,
        '',
        'Ledger: 0f00000000000002',
        '',
        '_Key takeaways:_',
        '• Hardware seed rounds took 30% longer to close this quarter.',
        '• Two robotics funds announced new vehicles.',
        `Link: ${gmail('0f00000000000002')}`,
        '*Sent using* Claude',
      ),
    },
    {
      at: d0 + 19_000,
      text: lines(
        '── _Cobalt Orchard — Investor Update_ (weekly) :lock: _sender marks this investors-only: "for our investors, not for circulation"_',
        `From: Mara Quist <mailto:ceo@cobaltorchard.example> | Subject: "Cobalt Orchard weekly" | Received: ${longDate(d0 - DAY)}`,
        `Period: week of ${shortDate(d0 - 7 * DAY)}`,
        '',
        'Ledger: 0f00000000000003',
        '',
        '_Key takeaways:_',
        '• Wholesale orders up 14% week over week.',
        '_Decisions/changes:_',
        '• Moving the next close to the end of the month.',
        ':warning: _Needs attention:_',
        '• Board consent due Thursday — two more investor signatures are needed.',
        '',
        `Link: ${gmail('0f00000000000003')}`,
        '*Sent using* Claude',
      ),
    },
    {
      at: d0 + 29_000,
      text: lines(
        '──────────',
        '_Candidate series noticed_ — not summarized above. Reply "add Harborview Notes" to include it from the next run.',
        '1. _Harborview Notes — "Monthly Harbor"_ — <mailto:notes@harborview.example>. A monthly roundup of climate-hardware rounds.',
        '• Seen twice, 30 days apart — the minimum for a monthly series.',
        '_Roster housekeeping (no action taken — runs never edit the roster):_',
        '• _Juniper Row Studio_ — next issue due in two weeks.',
        '*Sent using* Claude',
      ),
    },
    { at: d0 + 40 * MINUTE, text: 'stop including Northwind Weekly', user: GP },
  ]);

  const monthEnd = post(
    d0 - WEEK,
    lines(
      `:mailbox_with_mail: Month-end digest — ${longDate(d0 - WEEK)} — covering the past month`,
      '1 update (0 weekly / 1 monthly)',
      '',
      '── _Juniper Row Studio — Monthly Update_ (monthly)',
      `From: Sol Ferreira <mailto:studio@juniperrow.example> | Subject: "Monthly update" | Received: ${longDate(d0 - WEEK - 3 * DAY)}`,
      'Period: last month',
      '',
      'Ledger: 0f00000000000004',
      '',
      'Key takeaways:',
      '• Shipped the second season of its mobile game; 40K new players.',
      'Metrics: Revenue $52K (+6% MoM); runway 16 months.',
      `Link: ${gmail('0f00000000000004')}`,
      '*Sent using* Claude',
    ),
  );
  const monthStart = post(
    d0 - 2 * WEEK,
    lines(
      `:mailbox_with_mail: Month-start digest — ${longDate(d0 - 2 * WEEK)} — No monthly updates received for last month.`,
      '*Sent using* Claude',
    ),
  );
  const supplemental = post(
    d0 - 2 * WEEK - 2 * DAY,
    lines(
      `:mailbox_with_mail: Supplemental digest — ${longDate(d0 - 2 * WEEK - 2 * DAY)} — covering issues the first sweep missed`,
      '1 update (0 weekly / 1 monthly)',
      '',
      'This is the monthly series a full-mailbox check added to ROSTER v2. Its summary is a threaded reply below. One is time-sensitive: *Gullwing Bikes has $120K left in a SAFE that closes at the end of the month.*',
      '*Sent using* Claude',
    ),
  );
  addThread(DIGEST, supplemental, [
    {
      at: d0 - 2 * WEEK - 2 * DAY + 9_000,
      text: lines(
        '── _Gullwing Bikes — Monthly Update_ (monthly)',
        `From: Rae Okafor <mailto:rae@gullwing.example> | Subject: "Update | August" | Received: ${longDate(d0 - 2 * WEEK - 3 * DAY)}`,
        'Period: last month',
        '',
        'Ledger: 0f00000000000005',
        '',
        ':white_check_mark: _The series has resumed_ — the first update since June.',
        '',
        '_Metrics — last month, as reported:_',
        '• 310 bikes sold; gross margin 31%',
        '',
        `Link: ${gmail('0f00000000000005')}`,
        '*Sent using* Claude',
      ),
    },
  ]);
  const rosterV2 = post(
    d0 - 3 * WEEK,
    lines(
      ':clipboard: *ROSTER v2* — supersedes the earlier roster',
      '*Baseline:* already-posted issues are skipped; nothing older than 45 days.',
      '',
      '*WEEKLY (3)*',
      '1. Fieldnote Analytics — Weekly Founder Note — <mailto:avery@fieldnote.example>',
      '2. Cobalt Orchard — Investor Update — <mailto:ceo@cobaltorchard.example> :lock: investors-only, never forward',
      '3. ✲ Brassfinch Weekly — <mailto:hello@brassfinch.example> (Fridays)',
      '*MONTHLY (1)*',
      '4. Juniper Row Studio — <mailto:studio@juniperrow.example>',
      '',
      '*ALSO INCLUDED (1)*',
      '5. Deckwatch "weekly viewer digest" — <mailto:no-reply@deckwatch.example>',
      '',
      '_Corrections: reply "stop including X" or "add Y" in this thread._',
      '*Sent using* Claude',
    ),
  );
  addThread(DIGEST, rosterV2, [
    {
      at: d0 - 3 * WEEK + 15_000,
      text: lines(
        '*ROSTER v2 — appendix* (runs read this thread as part of the roster)',
        '',
        '*EXCLUDED BY CONTENT JUDGMENT* (each judged promotional rather than informative):',
        '• *Linkheap Daily* — bare link lists, no readable substance',
        '*WATCH LIST:* Harborview Notes (<mailto:notes@harborview.example>)',
        '*Sent using* Claude',
      ),
    },
  ]);
  const rosterV1 = post(
    d0 - 4 * WEEK,
    lines(
      ':clipboard: *ROSTER v1* — confirmed recurring update series',
      '',
      '*WEEKLY*',
      '1. Fieldnote Analytics — Weekly Founder Note — <mailto:avery@fieldnote.example>',
      '*MONTHLY*',
      '2. Juniper Row Studio — <mailto:studio@juniperrow.example>',
      '*Sent using* Claude',
    ),
  );
  const digestJoin = {
    ts: ts(d0 - 5 * WEEK, 400),
    user: EA,
    subtype: 'channel_join',
    text: `<@${EA}> has joined the channel`,
  };

  const newestFirst = (messages: SlackMessage[]) =>
    [...messages].sort((a, b) => Number(b.ts) - Number(a.ts));

  return {
    history: {
      [HARBOR]: newestFirst([harborLatest, harborEarlier]),
      [PITCHLINE]: newestFirst([pitchlineLatest, pitchlineEarlier]),
      [SCOUT]: newestFirst([scoutLatest, scoutEarlier, scoutChatter, scoutJoin]),
      [DIGEST]: newestFirst([
        weekly,
        monthEnd,
        monthStart,
        supplemental,
        rosterV2,
        rosterV1,
        digestJoin,
      ]),
    },
    replies,
    errors: { [SYNDICATE]: 'channel_not_found' },
  };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A stand-in for Slack's Web API over the demo workspace. Never touches the network. */
export function createDemoSlackFetch(now: Date): typeof fetch {
  const slack = buildDemoSlack(now);
  return async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = url.pathname.replace(/^\/api\//, '');
    if (method === 'auth.test') {
      return json(
        {
          ok: true,
          url: 'https://demo-workspace.slack.com/',
          user: 'copilot_demo_bot',
          user_id: 'U0DEMOBOT01',
        },
        { 'x-oauth-scopes': 'channels:history,groups:history' },
      );
    }
    const channel = url.searchParams.get('channel') ?? '';
    const error = slack.errors[channel];
    if (error) return json({ ok: false, error });
    const page = (messages: SlackMessage[]) =>
      json({ ok: true, messages, has_more: false, response_metadata: { next_cursor: '' } });
    if (method === 'conversations.history') {
      const messages = slack.history[channel];
      return messages ? page(messages) : json({ ok: false, error: 'channel_not_found' });
    }
    if (method === 'conversations.replies') {
      const messages = slack.replies[`${channel}:${url.searchParams.get('ts') ?? ''}`];
      return messages ? page(messages) : json({ ok: false, error: 'thread_not_found' });
    }
    return json({ ok: false, error: 'unknown_method' });
  };
}
