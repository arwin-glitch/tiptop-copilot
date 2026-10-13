import { describe, expect, it } from 'vitest';
import {
  buildCompanyNumbers,
  extractMetrics,
  findMoney,
  formatMoney,
  hasAnyMetric,
  sparkline,
  toSentences,
  NO_METRICS,
  type ReportedMetrics,
  type UpdateReport,
} from '@/lib/company-updates/metrics';
import { companySearchQuery, screenForCompany } from '@/lib/services/portfolio-numbers';
import { htmlToPlainText } from '@/lib/util/text';

const revenueOf = (text: string) => {
  const r = extractMetrics(text).revenue;
  return r ? `${r.kind} ${r.display}` : null;
};

describe('money', () => {
  it('reads amounts with units and formats them back the way founders write them', () => {
    expect(
      findMoney('ARR $5.4M, cash $13.15M, $611K, $450,000 and $1.33 million').map((m) => m.display),
    ).toEqual(['$5.4M', '$13.15M', '$611K', '$450K', '$1.33M']);
    expect(formatMoney(4_860_000)).toBe('$4.86M');
    expect(formatMoney(2_100_000_000)).toBe('$2.1B');
  });

  it('does not read "$5 more" as five million', () => {
    expect(findMoney('it costs $5 more per seat').map((m) => m.amount)).toEqual([5]);
  });
});

describe('sentences', () => {
  it('joins hard-wrapped lines and starts a new sentence at bullets and label lines', () => {
    const text = [
      'Hi all,',
      '',
      'ARR ended Q3 at $450K, up from',
      '$185K in Q2.',
      '• Cash is $4.86M',
      'Runway: 18 months',
    ].join('\n');
    expect(toSentences(text)).toEqual([
      'Hi all,',
      'ARR ended Q3 at $450K, up from $185K in Q2.',
      'Cash is $4.86M',
      'Runway: 18 months',
    ]);
  });

  it('drops the quoted reply under "On … wrote:"', () => {
    const text =
      'ARR is $2M.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Ada <ada@x.example> wrote:\n> ARR is $9M';
    expect(toSentences(text)).toEqual(['ARR is $2M.']);
  });
});

