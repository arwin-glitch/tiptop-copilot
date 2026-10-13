import { afterEach, describe, expect, it } from 'vitest';
import {
  addressesIn,
  classifyUpdateSubject,
  companyFromSubject,
  decideUpdate,
  decodeSnippet,
  digestedAt,
  digestIndex,
  domainLabel,
  historyKeyFor,
  historyQuery,
  isAutomatedSender,
  labelMatchesCompany,
  matchPortfolio,
  nameInSubject,
  nameMatchesSender,
  newestPerThread,
  parseSender,
  screenCandidate,
  type CandidateMessage,
  type CompanyLike,
  type CompanyUpdate,
} from '@/lib/company-updates/classify';
import {
  buildUpdatesQuery,
  readCompanyUpdates,
  resetCompanyUpdatesCache,
} from '@/lib/services/company-updates';
import { readPortfolioNumbers, resetPortfolioNumbersCache } from '@/lib/services/portfolio-numbers';
import type { DigestItem, DigestPost, UpdatePost } from '@/lib/updates/types';
import { createHarness, type Harness } from '../helpers/harness';

const OWN = ['nick@tiptop.vc', 'nick@tiptopvc.com', 'ntippman@gmail.com'];

const PORTFOLIO: CompanyLike[] = [
  { id: 'hank', name: 'Hank', domain: null },
  { id: 'maestra', name: 'Maestra.io', domain: null },
  { id: 'habu', name: 'Build HABU', domain: 'buildhabu.com' },
  { id: 'atlas', name: 'Atlas', domain: null },
  { id: 'fern', name: 'Fernhollow Robotics', domain: null },
];

let n = 0;
function message(patch: Partial<CandidateMessage>): CandidateMessage {
  n += 1;
  const id = `ab${n.toString(16).padStart(14, '0')}`;
  return {
    id,
    threadId: id,
    from: 'Someone <someone@example.com>',
    to: 'nick@tiptop.vc',
    cc: '',
    subject: 'Hello',
    date: '2026-10-12T15:00:00Z',
    snippet: '',
    labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    bulk: false,
    ...patch,
  };
}

describe('senders', () => {
  it('parses display names, bare addresses and mailto forms', () => {
    expect(parseSender('"Trevor Lang" <Trevor@DialHank.com>')).toEqual({
      name: 'Trevor Lang',
      address: 'trevor@dialhank.com',
      domain: 'dialhank.com',
    });
    expect(parseSender('alex@maestra.io')).toEqual({
      name: 'alex',
      address: 'alex@maestra.io',
      domain: 'maestra.io',
    });
    expect(parseSender('Ada <mailto:ada@fern.example>')?.address).toBe('ada@fern.example');
    expect(parseSender('Undisclosed recipients')).toBeNull();
  });

  it('lists every recipient address', () => {
    expect(addressesIn('Nick <Nick@TipTop.vc>, "B, C" <b@x.example>; d@y.example')).toEqual([
      'nick@tiptop.vc',
      'b@x.example',
      'd@y.example',
    ]);
  });

  it('spots notice senders and newsletter hosts', () => {
    expect(isAutomatedSender(parseSender('DocSend <no-reply@docsend.com>')!)).toBe(true);
    expect(isAutomatedSender(parseSender('Calendar <calendar-notification@google.com>')!)).toBe(
      true,
    );
    expect(isAutomatedSender(parseSender('Writer <writer@mail.substack.com>')!)).toBe(true);
    expect(isAutomatedSender(parseSender('Acme <notifications+abc@acme.example>')!)).toBe(true);
    expect(isAutomatedSender(parseSender('Acme Team <team@acme.example>')!)).toBe(false);
    expect(isAutomatedSender(parseSender('Acme <updates@acme.example>')!)).toBe(false);
  });
});

