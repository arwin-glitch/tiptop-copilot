import { describe, expect, it } from 'vitest';
import { buildDemoSlack } from '@/lib/demo/updates-fixtures';
import { classifyDigestReply, classifyTopLevel, SYSTEM_SUBTYPES } from '@/lib/updates/classify';
import { parseDealflowReport, type DealflowFormat } from '@/lib/updates/dealflow';
import { parseDigestItem, parseDigestRun, parseRoster } from '@/lib/updates/digest';
import { blockSegs, segText } from '@/lib/updates/mrkdwn';
import type { Block, DigestItem, Seg, SlackMessage } from '@/lib/updates/types';

/**
 * The classifier and the three parsers, over the invented demo workspace and
 * inline invented strings. Real Slack text is never used here.
 */

const FIXED_NOW = new Date('2026-09-23T15:00:00Z');
const demo = buildDemoSlack(FIXED_NOW);
const HARBOR = 'CDEMO0000H1';
const PITCHLINE = 'CDEMO0000P1';
const SCOUT = 'CDEMO0000S1';
const DIGEST = 'CDEMO0000D1';

function history(channel: string): SlackMessage[] {
  return demo.history[channel] ?? [];
}

function replyTexts(channel: string, msg: SlackMessage): { ts: string; text: string }[] {
  return (demo.replies[`${channel}:${msg.ts}`] ?? [])
    .filter((m) => m.ts !== msg.ts)
    .map((m) => ({ ts: m.ts, text: m.text ?? '' }));
}

function dealflow(channel: string, index: number) {
  const msg = history(channel).filter((m) => classifyTopLevel(m).kind === 'dealflow')[index];
  if (!msg) throw new Error('no such report');
  const cls = classifyTopLevel(msg);
  const format = (cls.kind === 'dealflow' ? cls.format : 'G') as DealflowFormat;
  return parseDealflowReport(
    format,
    msg.text ?? '',
    replyTexts(channel, msg).map((r) => r.text),
  );
}

function digestRun(index: number) {
  const msg = history(DIGEST).filter((m) => classifyTopLevel(m).kind === 'digest')[index];
  if (!msg) throw new Error('no such run');
  return parseDigestRun(msg.text ?? '', replyTexts(DIGEST, msg));
}

function itemSegs(item: DigestItem): Seg[] {
  return item.groups.flatMap((g) => blockSegs(g.blocks));
}

const msg = (text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts: '1790000000.000100',
  text,
  ...extra,
});