describe('ARR and MRR', () => {
  it('takes the actual, not the plan figure, and the YoY growth', () => {
    const m = extractMetrics("ARR: +82% YoY, $5.4M vs $5.3M Q2'25 plan");
    expect(m.revenue).toMatchObject({ kind: 'ARR', display: '$5.4M', amount: 5_400_000 });
    expect(m.growth?.label).toBe('+82% YoY');
  });

  it('takes the later value, not the one it grew from', () => {
    expect(extractMetrics('ARR ended Q3 at $450K, up from $185K in Q2').revenue?.display).toBe(
      '$450K',
    );
    expect(extractMetrics('ARR grew from $185K to $450K this quarter.').revenue?.display).toBe(
      '$450K',
    );
  });

  it('picks the latest quarter when both are stated plainly', () => {
    expect(extractMetrics('ARR was $185K in Q2 and $450K in Q3.').revenue?.display).toBe('$450K');
  });

  it('reads "$611K ARR with 85% of annual clients renewing" as $611K', () => {
    const m = extractMetrics(
      'We closed the quarter at $611K ARR with 85% of annual clients renewing.',
    );
    expect(m.revenue?.display).toBe('$611K');
    expect(m.growth).toBeNull();
  });

  it('keeps ARR and the raise apart in one sentence', () => {
    const m = extractMetrics('$1.33M ARR, with a Series A raise planned for early November');
    expect(m.revenue?.display).toBe('$1.33M');
    expect(m.raising?.label).toBe('Series A raise planned for early November');
  });

  it('never takes a target or a future milestone', () => {
    for (const text of [
      "We're targeting $5M ARR by the end of next year.",
      'Our goal is $10M ARR.',
      'We are on track to hit $2M ARR by December.',
      'We expect to end the year at $8M ARR.',
      'The path to $10M ARR runs through enterprise.',
      'Plan for 2027: $12M ARR',
    ]) {
      expect(extractMetrics(text).revenue, text).toBeNull();
    }
  });

  it('ignores other companies, new ARR and changes', () => {
    for (const text of [
      'Our top competitor has $50M ARR.',
      'We sell to companies with $5M+ ARR.',
      'We added $200K of new ARR this month.',
      'Net new ARR: $600K',
      'ARR grew by $200K.',
      '+$150K ARR QoQ',
    ]) {
      expect(extractMetrics(text).revenue, text).toBeNull();
    }
  });

  it('does not take customer counts or market size as revenue', () => {
    const m = extractMetrics('We now serve 120 customers in a $50B market. ARR is $2M.');
    expect(m.revenue?.display).toBe('$2M');
  });

  it('keeps the current value over a parenthesised prior one', () => {
    expect(extractMetrics('Q3 ARR: $5.4M (Q2: $4.8M)').revenue?.display).toBe('$5.4M');
  });

  it('counts a milestone that was reached', () => {
    expect(extractMetrics('We crossed the $1M ARR milestone in September.').revenue?.display).toBe(
      '$1M',
    );
  });

  it('gives up when two figures disagree with nothing to choose between them', () => {
    expect(extractMetrics('ARR | $450K | $185K').revenue).toBeNull();
  });

  it('reports MRR as MRR and never annualises it', () => {
    const m = extractMetrics('MRR $40K, up 12% month over month.');
    expect(m.revenue).toMatchObject({ kind: 'MRR', display: '$40K' });
  });

  it('prefers ARR when both are stated', () => {
    const m = extractMetrics('MRR is $50K.\nARR: $600K');
    expect(m.revenue).toMatchObject({ kind: 'ARR', display: '$600K' });
  });

  it('reads ARR from the subject line when the body only repeats it', () => {
    const m = extractMetrics(
      "Maestra Q3'26: $5.4M ARR, profitable growth with a default-alive budget\n\nHi investors, a strong quarter.",
    );
    expect(m.revenue?.display).toBe('$5.4M');
    expect(m.runway?.label).toBe('Default alive');
  });

  it.each([
    'Closed Contoso at $250K ARR.',
    'Our largest customer is now at $250K ARR.',
    'We have $2M ARR in pipeline.',
    'Pipeline ARR is $4M.',
    'Our pilot with Acme converted to $120K ARR.',
    'Customer spotlight: Contoso, a $2M ARR logistics firm, signed on.',
    'Wins: signed Acme, a $120K ARR contract.',
    'Biggest win: Acme signed a 3-year deal worth $300K ARR.',
    'Qualified pipeline is $3.1M ARR.',
    'Our largest deal to date: $450K ARR with Globex.',
    'New logos: Acme ($120K ARR)',
    'Enterprise ARR: $400K',
  ])('a deal, customer, segment or pipeline figure is not company ARR: %s', (text) => {
    expect(revenueOf(text)).toBeNull();
  });

  it('reads the KPI block, not the wins listed above it', () => {
    const body =
      'Highlights:\n- Signed Northwind ($120K ARR), our largest contract yet\n- Closed a $250K ARR deal with Contoso\n\nKPIs:\n- ARR: $1.4M';
    expect(revenueOf(body)).toBe('ARR $1.4M');
    expect(
      revenueOf(
        htmlToPlainText('<ul><li>Signed Northwind ($120K ARR)</li><li>ARR: $1.4M</li></ul>'),
      ),
    ).toBe('ARR $1.4M');
    expect(revenueOf('Wins: signed Acme, a $120K ARR contract.\nARR is now $1.4M.')).toBe(
      'ARR $1.4M',
    );
  });

  it('still reads the company’s own ARR in ordinary phrasings', () => {
    expect(revenueOf('We closed September at $1.2M ARR.')).toBe('ARR $1.2M');
    expect(revenueOf("We're now a $2M ARR company.")).toBe('ARR $2M');
    expect(revenueOf('ARR expanded to $1.4M this quarter.')).toBe('ARR $1.4M');
    expect(revenueOf('Total ARR of $1.4M across 52 customers.')).toBe('ARR $1.4M');
    expect(revenueOf('ARR (Sep 30): $1.2M')).toBe('ARR $1.2M');
    expect(revenueOf('ARR - $1.2M')).toBe('ARR $1.2M');
    expect(revenueOf('ARR closed Q3 at $2.4M.')).toBe('ARR $2.4M');
    expect(revenueOf('ARR now sits at $3.2M (up from $2.4M last quarter).')).toBe('ARR $3.2M');
  });

  it('weighs every statement: a labelled figure beats a mention, and two labels that disagree give nothing', () => {
    expect(revenueOf('Ledgerly October update: $780K ARR\n\nARR reached $780K this month.')).toBe(
      'ARR $780K',
    );
    expect(revenueOf('We hit $1M ARR in the spring.\n\nARR: $1.33M')).toBe('ARR $1.33M');
    expect(revenueOf('ARR: $1.4M.\n\nARR is $1.6M.')).toBeNull();
  });

  it.each([
    'ARR grew 20% this quarter and we spent $400K on marketing.',
    'ARR is up 3x since we hired our first AE, who cost us $150K.',
    'ARR per employee is $180K.',
  ])('a figure far from the ARR label is not ARR: %s', (text) => {
    expect(revenueOf(text)).toBeNull();
  });

  it('gives up on KPI table rows, which list several periods with nothing to say which is current', () => {
    const table = htmlToPlainText(
      '<table><tr><th>Metric</th><th>Q1</th><th>Q2</th><th>Q3</th></tr><tr><td>ARR</td><td>$600K</td><td>$800K</td><td>$1.2M</td></tr><tr><td>Cash</td><td>$3.0M</td><td>$2.6M</td><td>$2.2M</td></tr></table>',
    );
    expect(extractMetrics(table).revenue).toBeNull();
    expect(extractMetrics(table).cash).toBeNull();
    expect(revenueOf('Metric Q1 Q2 Q3\nARR $600K $800K $1.2M')).toBeNull();
    expect(revenueOf('Metric\tQ2\tQ3\nARR\t$450K\t$611K')).toBeNull();
  });

  it('never takes a year-ago figure for the current one', () => {
    expect(revenueOf('ARR was $1.2M in Q3 and $650K in Q3 2025.')).toBe('ARR $1.2M');
    expect(revenueOf('ARR: $1.2M in Q3, $650K in Q3 2025')).toBe('ARR $1.2M');
    expect(revenueOf("We ended Q3 with $1.2M ARR in Q3 and $650K in Q3'25.")).toBe('ARR $1.2M');
    expect(revenueOf('ARR was $650K in Q3 2025 and $1.2M in Q3 2026.')).toBe('ARR $1.2M');
    expect(revenueOf('ARR is $1.2M and was $650K in Q3 2025.')).toBe('ARR $1.2M');
  });

  it('takes the figure after an arrow', () => {
    expect(revenueOf('ARR: $1.2M → $1.5M')).toBe('ARR $1.5M');
    expect(revenueOf('ARR $1.2M → $1.5M (+25% QoQ)')).toBe('ARR $1.5M');
    expect(revenueOf('MRR: $40K -> $55K')).toBe('MRR $55K');
    const m = extractMetrics('KPIs\nARR: $450K → $611K\nCash: $3.1M → $2.6M');
    expect(m.revenue?.display).toBe('$611K');
    expect(m.cash?.display).toBe('$2.6M');
  });
});