describe('update subjects', () => {
  it.each([
    ['Hank Update: 63 locations, and Crawford said yes', 'company'],
    ['Fwd: Hank Update: 63 locations, and Crawford said yes', 'company'],
    ["Maestra.io Q3'26: $5.4M ARR, profitable growth with a default-alive budget", 'periodic'],
    ['Maestra Q3 2026 results', 'periodic'],
    ['Acme Investor Update - October', 'investor'],
    ['Fernhollow LP Update #7', 'investor'],
    ['Monthly Update #14', 'periodic'],
    ['October Update', 'periodic'],
    ['Acme: $1.2M ARR and a new VP Sales', 'metrics'],
    ['Quillfeather Seed Round - Day 4', 'fundraise'],
    ['Fundraising update: 70% committed', 'fundraise'],
    ['Update from Hank', 'company'],
    ['Hank update for October', 'company'],
    ['Fernhollow Robotics Update October 2026', 'company'],
    ['Company update - September', 'company'],
  ])('%s reads as %s', (subject, kind) => {
    expect(classifyUpdateSubject(subject)?.kind).toBe(kind);
  });

  it('labels the period of a regular update', () => {
    expect(classifyUpdateSubject("Maestra.io Q3'26: $5.4M ARR")?.label).toBe('Quarterly update');
    expect(classifyUpdateSubject('Weekly founder update')?.label).toBe('Weekly update');
    expect(classifyUpdateSubject('Sept 2026 update')?.label).toBe('Monthly update');
  });

  it.each([
    'Re: Hank Update: 63 locations',
    'RE: [2] Monthly update',
    'Updated invitation: Hank update call @ Tue Oct 13, 2026 10am - 11am (CDT)',
    'Invitation: Maestra Q3 review @ Wed Oct 14, 2026',
    'Accepted: Hank update sync',
    'Product updates: new dashboards are here',
    'Notion product update',
    'Quick update on the HABU SAFE',
    'Status update: wire received',
    'We may update our privacy policy',
    'Q4 2026 board meeting prep',
    'Your weekly digest from Linkheap',
    'Join us for our Q3 2026 webinar',
    'Your order has shipped',
    'Hello from Atlas',
    'Market update: seed valuations in Q3',
    'Day 4 of the conference',
    'Hank updated the shared doc',
    'Hank update on the lease',
    '',
  ])('%s is not an update', (subject) => {
    expect(classifyUpdateSubject(subject)).toBeNull();
  });

  it('names the company a subject leads with', () => {
    expect(companyFromSubject('Hank Update: 63 locations, and Crawford said yes')).toBe('Hank');
    expect(companyFromSubject("Maestra.io Q3'26: $5.4M ARR")).toBe('Maestra.io');
    expect(companyFromSubject('Investor Update - Quillfeather (October)')).toBe('Quillfeather');
    expect(companyFromSubject('Update from Fernhollow Robotics')).toBe('Fernhollow Robotics');
    expect(companyFromSubject('Monthly Update #14')).toBeNull();
  });

  it.each([
    'Investor Update - October',
    'Investor Update | November',
    'Monthly Update: September 2026',
    'October Investor Update',
    'September Update',
    'Company Update - Highlights',
    'Q3 Update - 2026',
  ])('never takes a month or a generic word for the company: %s', (subject) => {
    expect(companyFromSubject(subject)).toBeNull();
  });

  it.each([
    "Q3'26 board consent - signature needed",
    'Q4 2026 SAFE docs for signature',
    'Hank - Q4 2026 SAFE side letter',
    'Q3 2026 pro rata notice',
    'Q3 2026 tax documents',
    'Q3 2026 K-1',
    'Hank Q3 2026 409A valuation',
    'Build HABU Q3 2026 K-1',
    'H2 2026 hiring plan',
    'Q4 2026 estimated taxes',
    'Q3 2026 capital call notice',
    'Hank Update: wire instructions',
    'Sydecar Update: funds received',
  ])('legal, tax, money and planning mail is not an update: %s', (subject) => {
    expect(classifyUpdateSubject(subject)).toBeNull();
  });

  it('still reads a quarter tag with an update word, and a SAFE round as a raise', () => {
    expect(classifyUpdateSubject('Hank Q3 2026 update')?.label).toBe('Quarterly update');
    expect(classifyUpdateSubject("Q3'26 results")?.label).toBe('Quarterly update');
    expect(classifyUpdateSubject('Ledgerly H1 2026 KPIs')?.label).toBe('Half-year update');
    expect(classifyUpdateSubject('SAFE round update: 80% committed')?.kind).toBe('fundraise');
  });

  it('carries the name of a bare "<Name> Update" so the sender can be checked', () => {
    expect(classifyUpdateSubject('Acme update - October')).toEqual({
      kind: 'company',
      label: 'Company update',
      named: 'Acme',
    });
    expect(classifyUpdateSubject('Company update - September')?.named).toBeUndefined();
  });
});