describe('classifyTopLevel', () => {
  it.each([...SYSTEM_SUBTYPES])('hides the %s subtype', (subtype) => {
    expect(classifyTopLevel(msg('anything at all', { subtype }))).toEqual({
      kind: 'hidden',
      reason: 'system',
    });
  });

  it.each([
    '<@U0DEMOGP001> has joined the channel',
    '<@U0DEMOGP001|pat> has joined the channel',
    'set the channel description: All the recurring updates',
    'set the channel topic: weekly',
    'added an integration to this channel: <https://demo.slack.com/services/B1|Demo>',
  ])('hides the system text %j even without a subtype', (text) => {
    expect(classifyTopLevel(msg(text)).kind).toBe('hidden');
  });

  it('hides a thread reply that surfaced in history', () => {
    expect(classifyTopLevel(msg('a reply', { thread_ts: '1789999999.000100' })).kind).toBe(
      'hidden',
    );
  });

  it('detects the three live formats in the demo channels', () => {
    const format = (channel: string) => {
      const first = history(channel).find((m) => classifyTopLevel(m).kind !== 'hidden');
      const c = classifyTopLevel(first as SlackMessage);
      return c.kind === 'dealflow' ? c.format : c.kind;
    };
    expect(format(HARBOR)).toBe('T');
    expect(format(PITCHLINE)).toBe('S');
    expect(format(SCOUT)).toBe('R');
  });

  it('captures the source name generically — a novel name still classifies', () => {
    const kind = (text: string) => {
      const c = classifyTopLevel(msg(text));
      return c.kind === 'dealflow' ? c.format : c.kind;
    };
    expect(
      kind('_Lanternfish Collective Deal Flow — Weekly Update | Oct 2–9, 2026_\n\nBody.'),
    ).toBe('T');
    expect(kind('*Lanternfish Collective Deal Flow – Weekly Update | Oct 2–9*')).toBe('T');
    expect(kind('ZEPHYR NOTES DEALFLOW — WEEKLY REPORT\nReview window: x')).toBe('S');
    expect(kind('QUARRY BELL — WEEKLY DEAL-FLOW UPDATE (INCREMENTAL)\nWindow: x')).toBe('R');
  });

  it('falls back to a generic report when two headings are recognised', () => {
    const c = classifyTopLevel(
      msg('Something new this week\n*Summary*\n• one thing\n*Risks*\n• another thing'),
    );
    expect(c).toEqual({ kind: 'dealflow', format: 'G' });
  });

  it.each([
    [':mailbox_with_mail: Weekly digest — Monday, Oct 5, 2026 — covering Oct 1 – Oct 5'],
    [':mailbox_with_mail: Supplemental digest — Tuesday, Oct 6, 2026 — covering missed issues'],
    [':mailbox_with_mail: Roster-approval catch-up digest — Wednesday, Oct 7, 2026'],
    [
      ':mailbox_with_mail: Month-start digest — Thursday, Oct 1, 2026 — No monthly updates received for September.',
    ],
    ['📬 Month-end digest — Wednesday, Sep 30, 2026 — covering Sep 1 – Sep 30, 2026'],
  ])('classifies %j as a digest run', (text) => {
    expect(classifyTopLevel(msg(text))).toEqual({ kind: 'digest', repost: false });
  });

  it('classifies rosters, reposts, corrections and chatter', () => {
    expect(classifyTopLevel(msg(':clipboard: *ROSTER v3* — supersedes v2'))).toEqual({
      kind: 'roster',
      version: 3,
    });
    expect(
      classifyTopLevel(msg('REPOST (reason: corrected a figure)\n── _Item_ (weekly)')),
    ).toEqual({ kind: 'digest', repost: true });
    expect(classifyTopLevel(msg('stop including Northwind Weekly — mostly promo'))).toEqual({
      kind: 'hidden',
      reason: 'human',
    });
    expect(classifyTopLevel(msg('Nice!')).kind).toBe('hidden');
  });

  it('keeps a long unknown post as "other", and a file-only post as a file', () => {
    expect(classifyTopLevel(msg('A long note. '.repeat(40)))).toEqual({
      kind: 'other',
      fileOnly: false,
    });
    expect(classifyTopLevel(msg('Short but signed\n*Sent using* Claude'))).toEqual({
      kind: 'other',
      fileOnly: false,
    });
    expect(classifyTopLevel(msg('', { files: [{ id: 'F1' }] }))).toEqual({
      kind: 'other',
      fileOnly: true,
    });
    expect(classifyTopLevel(msg('')).kind).toBe('hidden');
  });
});