describe('cash', () => {
  it('reads cash on hand in the usual phrasings', () => {
    expect(extractMetrics('Cash is $4.86M.').cash?.display).toBe('$4.86M');
    expect(extractMetrics('We have $13.15M in the bank.').cash?.display).toBe('$13.15M');
    expect(extractMetrics('We ended September with $2.2M in cash.').cash?.display).toBe('$2.2M');
  });

  it('does not take burn, cash flow or post-raise figures as cash', () => {
    for (const text of [
      'Net burn was $180K per month.',
      'Cash burn is down to $90K a month.',
      'After the round closes we will have $9M in the bank.',
      'We raised $3M from Acme Fund.',
    ]) {
      expect(extractMetrics(text).cash, text).toBeNull();
    }
  });

  it.each([
    'We spent $400K of cash this quarter.',
    'We burned $400K of cash this quarter.',
    'We have spent $1.2M cash this year.',
    'We raised $1.5M in cash from new angels.',
    'Cash collected: $800K this quarter.',
    'We collected $900K in cash from customers.',
    'We received a $500K cash grant.',
    'Our customers keep $50M in the bank with us.',
    'Cash is tight after we paid $300K to our contractor.',
  ])('money moving in or out, or held for others, is not the cash balance: %s', (text) => {
    expect(extractMetrics(text).cash).toBeNull();
  });

  it('finds the balance next to spend and receivables', () => {
    expect(
      extractMetrics('Cash: we spent $400K this quarter and ended with $2.2M.').cash?.display,
    ).toBe('$2.2M');
    expect(extractMetrics('We have $2M in cash and $500K in receivables.').cash?.display).toBe(
      '$2M',
    );
    expect(extractMetrics('Cash on hand: $3.5M').cash?.display).toBe('$3.5M');
    expect(extractMetrics('We have $2.2M of cash remaining.').cash?.display).toBe('$2.2M');
    expect(extractMetrics('$5.1M in the bank after the bridge closed.').cash?.display).toBe(
      '$5.1M',
    );
  });
});