describe('portfolio matching', () => {
  const sender = (from: string) => parseSender(from)!;

  it('reads the registrable label of a domain', () => {
    expect(domainLabel('mail.maestra.io')).toBe('maestra');
    expect(domainLabel('dialhank.com')).toBe('dialhank');
    expect(domainLabel('fern.co.uk')).toBe('fern');
  });

  it('accepts the usual domain shapes for a company name', () => {
    expect(labelMatchesCompany('dialhank', 'hank')).toBe(true);
    expect(labelMatchesCompany('getmaestra', 'maestra')).toBe(true);
    expect(labelMatchesCompany('maestraai', 'maestra')).toBe(true);
    expect(labelMatchesCompany('hankfinance', 'hank')).toBe(false);
    expect(labelMatchesCompany('ab', 'ab')).toBe(false);
  });

  it('finds a name as whole words and says whether it leads', () => {
    expect(nameInSubject('Hank Update: 63 locations', 'Hank')).toBe('lead');
    expect(nameInSubject('Fwd: [Hank] October', 'Hank')).toBe('lead');
    expect(nameInSubject("Q3'26 from Maestra.io", 'Maestra.io')).toBe('anywhere');
    expect(nameInSubject('Thanksgiving plans', 'Hank')).toBeNull();
  });

  it('matches Hank by its domain and Maestra by name and domain', () => {
    expect(
      matchPortfolio(
        sender('Trevor <trevor@dialhank.com>'),
        'Hank Update: 63 locations',
        PORTFOLIO,
      ),
    ).toMatchObject({ company: { id: 'hank' }, by: 'domain' });
    expect(
      matchPortfolio(sender('Alex <alex@maestra.io>'), "Maestra.io Q3'26: $5.4M ARR", PORTFOLIO),
    ).toMatchObject({ company: { id: 'maestra' }, by: 'domain' });
    expect(
      matchPortfolio(sender('Bryan <bryan@buildhabu.com>'), 'Monthly update', PORTFOLIO),
    ).toMatchObject({ company: { id: 'habu' }, by: 'domain' });
  });

  it('trusts a long distinctive name in the subject, never a generic one', () => {
    expect(
      matchPortfolio(
        sender('Ada <ada@gmail.com>'),
        'Fernhollow Robotics investor update',
        PORTFOLIO,
      ),
    ).toMatchObject({ company: { id: 'fern' }, by: 'subject' });
    expect(
      matchPortfolio(sender('Pat <pat@other.example>'), 'Atlas monthly update', PORTFOLIO),
    ).toBeNull();
    expect(
      matchPortfolio(sender('Atlas Team <team@atlas.example>'), 'Atlas monthly update', PORTFOLIO),
    ).toMatchObject({ company: { id: 'atlas' }, by: 'domain' });
  });

  it('does not take a person called Hank for the company', () => {
    expect(
      matchPortfolio(sender('Hank Moody <hank@novelist.example>'), 'Monthly update', PORTFOLIO),
    ).toBeNull();
  });

  describe('a name in the subject alone', () => {
    // The Sep 21 import loaded name and stage only, so no portfolio domains.
    const nameOnly: CompanyLike[] = [
      { id: 'q', name: 'Quillfeather', domain: null },
      { id: 'm', name: 'Maestra.io', domain: null },
      { id: 'f', name: 'Fernhollow Robotics', domain: null },
    ];

    it.each([
      [
        'Dana <dana@northwind.example>',
        'Northwind Q3 2026 update: we signed Quillfeather as a customer',
      ],
      ['IR <ir@bigfund.example>', 'Bigfund Q3 2026 LP update: Quillfeather raises Series A'],
      ['Sam Recruits <sam@talentfirm.example>', 'Candidate update: VP Eng for Maestra'],
      ['Paralegal <docs@lawfirm.example>', 'Fernhollow Robotics Update: signature pages'],
    ])('is no match from %s: %s', (from, subject) => {
      expect(matchPortfolio(sender(from), subject, nameOnly)).toBeNull();
    });

    it('is a weak match when it leads and the sender is on free mail or the company’s own-looking domain', () => {
      expect(
        matchPortfolio(sender('Ada <ada.lin@gmail.com>'), 'Fernhollow Robotics update', nameOnly),
      ).toMatchObject({ company: { id: 'f' }, by: 'subject' });
      expect(
        matchPortfolio(
          sender('Ada <ada@fernhollow.example>'),
          'Fernhollow Robotics Q3 2026 update',
          nameOnly,
        ),
      ).toMatchObject({ company: { id: 'f' }, by: 'subject' });
      expect(
        matchPortfolio(
          sender('Ada <ada.lin@gmail.com>'),
          'Our update: Fernhollow Robotics',
          nameOnly,
        ),
      ).toBeNull();
    });
  });

  it('knows when a name is the sender’s own company', () => {
    expect(nameMatchesSender('Acme', sender('Jane <jane@acme.example>'))).toBe(true);
    expect(nameMatchesSender('Hank', sender('Trevor <trevor@dialhank.com>'))).toBe(true);
    expect(nameMatchesSender('Acme', sender('Jane at Acme <jane.doe@gmail.com>'))).toBe(true);
    expect(nameMatchesSender('Acme', sender('Acme Team <news@mailer.example>'))).toBe(true);
    expect(nameMatchesSender('Acme', sender('Jane Doe (Acme) <jane.doe@gmail.com>'))).toBe(true);
    expect(nameMatchesSender('Acme', sender('Jane Doe <jane.doe@gmail.com>'))).toBe(false);
    expect(nameMatchesSender('Lease', sender('Broker <b@cityleasing.example>'))).toBe(false);
    expect(nameMatchesSender('October', sender('Priya <priya@quill.example>'))).toBe(false);
  });

  it('gives up when two companies match equally', () => {
    const twins: CompanyLike[] = [
      { id: 'a', name: 'Quillfeather', domain: null },
      { id: 'b', name: 'Fernhollow', domain: null },
    ];
    expect(
      matchPortfolio(
        sender('X <x@news.example>'),
        'Quillfeather and Fernhollow investor update',
        twins,
      ),
    ).toBeNull();
  });
});