describe('dealflow reports', () => {
  it('merges a thread-format parent and its replies into one report', () => {
    const report = parseDealflowReport(
      'T',
      [
        '_Lanternfish Collective Deal Flow — Weekly Update | Oct 2–9, 2026_',
        '',
        '*Executive Summary*',
        '• 3 new deals this week.',
        '_(New deals, action items &amp; risks in thread below_ :thread:_)_',
        '*Sent using* Claude',
      ].join('\n'),
      [
        '*New Deals (1/2)*\n1. *Alder Bay* — SAFE.\n◦ detail a\n*Sent using* Claude',
        '*New Deals (2/2)*\n2. *Birchlight* — Seed.',
        "_New Deals (cont'd)_\n3. _Cedarway_ — Note.\n\n_Risks / Watch List_\n• Cedarway — early.",
        'Thanks!',
      ],
    );
    expect(report.windowLabel).toBe('Oct 2–9, 2026');
    expect(report.sections.map((s) => s.key)).toEqual(['summary', 'new', 'risks']);
    expect(report.counts.newDeals).toBe(3);
    const newSection = report.sections.find((s) => s.key === 'new');
    expect(newSection?.blocks.filter((b) => b.type === 'numbered')).toHaveLength(3);
  });

  it('recognises italic and bold heading variants', () => {
    for (const heading of ['_Executive Summary_', '*Executive Summary*', '*Action Items:*']) {
      const report = parseDealflowReport('G', `Title line\n${heading}\n• item`, []);
      expect(report.sections[0]?.key).toBe(heading.includes('Action') ? 'actions' : 'summary');
    }
  });

  it('reads all seven sections of the sections format in canonical order', () => {
    const report = dealflow(PITCHLINE, 0);
    expect(report.sections.map((s) => s.key)).toEqual([
      'summary',
      'new',
      'updates',
      'actions',
      'deadlines',
      'risks',
      'whatsnew',
    ]);
    expect(report.counts).toEqual({ newDeals: 2, updates: 0 });
    expect(report.heading).toBe('PITCHLINE DEALFLOW — WEEKLY REPORT');
  });

  it('reads the ruled format: uppercase headings, inline what-is-new, double-escaped &', () => {
    const report = dealflow(SCOUT, 0);
    expect(report.sections.map((s) => s.key)).toEqual([
      'summary',
      'new',
      'updates',
      'actions',
      'deadlines',
      'risks',
      'whatsnew',
    ]);
    expect(report.sections.find((s) => s.key === 'deadlines')?.title).toBe(
      'Upcoming deadlines & meetings',
    );
    const whatsNew = report.sections.find((s) => s.key === 'whatsnew');
    expect(segText(blockSegs(whatsNew?.blocks ?? []))).toMatch(/^two new pitches/);
    expect(report.flags.incremental).toBe(true);
  });

  it('extracts the window in all three formats', () => {
    expect(dealflow(HARBOR, 0).windowLabel).toBe('Sep 11–18, 2026');
    expect(dealflow(PITCHLINE, 0).windowLabel).toBe('Fri Sep 11 – Fri Sep 18, 2026');
    expect(dealflow(SCOUT, 0).windowLabel).toBe('Fri Sep 11 – Fri Sep 18 (CT)');
  });

  it('turns a thread-format exec paragraph into the summary', () => {
    const report = dealflow(HARBOR, 0);
    expect(report.sections[0]?.key).toBe('summary');
    expect(report.sections[0]?.blocks[0]?.type).toBe('para');
    expect(report.counts.newDeals).toBe(3);
  });

  it('counts a quiet week as zero, and sets the baseline and confidential flags', () => {
    expect(dealflow(PITCHLINE, 1).counts).toEqual({ newDeals: 0, updates: 0 });
    expect(dealflow(SCOUT, 1).flags.baseline).toBe(true);
    expect(dealflow(SCOUT, 0).flags.baseline).toBe(false);
    expect(dealflow(PITCHLINE, 0).flags.confidential).toBe(true);
    expect(dealflow(HARBOR, 1).flags.confidential).toBe(false);
  });

  it('never lets a pointer line or footer into a segment', () => {
    for (const [channel, n] of [
      [HARBOR, 2],
      [PITCHLINE, 2],
      [SCOUT, 2],
    ] as const) {
      for (let i = 0; i < n; i++) {
        const text = segText(dealflow(channel, i).sections.flatMap((s) => blockSegs(s.blocks)));
        expect(text).not.toMatch(/Sent using|in thread below|🧵|:thread:/);
      }
    }
  });

  it('keeps a conversational reply out of the report, as a reply', () => {
    const report = parseDealflowReport(
      'T',
      'Oakridge Deal Flow — Weekly Update | Oct 2–9\n\n*Summary*\n• one',
      ['Great, thanks', '*Action Items*\n• follow up'],
    );
    expect(report.sections.map((s) => s.key)).toEqual(['summary', 'actions']);
    expect(report.notes.map((n) => segText(blockSegs(n)))).toEqual(['Great, thanks']);
  });

  it('never files a long or bulleted human reply under the last section', () => {
    const report = parseDealflowReport(
      'T',
      [
        'Oakridge Deal Flow — Weekly Update | Oct 2–9',
        '',
        '*Summary*',
        '• one',
        '*Risks / Watch List*',
        '• Alder Bay — early.',
      ].join('\n'),
      [
        "let's pass on Birchlight — the round is too rich for us. Can you ask Alder Bay for the deck and the cap table before Thursday, and tell Cedarway we'll revisit after their next close?",
        'done:\n- asked Alder Bay for the deck\n- declined Birchlight',
        '*Action Items*\n• follow up\n*Sent using* Claude',
      ],
    );
    const risks = report.sections.find((s) => s.key === 'risks');
    expect(segText(blockSegs(risks?.blocks ?? []))).toBe('Alder Bay — early.');
    expect(risks?.count).toBe(1);
    expect(report.sections.map((s) => s.key)).toEqual(['summary', 'actions', 'risks']);
    expect(report.notes).toHaveLength(2);
    expect(report.notes[1]?.filter((b) => b.type === 'bullet')).toHaveLength(2);
  });

  it('counts an update written as prose, and is only quiet when both sections say None', () => {
    const report = parseDealflowReport(
      'T',
      [
        '*Oakridge Deal Flow — Weekly Update | Oct 2–9*',
        '',
        '*New Deals*',
        'None — no new pitches this week.',
        '',
        '*Material Updates to Previously Reported Deals*',
        '',
        '*Alder Bay* (seed fund) — _What changed:_ published Q3 results. _Action:_ review the report.',
      ].join('\n'),
      [],
    );
    expect(report.counts).toEqual({ newDeals: 0, updates: 1 });
    expect(report.sections.find((s) => s.key === 'updates')?.count).toBe(1);

    const noUpdates = parseDealflowReport(
      'T',
      'Oakridge Deal Flow — Weekly Update | Oct 2–9\n\n*New Deals*\n1. *Alder Bay* — SAFE.',
      [],
    );
    expect(noUpdates.counts).toEqual({ newDeals: 1, updates: null });
  });

  it('counts "None" as zero in any section', () => {
    const report = dealflow(PITCHLINE, 1);
    expect(report.sections.find((s) => s.key === 'risks')?.count).toBe(0);
  });
});