describe('runway', () => {
  it('reads months and dates', () => {
    expect(extractMetrics('We have 14 months of runway.').runway).toMatchObject({
      label: '14 months',
      months: 14,
    });
    expect(extractMetrics('Runway: 18+ months').runway?.label).toBe('18+ months');
    expect(extractMetrics('Runway extends into February 2027').runway?.label).toBe('into Feb 2027');
    expect(extractMetrics('That gives us runway through Q2 2027.').runway?.label).toBe(
      'through Q2 2027',
    );
    expect(extractMetrics('We have eighteen months of runway left.').runway?.months).toBe(18);
  });

  it('ignores runway that depends on a raise', () => {
    expect(extractMetrics('After this round we will have 24 months of runway.').runway).toBeNull();
    expect(extractMetrics('We are not default alive yet.').runway).toBeNull();
  });

  it.each([
    'We are on a path to default alive.',
    'Our goal is to be default alive by Q2.',
    'We expect to be default alive next year.',
    'We plan to be default alive by year end.',
    'We are close to default alive.',
    'Burn multiple is 1.2 and we are aiming for default alive by Q2.',
    "We're on track to be default alive by mid-2027.",
    'Our 2027 plan is default alive.',
    'We extended runway by 6 months.',
    'Runway: extended by 4 months thanks to the bridge.',
    'We added 6 months of runway.',
    'We plan to extend runway to 24 months.',
    'Target runway: 24 months',
    'We need 18 months of runway to hit Series A metrics.',
    'We aim to have 18 months of runway after cuts.',
    'We plan to extend our runway into 2028.',
  ])('a plan, a goal or a change is not runway: %s', (text) => {
    expect(extractMetrics(text).runway).toBeNull();
  });

  it('still reads runway and default alive stated as fact, next to a plan in another clause', () => {
    expect(extractMetrics('We are default alive.').runway?.label).toBe('Default alive');
    expect(extractMetrics("We're profitable and default alive.").runway?.label).toBe(
      'Default alive',
    );
    expect(
      extractMetrics('We have 14 months of runway and we expect to start our Series A in Q1.')
        .runway?.label,
    ).toBe('14 months');
    expect(
      extractMetrics('We have $4.2M in the bank, giving us 22 months of runway.').runway?.label,
    ).toBe('22 months');
  });
});