describe('screening and trust', () => {
  const ctx = { own: OWN, companies: PORTFOLIO };

  it('keeps a bcc’d portfolio update from the Personal tab', () => {
    const s = screenCandidate(
      message({
        from: 'Trevor Lang <trevor@dialhank.com>',
        to: 'investors@dialhank.com',
        subject: 'Hank Update: 63 locations, and Crawford said yes',
        snippet: 'We&#39;re live in 63 locations &amp; Crawford said yes.',
      }),
      ctx,
    );
    expect(s?.bcc).toBe(true);
    expect(s?.historyKey).toBeNull();
    const update = decideUpdate(s!, false);
    expect(update).toMatchObject({
      company: 'Hank',
      companyId: 'hank',
      reason: 'portfolio',
      kindLabel: 'Company update',
      snippet: "We're live in 63 locations & Crawford said yes.",
    });
  });

  it('needs Sent-mail history for anyone outside the portfolio', () => {
    const s = screenCandidate(
      message({
        from: 'Priya <priya@quillfeather.example>',
        subject: 'Quillfeather Investor Update - October',
      }),
      ctx,
    );
    expect(s?.historyKey).toBe('quillfeather.example');
    expect(decideUpdate(s!, false)).toBeNull();
    expect(decideUpdate(s!, true)).toMatchObject({ reason: 'emailed', company: 'Quillfeather' });
  });

  it('drops mail from Nick, from TipTop staff and from notice senders', () => {
    for (const from of [
      'Nick <nick@tiptop.vc>',
      'Nick <ntippman@gmail.com>',
      'Arwin <arwin@tiptop.vc>',
      'DocSend <no-reply@docsend.com>',
    ]) {
      expect(
        screenCandidate(message({ from, subject: 'Hank Update: 63 locations' }), ctx),
        from,
      ).toBeNull();
    }
  });

  it('drops newsletters and promotions unless the company itself sent them', () => {
    expect(
      screenCandidate(
        message({
          from: 'Fund News <hello@bigfund.example>',
          subject: 'Monthly update',
          bulk: true,
        }),
        ctx,
      ),
    ).toBeNull();
    expect(
      screenCandidate(
        message({
          from: 'Trevor <trevor@dialhank.com>',
          subject: 'Hank Update: October',
          bulk: true,
          labelIds: ['CATEGORY_PROMOTIONS'],
        }),
        ctx,
      ),
    ).not.toBeNull();
    // A list mail that only names the company in its subject is not its update.
    expect(
      screenCandidate(
        message({
          from: 'Robot News <editor@robots.example>',
          subject: 'Fernhollow Robotics monthly update',
          bulk: true,
        }),
        ctx,
      ),
    ).toBeNull();
    // An explicit investor update through a mailing tool is fine from someone Nick knows.
    expect(
      screenCandidate(
        message({
          from: 'Priya <priya@quillfeather.example>',
          subject: 'Quillfeather Investor Update',
          bulk: true,
        }),
        ctx,
      )?.historyKey,
    ).toBe('quillfeather.example');
  });

  it('makes a subject-only portfolio match prove itself in Sent mail', () => {
    const s = screenCandidate(
      message({
        from: 'Ada Lin <ada.lin@gmail.com>',
        subject: 'Fernhollow Robotics investor update',
      }),
      ctx,
    );
    expect(s?.match?.by).toBe('subject');
    expect(s?.historyKey).toBe('ada.lin@gmail.com');
    expect(decideUpdate(s!, false)).toBeNull();
    expect(decideUpdate(s!, true)).toMatchObject({
      company: 'Fernhollow Robotics',
      companyId: null,
      reason: 'emailed',
    });
  });

  it('never files other people’s mail under a portfolio company it merely names', () => {
    const companies: CompanyLike[] = [
      { id: 'q', name: 'Quillfeather', domain: null },
      { id: 'm', name: 'Maestra.io', domain: null },
      { id: 'f', name: 'Fernhollow Robotics', domain: null },
    ];
    const decide = (patch: Partial<CandidateMessage>) => {
      const s = screenCandidate(message(patch), { own: OWN, companies });
      return s ? decideUpdate(s, true) : null;
    };
    // Northwind's own update, shown as Northwind's because Nick has emailed them.
    expect(
      decide({
        from: 'Dana <dana@northwind.example>',
        subject: 'Northwind Q3 2026 update: we signed Quillfeather as a customer',
      }),
    ).toMatchObject({ company: 'Northwind', companyId: null, reason: 'emailed' });
    expect(
      decide({
        from: 'IR <ir@bigfund.example>',
        subject: 'Bigfund Q3 2026 LP update: Quillfeather raises Series A',
        bulk: true,
      }),
    ).toMatchObject({ company: 'Bigfund', reason: 'emailed', kindLabel: 'Investor update' });
    expect(
      decide({
        from: 'Sam Recruits <sam@talentfirm.example>',
        subject: 'Candidate update: VP Eng for Maestra',
      }),
    ).toBeNull();
    expect(
      decide({
        from: 'Paralegal <docs@lawfirm.example>',
        subject: 'Fernhollow Robotics Update: signature pages',
      }),
    ).toBeNull();
  });

  it.each([
    ['Mom <mom.lang@gmail.com>', 'Baby Update!'],
    ['Old Friend <pal.lang@gmail.com>', 'Life Update: moving to Austin'],
    ['Broker <b@cityleasing.example>', 'Lease Update: signed'],
    ['Jane <jane@sydecar.io>', 'Sydecar Update: funds received'],
    ['Sam Recruits <sam@talentfirm.example>', 'Candidate Update - Jane Doe'],
    ['CPA <cpa@ledgerworks.example>', 'Q4 2026 estimated taxes'],
  ])(
    'a person Nick has emailed is not a founder update just for saying "Update": %s',
    (from, subject) => {
      const s = screenCandidate(message({ from, subject }), ctx);
      expect(s ? decideUpdate(s, true) : null).toBeNull();
    },
  );

  it('accepts a bare "<Name> Update" when the name is the sender’s company', () => {
    const decide = (from: string) => {
      const s = screenCandidate(message({ from, subject: 'Acme update - October' }), ctx);
      return s ? decideUpdate(s, true) : null;
    };
    expect(decide('Jane <jane@acme.example>')).toMatchObject({
      company: 'Acme',
      reason: 'emailed',
    });
    expect(decide('Jane at Acme <jane.doe@gmail.com>')).toMatchObject({ company: 'Acme' });
    expect(decide('Jane Doe <jane.doe@gmail.com>')).toBeNull();
  });

  it('heads a row with the sender, not a month or a name the sender doesn’t own', () => {
    const decide = (from: string, subject: string) => {
      const s = screenCandidate(message({ from, subject }), ctx);
      return s ? decideUpdate(s, true) : null;
    };
    expect(decide('Priya Natarajan <priya@gmail.com>', 'Investor Update - October')).toMatchObject({
      company: null,
      sender: 'Priya Natarajan',
    });
    expect(
      decide('Priya Natarajan <priya@gmail.com>', 'Investor Update - Quillfeather (October)'),
    ).toMatchObject({ company: null, sender: 'Priya Natarajan' });
  });

  it('looks history up by domain for company mail and by address for free mail', () => {
    expect(historyKeyFor(parseSender('a@quill.example')!)).toBe('quill.example');
    expect(historyKeyFor(parseSender('a.founder@gmail.com')!)).toBe('a.founder@gmail.com');
    expect(historyQuery('quill.example')).toBe('in:sent to:quill.example');
    expect(historyQuery('x" OR from:me')).toBeNull();
  });

  it('decodes Gmail snippets', () => {
    expect(decodeSnippet('ARR &gt; $1M &amp; &quot;default alive&quot; &#8212; done&#x21;')).toBe(
      'ARR > $1M & "default alive" — done!',
    );
  });

  it('keeps the newest update per thread', () => {
    const u = (threadId: string, receivedAt: string, messageId = receivedAt) =>
      ({ threadId, receivedAt, messageId }) as CompanyUpdate;
    expect(
      newestPerThread([
        u('t1', '2026-10-01T00:00:00Z'),
        u('t1', '2026-10-05T00:00:00Z'),
        u('t2', '2026-10-03T00:00:00Z'),
      ]).map((x) => x.receivedAt),
    ).toEqual(['2026-10-05T00:00:00Z', '2026-10-03T00:00:00Z']);
  });
});