describe('digest runs', () => {
  it('reads the header, counts and attention list of a weekly run', () => {
    const run = digestRun(0);
    expect(run.kind).toBe('weekly');
    expect(run.kindLabel).toBe('Weekly');
    expect(run.dateLabel).toBe('Monday, Sep 21, 2026');
    expect(run.covering).toMatch(/^covering /);
    expect(run.counts).toEqual({ total: 3, weekly: 3, monthly: 0 });
    expect(run.meta).toEqual(['Running on ROSTER v2.']);
    expect(run.attention.map((b) => segText(blockSegs([b])))).toEqual([
      'Cobalt Orchard needs a signed board consent before its next close.',
      'Fieldnote Analytics grew revenue 9% month over month and hired a CFO.',
      'Brassfinch Weekly reports a slower seed market for hardware.',
    ]);
  });

  it('falls back to the first three bullets when there is no attention line', () => {
    const run = parseDigestRun(
      [
        ':mailbox_with_mail: Weekly digest — Friday, Oct 9, 2026 — covering Oct 5 – Oct 9',
        '• one',
        '• two',
        '• three',
        '• four',
      ].join('\n'),
      [],
    );
    expect(run.attention).toHaveLength(3);
  });

  it('flags a provisional run and an empty month-start run', () => {
    const provisional = parseDigestRun(
      ':mailbox_with_mail: Weekly digest — Tuesday, Oct 6, 2026 — covering Sep 22 – Oct 6\n:warning: _provisional run — no roster found._',
      [],
    );
    expect(provisional.provisional).toBe(true);
    const monthStart = digestRun(2);
    expect(monthStart.kind).toBe('month-start');
    expect(monthStart.empty).toBe(true);
    expect(monthStart.items).toEqual([]);
  });

  it('maps every run label to its kind', () => {
    const kind = (label: string) =>
      parseDigestRun(`:mailbox_with_mail: ${label} digest — Friday, Oct 9, 2026`, []).kind;
    expect(kind('Weekly')).toBe('weekly');
    expect(kind('Month-start')).toBe('month-start');
    expect(kind('Month-end')).toBe('month-end');
    expect(kind('Supplemental')).toBe('supplemental');
    expect(kind('Roster-approval catch-up')).toBe('catch-up');
    expect(kind('Special')).toBe('other');
  });

  it('splits two items posted in one reply', () => {
    const run = digestRun(0);
    expect(run.items.map((i) => i.title)).toEqual([
      'Fieldnote Analytics',
      'Brassfinch Weekly',
      'Cobalt Orchard',
    ]);
    expect(run.items[0]?.detail).toBe('Weekly Founder Note');
    expect(run.items[1]?.newsletter).toBe(true);
    expect(run.items[1]?.cadence).toBe('weekly, Fridays');
  });

  it('finds newsletter markers before and inside the italics', () => {
    for (const line of [
      '── ✷ _Alpha Letter_ (weekly)',
      '── _⁂ Alpha Letter_ (weekly)',
      '── _✲ Alpha Letter_ (weekly, Mondays)',
    ]) {
      const item = parseDigestItem(line);
      expect(item.newsletter).toBe(true);
      expect(item.title).toBe('Alpha Letter');
    }
    expect(parseDigestItem('── _Alpha Letter_ (weekly)').newsletter).toBe(false);
  });

  it('reads the lock note and the attention group', () => {
    const cobalt = digestRun(0).items[2];
    expect(cobalt?.locked).toBe(true);
    expect(cobalt?.lockNote).toBe(
      'sender marks this investors-only: "for our investors, not for circulation"',
    );
    expect(cobalt?.cadence).toBe('weekly');
    expect(cobalt?.needsAttention).toBe(true);
    const attention = cobalt?.groups.find((g) => g.tone === 'attention');
    expect(attention?.label).toBe('Needs attention');
    expect(segText(blockSegs(attention?.blocks ?? []))).toMatch(/^Board consent due Thursday/);
  });

  it('keeps a lock inside the cadence parentheses balanced', () => {
    const item = parseDigestItem('── _Delta Update_ (monthly — :lock: investors only)');
    expect(item.locked).toBe(true);
    expect(item.lockNote).toBe('investors only');
    expect(item.title).toBe('Delta Update');
    expect(item.cadence).toBe('monthly');
  });

  it('reads a one-line Metrics group', () => {
    const metrics = digestRun(0).items[0]?.groups.find((g) => g.label === 'Metrics');
    expect(segText(blockSegs(metrics?.blocks ?? []))).toBe(
      '$84K MRR; 61 customers; no churn this month',
    );
  });

  it('labels a dated link line and repairs the broken form', () => {
    const item = parseDigestItem(
      [
        '── *Echo Robotics — Founder Update* (monthly)',
        'From: Ari Vale <mailto:founder@echo.example> | Subject: "August" | Received: Mon, Aug 31',
        'Link (Aug 31): <https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000011|Open in Gmail>',
      ].join('\n'),
    );
    expect(item.links).toEqual([
      {
        label: 'Open in Gmail (Aug 31)',
        href: 'https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000011',
      },
    ]);
    expect(item.meta).toEqual([
      'From: Ari Vale founder@echo.example',
      'Subject: "August"',
      'Received: Mon, Aug 31',
    ]);
    const fieldnote = digestRun(0).items[0];
    expect(fieldnote?.links[0]?.href).toBe(
      'https://mail.google.com/mail/?authuser=demo@example.com#all/0f00000000000001',
    );
  });

  it('never lets a Ledger line into any segment', () => {
    const walk = (blocks: Block[]) => segText(blockSegs(blocks));
    const extra = parseDigestItem(
      [
        '── ✲ _Foxglove Notes_ (monthly — :warning: delivered twice)',
        'Ledger: 0f00000000000021',
        '_Ledger_: 0f00000000000022',
        'Key takeaways:',
        '• one',
      ].join('\n'),
    );
    const texts = [0, 1, 2, 3]
      .map(digestRun)
      .flatMap((run) => [
        walk(run.attention),
        walk(run.housekeeping),
        ...run.items.map((i) => segText(itemSegs(i)) + i.meta.join(' ')),
        ...run.notes.map((n) => walk(n.blocks)),
      ]);
    texts.push(segText(itemSegs(extra)));
    for (const text of texts) expect(text).not.toMatch(/Ledger/);
  });

  it('collects housekeeping from a rule, including the tail of an item reply', () => {
    const run = parseDigestRun(
      ':mailbox_with_mail: Weekly digest — Friday, Oct 9, 2026 — covering Oct 5 – Oct 9\n1 update (1 weekly / 0 monthly)\n_No issue this period from:_ Gamma Weekly',
      [
        {
          ts: '1790000010.000200',
          text: '── _Gamma Letter_ (weekly)\nKey takeaways:\n• a\n────────────\n_Candidate series noticed_ — Hazel Notes',
        },
      ],
    );
    expect(run.items).toHaveLength(1);
    const house = segText(blockSegs(run.housekeeping));
    expect(house).toContain('No issue this period from: Gamma Weekly');
    expect(house).not.toContain('Hazel');
    expect(segText(blockSegs(run.asks))).toContain('Candidate series noticed — Hazel Notes');
    expect(segText(itemSegs(run.items[0] as DigestItem))).not.toContain('Hazel');
  });

  it('reads the housekeeping reply, the open candidate ask, the correction and a note', () => {
    const run = digestRun(0);
    const house = segText(blockSegs(run.housekeeping));
    expect(house).toContain('Juniper Row Studio');
    expect(house).not.toContain('Harborview');
    const asks = segText(blockSegs(run.asks));
    expect(asks).toContain('Reply "add Harborview Notes"');
    expect(asks).toContain('Seen twice, 30 days apart');
    expect(run.notes).toEqual([
      expect.objectContaining({
        correction: true,
        blocks: [{ type: 'para', lines: [[{ text: 'stop including Northwind Weekly' }]] }],
      }),
    ]);
    expect(classifyDigestReply('Looks good, thanks')).toBe('note');
    expect(classifyDigestReply('add Metro Letter')).toBe('correction');
    expect(classifyDigestReply('x', 'channel_join')).toBe('skip');
  });

  it('keeps every other parent line: warnings, flags and run notes', () => {
    const run = parseDigestRun(
      [
        ':mailbox_with_mail: Weekly digest — Tuesday, Oct 6, 2026 — covering Sep 22 – Oct 6',
        '4 updates (1 weekly / 3 monthly, across 3 series — Delta sent two issues)',
        '',
        ':warning: _provisional run — no roster found._ The inclusion rules were applied directly.',
        '',
        '_Scope note:_ first-party updates only.',
        '',
        ':lock: One of these (Delta) is marked investors-only by its sender.',
        '_Candidate series noticed:_ nothing new this run.',
      ].join('\n'),
      [],
    );
    expect(run.provisional).toBe(true);
    expect(run.meta).toEqual([
      'Across 3 series — Delta sent two issues',
      'Scope note: first-party updates only.',
    ]);
    const lead = segText(blockSegs(run.lead));
    expect(lead).toContain('provisional run — no roster found.');
    expect(lead).toContain('Candidate series noticed: nothing new this run.');
    expect(run.asks).toEqual([]);
    expect(run.callouts.map((b) => segText(blockSegs([b])))).toEqual([
      '🔒 One of these (Delta) is marked investors-only by its sender.',
    ]);
  });

  it('lifts the flag sentences out of a run written as one paragraph', () => {
    const run = digestRun(3);
    expect(run.kind).toBe('supplemental');
    expect(run.attention).toEqual([]);
    expect(run.callouts.map((b) => segText(blockSegs([b])))).toEqual([
      'One is time-sensitive: Gullwing Bikes has $120K left in a SAFE that closes at the end of the month.',
    ]);
    expect(segText(blockSegs(run.lead))).toMatch(/^This is the monthly series/);
  });

  it('keeps a check-mark status to its own line', () => {
    const item = digestRun(3).items[0] as DigestItem;
    expect(item.groups.map((g) => [g.label, g.tone])).toEqual([
      ['Done', 'done'],
      ['', 'default'],
    ]);
    expect(segText(blockSegs(item.groups[0]?.blocks ?? []))).toMatch(/^The series has resumed/);
    expect(segText(blockSegs(item.groups[1]?.blocks ?? []))).toContain('310 bikes sold');
  });

  it('keeps a subject that contains a bar in one piece', () => {
    expect(digestRun(3).items[0]?.meta).toEqual([
      'From: Rae Okafor rae@gullwing.example',
      'Subject: "Update | August"',
      expect.stringMatching(/^Received: /),
      'Period: last month',
    ]);
  });

  it('keeps a multi-line note as lines', () => {
    const run = parseDigestRun(':mailbox_with_mail: Weekly digest — Friday, Oct 9, 2026', [
      {
        ts: '1790000010.000200',
        text: 'Correction to two items:\n• Gamma Letter: revenue was $41K\n• Hazel Notes: monthly, not weekly',
      },
    ]);
    const blocks = run.notes[0]?.blocks ?? [];
    expect(blocks.filter((b) => b.type === 'bullet')).toHaveLength(2);
  });

  it('reads a top-level repost and its reason', () => {
    const run = parseDigestRun(
      'REPOST (reason: corrected the MRR figure)\n── _Iris Labs — Weekly Brief_ (weekly)\nKey takeaways:\n• MRR was $51K\n*Sent using* Claude',
      [],
    );
    expect(run.kind).toBe('repost');
    expect(run.covering).toBe('corrected the MRR figure');
    expect(run.items[0]?.title).toBe('Iris Labs');
    expect(run.items[0]?.repost).toBe('corrected the MRR figure');
  });

  it('parses month-end items inline exactly as it parses threaded ones', () => {
    const inline = digestRun(1);
    expect(inline.kind).toBe('month-end');
    expect(inline.items).toHaveLength(1);
    const header =
      ':mailbox_with_mail: Month-end digest — Monday, Sep 14, 2026 — covering the past month\n1 update (0 weekly / 1 monthly)';
    const chunk = (history(DIGEST).find((m) => m.text?.includes('Month-end'))?.text ?? '')
      .split('\n')
      .slice(3)
      .join('\n');
    const threaded = parseDigestRun(header, [{ ts: '1790000020.000200', text: chunk }]);
    expect(threaded.items).toEqual(inline.items);
  });
});