describe('raising', () => {
  it('reads an open or planned raise as written', () => {
    expect(
      extractMetrics('We are preparing to launch a $4.5M seed round in January.').raising?.label,
    ).toBe('preparing to launch a $4.5M seed round in January');
    expect(extractMetrics("We're raising a $3M pre-Series A.").raising?.label).toBe(
      'raising a $3M pre-Series A',
    );
    expect(extractMetrics("We'll start Round A talks in November.").raising?.label).toBe(
      'start Round A talks in November',
    );
  });

  it('ignores past rounds, other people and things that are not fundraising', () => {
    for (const text of [
      'We closed our seed in 2024.',
      'Since our seed round, we have tripled the team.',
      'Our customer Northwind just raised a Series B.',
      'We will raise prices next month.',
      'We are not raising right now.',
      'If the market holds, we may raise a bridge.',
      'Thanks to our seed investors for the intros this month.',
      'Our Series A lead will join the board in November.',
      'Our customer Northwind is starting their Series B process.',
      'Bolt is raising a seed round and we are helping them.',
      'We need to hit Series A metrics this year.',
    ]) {
      expect(extractMetrics(text).raising, text).toBeNull();
    }
  });

  it('keeps "Next month" in the label and reads the company’s own name as itself', () => {
    expect(extractMetrics('Next month we will open a bridge round').raising?.label).toBe(
      'Next month we will open a bridge round',
    );
    const text = 'Ledgerly is raising a $3M seed round.';
    expect(extractMetrics(text, { company: 'Ledgerly' }).raising?.label).toBe(
      'Ledgerly is raising a $3M seed round',
    );
    expect(extractMetrics(text, { company: 'Quillfeather' }).raising).toBeNull();
  });
});

describe('growth', () => {
  it('needs a revenue sentence and drops plans', () => {
    expect(extractMetrics('Revenue was up 140% year over year.').growth?.label).toBe('+140% YoY');
    expect(extractMetrics('ARR is 3x YoY.').growth?.label).toBe('3x YoY');
    expect(extractMetrics('Headcount grew 50% YoY.').growth).toBeNull();
    expect(extractMetrics('We plan to grow ARR 3x YoY.').growth).toBeNull();
  });

  it.each([
    'Headcount up 50% YoY, ARR $1M.',
    'Users grew 3x YoY and revenue is $1M ARR.',
    'Customers grew 120% YoY while ARR is $2M.',
    'Burn down 30% YoY; revenue $4M.',
    'Gross margin +12% YoY, ARR $3M.',
    'Market growing 25% YoY; ARR is $1M.',
    'Last year ARR grew 200% YoY.',
    'Our customers see revenue grow 30% YoY.',
    'Net revenue retention is up 10% YoY.',
  ])('a YoY figure that belongs to something other than our revenue is not growth: %s', (text) => {
    expect(extractMetrics(text).growth).toBeNull();
  });

  it('reads growth that follows the revenue figure it belongs to', () => {
    expect(extractMetrics('ARR is now $700K, +96% YoY.').growth?.label).toBe('+96% YoY');
    expect(extractMetrics("We're at $2.1M ARR, growing 140% YoY.").growth?.label).toBe('+140% YoY');
    expect(extractMetrics('ARR grew 140% YoY to $2.1M.').growth?.label).toBe('+140% YoY');
    expect(
      extractMetrics('Our customers love the new app, and ARR is up 50% YoY.').growth?.label,
    ).toBe('+50% YoY');
  });
});

describe('a whole update', () => {
  it('pulls every metric out of a realistic founder email', () => {
    const body = [
      'Hi friends,',
      '',
      'Quick Q3 recap for the Fernhollow investor group.',
      '',
      'Highlights',
      '• ARR ended Q3 at $1.33M, up from $910K in Q2 (+46% QoQ) and +170% YoY.',
      '• We signed 14 new logos; our pipeline is $3.1M.',
      '• Cash is $4.86M and runway extends into February 2028.',
      '',
      'Next up: we plan to start Series A conversations in early November, targeting $3M ARR by then.',
      '',
      'Thanks,',
      'Ada',
    ].join('\n');
    const m = extractMetrics(body);
    expect(m.revenue?.display).toBe('$1.33M');
    expect(m.growth?.label).toBe('+170% YoY');
    expect(m.cash?.display).toBe('$4.86M');
    expect(m.runway?.label).toBe('into Feb 2028');
    expect(m.raising?.label).toBe('plan to start Series A conversations in early November');
    expect(hasAnyMetric(m)).toBe(true);
  });

  it('finds nothing in an email without numbers', () => {
    const m = extractMetrics('Hi Nick, thanks for the intro yesterday. Talk soon.');
    expect(hasAnyMetric(m)).toBe(false);
  });
});