describe('the Slack digest marker', () => {
  const item = (href: string): DigestItem => ({
    title: 'Hank',
    detail: null,
    cadence: null,
    newsletter: false,
    locked: false,
    lockNote: null,
    repost: null,
    meta: [],
    groups: [],
    links: [{ label: 'Open in Gmail', href }],
    needsAttention: false,
  });
  const run = (postedAt: string, hrefs: string[]): UpdatePost =>
    ({ type: 'digest', postedAt, items: hrefs.map(item) }) as unknown as DigestPost;

  it('maps each linked Gmail id to the newest run that carried it', () => {
    const index = digestIndex({
      sources: [
        {
          posts: [
            run('2026-10-09T18:00:00Z', [
              'https://mail.google.com/mail/?authuser=demo@example.com#all/19a0f00000000001',
            ]),
            run('2026-10-12T18:00:00Z', [
              'https://mail.google.com/mail/?authuser=demo@example.com#all/19A0F00000000001',
              'https://mail.google.com/mail/u/0/#inbox/19a0f00000000002',
            ]),
            { type: 'other', postedAt: '2026-10-13T00:00:00Z' } as UpdatePost,
          ],
        },
      ],
    });
    expect(index.get('19a0f00000000001')).toBe('2026-10-12T18:00:00Z');
    expect(digestedAt({ messageId: 'zz', threadId: '19a0f00000000002' }, index)).toBe(
      '2026-10-12T18:00:00Z',
    );
    expect(
      digestedAt({ messageId: '19a0f0000000000f', threadId: '19a0f0000000000f' }, index),
    ).toBeNull();
    expect(digestIndex(null).size).toBe(0);
  });
});