describe('hostile input', () => {
  it('classifies and parses a huge first line in linear time', () => {
    const huge = `a${' '.repeat(30_000)}b`;
    const started = Date.now();
    expect(classifyTopLevel(msg(huge)).kind).toBe('other');
    parseDealflowReport('G', huge, []);
    parseDigestRun(huge, []);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('rosters', () => {
  const rosters = history(DIGEST).filter((m) => classifyTopLevel(m).kind === 'roster');

  it('reads lists with counts, the appendix and the confidential flag', () => {
    const v2 = rosters.find((m) => m.text?.includes('ROSTER v2')) as SlackMessage;
    const appendix = replyTexts(DIGEST, v2).map((r) => r.text);
    const roster = parseRoster(v2.text ?? '', appendix);
    expect(roster.version).toBe(2);
    expect(roster.lists.map((l) => [l.title, l.count])).toEqual([
      ['Weekly', 3],
      ['Monthly', 1],
      ['Also included', 1],
    ]);
    // One entry is investors-only; the roster itself is not.
    expect(roster.confidential).toBe(false);
    expect(segText(blockSegs(roster.appendix))).toContain('Linkheap Daily');
  });

  it('marks a roster confidential only from its own preamble', () => {
    const roster = parseRoster(
      ':clipboard: *ROSTER v5* — :lock: internal only, do not forward\n\n*WEEKLY (1)*\n1. Alpha Letter',
      [],
    );
    expect(roster.confidential).toBe(true);
  });

  it('gives a v1 roster without counts a null count', () => {
    const v1 = rosters.find((m) => m.text?.includes('ROSTER v1')) as SlackMessage;
    const roster = parseRoster(v1.text ?? '', []);
    expect(roster.version).toBe(1);
    expect(roster.lists.map((l) => l.count)).toEqual([null, null]);
    expect(roster.confidential).toBe(false);
  });
});