describe('per-company numbers', () => {
  const metrics = (patch: Partial<ReportedMetrics>): ReportedMetrics => ({
    ...NO_METRICS,
    ...patch,
  });
  const arr = (amount: number) => ({
    kind: 'ARR' as const,
    amount,
    display: formatMoney(amount),
    evidence: '',
  });
  const report = (date: string, patch: Partial<ReportedMetrics>, id = date): UpdateReport => ({
    messageId: `a${id.replace(/\D/g, '')}`,
    threadId: `b${id.replace(/\D/g, '')}`,
    subject: 'Update',
    date,
    metrics: metrics(patch),
  });

  it('keeps the latest of each metric with its date and a history to scale', () => {
    const numbers = buildCompanyNumbers({ id: 'c1', name: 'Fernhollow' }, [
      report('2026-04-02T15:00:00Z', {
        revenue: arr(520_000),
        cash: { amount: 3e6, display: '$3M', evidence: '' },
      }),
      report('2026-10-02T15:00:00Z', { revenue: arr(780_000) }),
      report('2026-07-02T15:00:00Z', {
        revenue: arr(650_000),
        runway: { label: '14 months', months: 14, evidence: '' },
      }),
    ]);
    expect(numbers?.revenue?.value.display).toBe('$780K');
    expect(numbers?.revenue?.asOf).toBe('2026-10-02T15:00:00Z');
    expect(numbers?.cash?.asOf).toBe('2026-04-02T15:00:00Z');
    expect(numbers?.runway?.value.label).toBe('14 months');
    expect(numbers?.history.map((p) => p.amount)).toEqual([520_000, 650_000, 780_000]);
    expect(numbers?.updatesRead).toBe(3);
  });

  it('keeps one history point per day and only the latest kind', () => {
    const numbers = buildCompanyNumbers({ id: 'c1', name: 'Fernhollow' }, [
      report('2026-03-01T10:00:00Z', {
        revenue: { kind: 'MRR', amount: 30_000, display: '$30K', evidence: '' },
      }),
      report('2026-06-01T10:00:00Z', { revenue: arr(400_000) }, '1'),
      report('2026-06-01T18:00:00Z', { revenue: arr(410_000) }, '2'),
      report('2026-09-01T10:00:00Z', { revenue: arr(500_000) }),
    ]);
    expect(numbers?.history.map((p) => p.amount)).toEqual([410_000, 500_000]);
  });

  it('lists nothing for a company whose updates carry no numbers', () => {
    expect(
      buildCompanyNumbers({ id: 'c1', name: 'Quiet' }, [report('2026-06-01T10:00:00Z', {})]),
    ).toBeNull();
  });
});

describe('sparkline', () => {
  it('draws by date on a zero baseline', () => {
    const line = sparkline(
      [
        { date: '2026-01-01T00:00:00Z', amount: 500 },
        { date: '2026-01-11T00:00:00Z', amount: 1000 },
        { date: '2026-01-31T00:00:00Z', amount: 1000 },
      ],
      { width: 64, height: 24, pad: 2 },
    );
    expect(line?.points).toEqual([
      { x: 2, y: 12 },
      { x: 22, y: 2 },
      { x: 62, y: 2 },
    ]);
    expect(line?.path).toBe('M2 12 L22 2 L62 2');
  });

  it('needs two points', () => {
    expect(
      sparkline([{ date: '2026-01-01T00:00:00Z', amount: 5 }], { width: 60, height: 20 }),
    ).toBeNull();
  });
});