describe('the Gmail search', () => {
  it('leaves out sent mail, staff and notice senders, and adds portfolio names and domains', () => {
    const q = buildUpdatesQuery([
      { id: '1', name: 'Hank', domain: 'dialhank.com' },
      { id: '2', name: 'Maestra "io"', domain: null, website: 'https://www.maestra.io/about' },
    ]);
    expect(
      q.startsWith('newer_than:30d -in:sent -in:chats -from:tiptop.vc -from:tiptopvc.com'),
    ).toBe(true);
    expect(q).toContain('-from:docsend.com');
    expect(q).toContain('subject:("Hank" OR "Maestra io")');
    expect(q).toContain('from:(dialhank.com OR maestra.io)');
    expect(q).toContain('-category:promotions');
  });
});

describe('demo mode', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    resetCompanyUpdatesCache();
    resetPortfolioNumbersCache();
    await harness?.dispose();
    harness = null;
  });

  it('shows fictional updates through the real classifier', async () => {
    harness = await createHarness();
    const result = await readCompanyUpdates(harness.store, harness.auth.organizationId);
    expect(result.state).toBe('ok');
    const byCompany = result.updates.map((u) => [u.company, u.reason]);
    expect(byCompany).toEqual([
      ['Ledgerly', 'portfolio'],
      ['Stonebridge Ops', 'portfolio'],
      ['Cobalt Orchard', 'emailed'],
      ['Quillfeather', 'emailed'],
    ]);
    // The DocSend notice and the cold note never make it.
    expect(result.updates.some((u) => /docsend|Tidewell/i.test(u.subject))).toBe(false);
  });

  it('reads fictional numbers for the demo portfolio', async () => {
    harness = await createHarness();
    const companies = (await harness.store.list(
      'portfolio_companies',
      harness.auth.organizationId,
      {
        eq: { is_archived: false },
      },
    )) as CompanyLike[];
    const result = await readPortfolioNumbers(
      harness.store,
      harness.auth.organizationId,
      companies,
    );
    expect(result.state).toBe('ok');
    expect(result.checked).toBe(companies.length);
    const ledgerly = result.companies.find((c) => c.name === 'Ledgerly');
    expect(ledgerly?.revenue?.value.display).toBe('$780K');
    expect(ledgerly?.history.map((p) => p.amount)).toEqual([520_000, 610_000, 700_000, 780_000]);
    expect(ledgerly?.runway?.value.label).toBe('14 months');
    expect(ledgerly?.growth?.value.label).toBe('+96% YoY');
    expect(ledgerly?.raising?.value.label).toBe(
      'preparing to launch our Series A in about eight weeks',
    );
    const stonebridge = result.companies.find((c) => c.name === 'Stonebridge Ops');
    expect(stonebridge?.revenue?.value.display).toBe('$215K');
    expect(stonebridge?.cash?.value.display).toBe('$1.4M');
    expect(stonebridge?.runway?.value.label).toBe('into Mar 2028');
  });
});