describe('finding a company in the mailbox', () => {
  it('builds a narrow Gmail search from the name and domain', () => {
    expect(
      companySearchQuery({ id: '1', name: 'Maestra.io', domain: 'maestra.io', website: null }),
    ).toBe(
      'newer_than:365d -in:sent -in:chats -from:tiptop.vc -from:tiptopvc.com (subject:"Maestra.io" OR subject:"maestra" OR from:maestra.io OR from:maestra)',
    );
    expect(companySearchQuery({ id: '2', name: 'Fern "Hollow" (Inc)', domain: null })).toBe(
      'newer_than:365d -in:sent -in:chats -from:tiptop.vc -from:tiptopvc.com (subject:"Fern Hollow Inc" OR subject:"fern hollow" OR from:fernhollow)',
    );
    expect(companySearchQuery({ id: '3', name: '  ', domain: null })).toBeNull();
  });

  const companies = [
    { id: 'h', name: 'Hank', domain: null },
    { id: 'm', name: 'Maestra.io', domain: null },
  ];
  const meta = (from: string, subject: string) => ({
    id: 'a1',
    threadId: 'a1',
    from,
    to: 'nick@tiptop.vc',
    cc: '',
    subject,
    date: '2026-10-12T15:00:00Z',
    snippet: '',
    labelIds: ['INBOX'],
    bulk: false,
  });

  it("takes the company's own update and nobody else's", () => {
    const own = ['nick@tiptop.vc'];
    expect(
      screenForCompany(
        meta('Trevor <trevor@dialhank.com>', 'Hank Update: 63 locations, and Crawford said yes'),
        companies[0]!,
        companies,
        own,
      ),
    ).toBe(true);
    // Maestra's update is not Hank's.
    expect(
      screenForCompany(
        meta('Alex <alex@maestra.io>', "Maestra.io Q3'26: $5.4M ARR"),
        companies[0]!,
        companies,
        own,
      ),
    ).toBe(false);
    // A reply, a staff forward and a calendar invite are not updates.
    expect(
      screenForCompany(
        meta('Trevor <trevor@dialhank.com>', 'Re: Hank Update'),
        companies[0]!,
        companies,
        own,
      ),
    ).toBe(false);
    expect(
      screenForCompany(
        meta('Arwin <arwin@tiptop.vc>', 'Fwd: Hank Update: 63 locations'),
        companies[0]!,
        companies,
        own,
      ),
    ).toBe(false);
    expect(
      screenForCompany(
        meta('Trevor <trevor@dialhank.com>', 'Invitation: Hank update call @ Tue Oct 13'),
        companies[0]!,
        companies,
        own,
      ),
    ).toBe(false);
  });

  describe('a name in the subject alone', () => {
    const own = ['nick@tiptop.vc'];
    // Name and stage only, like the Sep 21 import.
    const nameOnly = [
      { id: 'q', name: 'Quillfeather', domain: null },
      { id: 'm', name: 'Maestra.io', domain: null },
      { id: 'f', name: 'Fernhollow Robotics', domain: null },
    ];
    const byId = (id: string) => nameOnly.find((c) => c.id === id)!;

    it.each([
      [
        'q',
        'Dana <dana@northwind.example>',
        'Northwind Q3 2026 update: we signed Quillfeather as a customer',
        false,
      ],
      [
        'q',
        'IR <ir@bigfund.example>',
        'Bigfund Q3 2026 LP update: Quillfeather raises Series A',
        true,
      ],
      ['m', 'Sam Recruits <sam@talentfirm.example>', 'Candidate update: VP Eng for Maestra', false],
      [
        'f',
        'Paralegal <docs@lawfirm.example>',
        'Fernhollow Robotics Update: signature pages',
        false,
      ],
    ] as const)('is not %s’s update: %s - %s', (id, from, subject, bulk) => {
      expect(screenForCompany({ ...meta(from, subject), bulk }, byId(id), nameOnly, own)).toBe(
        false,
      );
    });

    it('counts a founder on free mail whose subject leads with the name, never a list mail', () => {
      const m = meta('Ada Lin <ada.lin@gmail.com>', 'Fernhollow Robotics Q3 2026 update');
      expect(screenForCompany(m, byId('f'), nameOnly, own)).toBe(true);
      expect(screenForCompany({ ...m, bulk: true }, byId('f'), nameOnly, own)).toBe(false);
      expect(
        screenForCompany(
          {
            ...meta('Ada Lin <ada.lin@gmail.com>', 'Fernhollow Robotics Investor Update'),
            bulk: true,
          },
          byId('f'),
          nameOnly,
          own,
        ),
      ).toBe(false);
    });
  });
});
