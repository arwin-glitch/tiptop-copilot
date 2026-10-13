import { describe, expect, it } from 'vitest';
import type { DataStore } from '@/lib/db/store';
import {
  buildWarmPaths,
  demoWarmPaths,
  findWarmPaths,
  firmMatchesDomain,
  inferFirmDomain,
  isBulkAddress,
  isPersonalDomain,
  parseParticipants,
  parseWarmPathsQuery,
  registrableDomain,
  searchableFirm,
  targetFromEmail,
  targetFromParticipants,
  targetQuery,
  toParsedThread,
  warmContext,
  type ParsedThread,
  type WarmTarget,
} from '@/lib/services/warm-paths';

const NOW = new Date('2026-10-13T16:00:00Z');
const CTX = warmContext('nick@tiptop.vc');

/** A thread built from raw From / To / Cc headers, one entry per message. All fictional. */
const mail = (
  id: string,
  lastAt: string,
  messages: [from: string, to: string, cc?: string][],
): ParsedThread =>
  toParsedThread({
    id,
    subject: `Subject ${id}`,
    messages: messages.map(([from, to, cc = '']) => ({ from, to, cc, at: lastAt })),
  });

describe('parseParticipants', () => {
  it('reads names and addresses, including quoted names with commas', () => {
    expect(
      parseParticipants(
        'Jane Doe <Jane@Harbor.example>, "Roe, Rick" <rick@birch.example>, c@d.example',
      ),
    ).toEqual([
      { email: 'jane@harbor.example', name: 'Jane Doe' },
      { email: 'rick@birch.example', name: 'Rick Roe' },
      { email: 'c@d.example', name: null },
    ]);
  });

  it('keeps a quoted name with several commas as written', () => {
    expect(parseParticipants('"Smith, Jr., Bob" <bob@x.example>')).toEqual([
      { email: 'bob@x.example', name: 'Smith, Jr., Bob' },
    ]);
  });

  it('handles angle brackets and escaped quotes inside a quoted name', () => {
    expect(parseParticipants('"Jane <CEO>" <jane@x.example>')).toEqual([
      { email: 'jane@x.example', name: 'Jane <CEO>' },
    ]);
    expect(parseParticipants('"Jane \\"JJ\\" Doe" <jane@x.example>')).toEqual([
      { email: 'jane@x.example', name: 'Jane "JJ" Doe' },
    ]);
  });

  it('handles group syntax, comments and semicolons', () => {
    expect(parseParticipants('undisclosed-recipients:;')).toEqual([]);
    expect(parseParticipants('Team: a@x.example, b@y.example;')).toEqual([
      { email: 'a@x.example', name: null },
      { email: 'b@y.example', name: null },
    ]);
    expect(parseParticipants('ann@z.example (Ann Lee); mailto:bo@z.example')).toEqual([
      { email: 'ann@z.example', name: 'Ann Lee' },
      { email: 'bo@z.example', name: null },
    ]);
  });

  it('drops junk, duplicates and names that are just the address', () => {
    expect(parseParticipants('not an address, <broken>, @x.example')).toEqual([]);
    expect(parseParticipants('a@x.example, A@X.example')).toEqual([
      { email: 'a@x.example', name: null },
    ]);
    expect(parseParticipants('"jane@x.example" <jane@x.example>')).toEqual([
      { email: 'jane@x.example', name: null },
    ]);
    expect(parseParticipants('')).toEqual([]);
    expect(parseParticipants(null)).toEqual([]);
  });
});

describe('domains and addresses', () => {
  it('finds the registrable domain', () => {
    expect(registrableDomain('mail.harbor.co.uk')).toBe('harbor.co.uk');
    expect(registrableDomain('eu.harbor.com')).toBe('harbor.com');
    expect(registrableDomain('harbor.com')).toBe('harbor.com');
    expect(registrableDomain('Harbor.Com.')).toBe('harbor.com');
  });

  it('knows personal mail', () => {
    expect(isPersonalDomain('gmail.com')).toBe(true);
    expect(isPersonalDomain('comcast.net')).toBe(true);
    expect(isPersonalDomain('yahoo.co.uk')).toBe(true);
    expect(isPersonalDomain('harborlp.example')).toBe(false);
  });

  it('tells machines and role inboxes from people', () => {
    expect(isBulkAddress('no-reply@docsend.com')).toBe(true);
    expect(isBulkAddress('calendar-notification@google.com')).toBe(true);
    expect(isBulkAddress('notifications+abc@x.example')).toBe(true);
    expect(isBulkAddress('jane@reply.x.example')).toBe(true);
    expect(isBulkAddress('msprvs1=abc@bounces.x.example')).toBe(true);
    expect(isBulkAddress('hello@startup.example')).toBe(true);
    expect(isBulkAddress('pat@zoom.us')).toBe(true);
    expect(isBulkAddress('priya@harborlp.example')).toBe(false);
    expect(isBulkAddress('infosec@harborlp.example')).toBe(false);
    expect(isBulkAddress('alfred@harborlp.example')).toBe(false);
  });

  it('counts Nick, the mailbox and TipTop as our own side', () => {
    expect(CTX.ownAddresses).toEqual(
      expect.arrayContaining(['nick@tiptop.vc', 'nick@tiptopvc.com', 'ntippman@gmail.com']),
    );
    expect(CTX.ownDomains).toEqual(expect.arrayContaining(['tiptop.vc', 'tiptopvc.com']));
    // A personal mailbox never makes all of gmail.com "ours".
    expect(warmContext('ntippman@gmail.com').ownDomains).not.toContain('gmail.com');
  });
});

describe('targets', () => {
  it('uses the firm domain for a work address and the exact address for personal mail', () => {
    expect(targetFromEmail('Priya@mail.HarborLP.example')).toEqual({
      kind: 'domain',
      label: 'harborlp.example',
      domains: ['harborlp.example'],
      addresses: [],
    });
    expect(targetFromEmail('sam.okafor@gmail.com')).toEqual({
      kind: 'person',
      label: 'sam.okafor@gmail.com',
      domains: [],
      addresses: ['sam.okafor@gmail.com'],
    });
    expect(targetFromEmail('jo@comcast.net').kind).toBe('person');
  });

  it('matches firm names to their domains without loose guesses', () => {
    expect(firmMatchesDomain('Lakeside Family Office', 'lakesidefo.example')).toBe(true);
    expect(firmMatchesDomain('Lakeside Family Office', 'lakeside-family-office.example')).toBe(
      true,
    );
    expect(firmMatchesDomain('Lakeside Family Office', 'mail.lakeside.example')).toBe(true);
    expect(firmMatchesDomain('Northwind Capital', 'northwindcap.example')).toBe(true);
    expect(firmMatchesDomain('Brightline FoF', 'brightlinefof.example')).toBe(true);
    expect(firmMatchesDomain('Crème Capital', 'creme.example')).toBe(true);
    expect(firmMatchesDomain('AXA Ventures', 'axa.example')).toBe(true);
    // Leftovers that are not a firm suffix are a different company.
    expect(firmMatchesDomain('Accel', 'accelerator.example')).toBe(false);
    expect(firmMatchesDomain('Harbor', 'harborfreight.example')).toBe(false);
    // Short names only match exactly.
    expect(firmMatchesDomain('AXA Ventures', 'axagroup.example')).toBe(false);
    expect(firmMatchesDomain('Northwind Capital', 'gmail.com')).toBe(false);
  });

  const onThread = [
    { email: 'nick@tiptop.vc', name: 'Nick' },
    { email: 'arwin@tiptop.vc', name: 'Arwin' },
    { email: 'grace@lakesidefo.example', name: 'Grace Okafor' },
    { email: 'ivy@northwindcap.example', name: 'Ivy Chen' },
    { email: 'no-reply@docsend.com', name: 'DocSend' },
    { email: 'marco@gmail.com', name: 'Marco Ruiz' },
  ];

  it('picks the LP firm off a thread when the firm name is known', () => {
    expect(targetFromParticipants(onThread, CTX, 'Lakeside Family Office')).toEqual({
      kind: 'found',
      target: {
        kind: 'domain',
        label: 'Lakeside Family Office',
        domains: ['lakesidefo.example'],
        addresses: [],
      },
    });
  });

  it('without a firm, several outside parties are unclear and never merged into one target', () => {
    expect(targetFromParticipants(onThread, CTX)).toEqual({
      kind: 'unclear',
      seen: ['lakesidefo.example', 'northwindcap.example', 'marco@gmail.com'],
      people: [
        { email: 'grace@lakesidefo.example', name: 'Grace Okafor' },
        { email: 'ivy@northwindcap.example', name: 'Ivy Chen' },
        { email: 'marco@gmail.com', name: 'Marco Ruiz' },
      ],
    });
  });

  it('a firm hint that matches nothing on the thread is never used to label other firms', () => {
    const found = targetFromParticipants(onThread, CTX, 'Alder Endowment');
    expect(found.kind).toBe('unclear');
  });

  it('an intro thread: the introducer is never taken for the LP', () => {
    // The LP uses Gmail; the introducer is the only corporate address.
    const intro = [
      { email: 'bob@introfirm.example', name: 'Bob Reyes' },
      { email: 'nick@tiptop.vc', name: 'Nick' },
      { email: 'jane.harbor@gmail.com', name: 'Jane' },
    ];
    expect(targetFromParticipants(intro, CTX, 'Harbor Family Office')).toEqual({
      kind: 'unclear',
      seen: ['introfirm.example', 'jane.harbor@gmail.com'],
      people: [
        { email: 'bob@introfirm.example', name: 'Bob Reyes' },
        { email: 'jane.harbor@gmail.com', name: 'Jane' },
      ],
    });
    // An opaque firm domain ("trust" is not a firm suffix) is no match either.
    const alder = [
      { email: 'nick@tiptop.vc', name: 'Nick' },
      { email: 'ivy@northwindcap.example', name: 'Ivy Chen' },
      { email: 'lena@aldertrust.example', name: 'Lena Fischer' },
    ];
    expect(targetFromParticipants(alder, CTX, 'Alder Endowment').kind).toBe('unclear');
    expect(targetFromParticipants(alder, CTX).kind).toBe('unclear');
  });

  it('one outside party is the target, labelled by its own domain, not an unmatched firm', () => {
    const solo = [
      { email: 'nick@tiptop.vc', name: 'Nick' },
      { email: 'jane@hfo.example', name: 'Jane Doe' },
      { email: 'omar@mail.hfo.example', name: 'Omar' },
      { email: 'no-reply@docsend.com', name: 'DocSend' },
    ];
    const expected = {
      kind: 'found',
      target: { kind: 'domain', label: 'hfo.example', domains: ['hfo.example'], addresses: [] },
    };
    expect(targetFromParticipants(solo, CTX, 'Harbor Family Office')).toEqual(expected);
    expect(targetFromParticipants(solo, CTX)).toEqual(expected);
  });

  it('returns nobody when only TipTop and machines are on the thread', () => {
    expect(targetFromParticipants(onThread.slice(0, 2).concat(onThread[4]!), CTX)).toEqual({
      kind: 'nobody',
    });
    // An address that is unsafe to search for is never used.
    expect(targetFromParticipants([{ email: "o'neil@gmail.com", name: null }], CTX)).toEqual({
      kind: 'nobody',
    });
  });

  it('a single personal address is a person target', () => {
    expect(targetFromParticipants([{ email: 'sam@gmail.com', name: 'Sam' }], CTX)).toEqual({
      kind: 'found',
      target: {
        kind: 'person',
        label: 'sam@gmail.com',
        domains: [],
        addresses: ['sam@gmail.com'],
      },
    });
  });

  it('builds one Gmail search over every domain and address', () => {
    expect(
      targetQuery({
        kind: 'domain',
        label: 'x',
        domains: ['harborlp.example'],
        addresses: ['sam@gmail.com'],
      }),
    ).toBe(
      '{from:harborlp.example to:harborlp.example cc:harborlp.example from:sam@gmail.com to:sam@gmail.com cc:sam@gmail.com} newer_than:3y',
    );
  });
});

describe('inferFirmDomain', () => {
  const firm = 'Lakeside Family Office';

  it('is confident when one matching domain clearly leads', () => {
    const threads = [
      mail('a1', '2026-09-01T00:00:00Z', [['grace@lakesidefo.example', 'nick@tiptop.vc']]),
      mail('a2', '2026-08-01T00:00:00Z', [['omar@lakesidefo.example', 'nick@tiptop.vc']]),
      // Nick writing to them counts too.
      mail('a3', '2026-07-01T00:00:00Z', [['nick@tiptop.vc', 'grace@lakesidefo.example']]),
      mail('a4', '2026-06-01T00:00:00Z', [['tom@lakeside.example', 'arwin@tiptop.vc']]),
    ];
    expect(inferFirmDomain(firm, threads, CTX)).toEqual({
      domain: 'lakesidefo.example',
      candidates: ['lakesidefo.example', 'lakeside.example'],
    });
  });

  it('says it is unsure on a close call instead of guessing', () => {
    const threads = [
      mail('b1', '2026-09-01T00:00:00Z', [['grace@lakesidefo.example', 'nick@tiptop.vc']]),
      mail('b2', '2026-08-01T00:00:00Z', [['tom@lakeside.example', 'nick@tiptop.vc']]),
    ];
    expect(inferFirmDomain(firm, threads, CTX)).toEqual({
      domain: null,
      candidates: ['lakeside.example', 'lakesidefo.example'],
    });
  });

  it('only counts direct mail with Nick or TipTop, never BCC letters, personal mail or TipTop', () => {
    const threads = [
      // A BCC'd quarterly letter: Nick is not on the headers.
      mail('c1', '2026-09-01T00:00:00Z', [
        ['Grace Okafor <grace@lakesidefo.example>', 'undisclosed-recipients:;'],
      ]),
      // Mail inside the firm that Nick was BCC'd on.
      mail('c2', '2026-08-01T00:00:00Z', [['grace@lakesidefo.example', 'omar@lakesidefo.example']]),
      mail('c3', '2026-07-01T00:00:00Z', [['lakeside@gmail.com', 'nick@tiptop.vc']]),
    ];
    expect(inferFirmDomain(firm, threads, CTX)).toEqual({ domain: null, candidates: [] });
    // One one-way email is never enough to name a firm's domain.
    expect(
      inferFirmDomain(
        'Harbor',
        [
          mail('c4', '2026-09-01T00:00:00Z', [
            ['Jane Doe <jane@harbor.example>', 'undisclosed-recipients:;'],
          ]),
        ],
        CTX,
      ).domain,
    ).toBeNull();
  });
});

describe('toParsedThread', () => {
  it('merges From, To and Cc across messages, keeps each message, and keeps the first known name', () => {
    expect(
      toParsedThread({
        id: 'd0d0d0d0d0d0',
        subject: 'Fund II',
        messages: [
          {
            from: 'grace@lakesidefo.example',
            to: 'Nick Tippman <nick@tiptop.vc>',
            cc: '',
            at: '2026-09-01T10:00:00.000Z',
          },
          {
            from: 'Nick Tippman <nick@tiptop.vc>',
            to: 'Grace Okafor <grace@lakesidefo.example>',
            cc: 'Dana Whitfield <dana@birchlane.example>',
            at: '2026-09-03T10:00:00.000Z',
          },
          { from: '', to: '', cc: '', at: null },
        ],
      }),
    ).toEqual({
      id: 'd0d0d0d0d0d0',
      subject: 'Fund II',
      lastAt: '2026-09-03T10:00:00.000Z',
      participants: [
        { email: 'grace@lakesidefo.example', name: 'Grace Okafor' },
        { email: 'nick@tiptop.vc', name: 'Nick Tippman' },
        { email: 'dana@birchlane.example', name: 'Dana Whitfield' },
      ],
      // The empty message is dropped.
      messages: [
        { from: ['grace@lakesidefo.example'], recipients: ['nick@tiptop.vc'] },
        {
          from: ['nick@tiptop.vc'],
          recipients: ['grace@lakesidefo.example', 'dana@birchlane.example'],
        },
      ],
    });
  });
});

describe('buildWarmPaths', () => {
  const target: WarmTarget = {
    kind: 'domain',
    label: 'Lakeside Family Office',
    domains: ['lakesidefo.example'],
    addresses: [],
  };
  const crowd = Array.from({ length: 14 }, (_, i) => `guest${i}@summit.example`).join(', ');
  const threads = [
    mail('e1', '2026-09-01T00:00:00Z', [
      [
        'Grace Okafor <grace@lakesidefo.example>',
        'Nick <nick@tiptop.vc>, Dana Whitfield <dana@birchlane.example>',
        'Arwin <arwin@tiptop.vc>',
      ],
    ]),
    // Dana's intro, Grace's reply (Omar copied), then Nick writes to Omar too.
    mail('e2', '2026-06-01T00:00:00Z', [
      ['dana@birchlane.example', 'nick@tiptop.vc, grace@lakesidefo.example'],
      [
        'grace@lakesidefo.example',
        'nick@tiptop.vc, dana@birchlane.example',
        'Omar Haddad <omar@lakesidefo.example>',
      ],
      ['nick@tiptop.vc', 'grace@lakesidefo.example, omar@lakesidefo.example'],
    ]),
    mail('e3', '2026-03-01T00:00:00Z', [
      [
        'Marco Ruiz <marco@gmail.com>',
        'grace@lakesidefo.example, nick@tiptopvc.com',
        'calendar-notification@google.com',
      ],
      ['grace@lakesidefo.example', 'marco@gmail.com, nick@tiptopvc.com'],
    ]),
    // A mass email: left out of both lists.
    mail('e4', '2026-09-05T00:00:00Z', [['grace@lakesidefo.example', `nick@tiptop.vc, ${crowd}`]]),
    // Search noise: nobody from the firm on it.
    mail('e5', '2026-09-06T00:00:00Z', [['someone@else.example', 'nick@tiptop.vc']]),
    // The same thread twice counts once.
    mail('e1', '2026-09-01T00:00:00Z', [
      ['Grace Okafor <grace@lakesidefo.example>', 'Dana Whitfield <dana@birchlane.example>'],
    ]),
  ];

  it('lists who Nick knows at the firm and who could introduce him', () => {
    const built = buildWarmPaths(threads, target, CTX);
    expect(built.used).toBe(3);
    expect(built.groupSkipped).toBe(1);
    expect(built.known.map((p) => [p.email, p.threads, p.threadId, p.name])).toEqual([
      ['grace@lakesidefo.example', 3, 'e1', 'Grace Okafor'],
      ['omar@lakesidefo.example', 1, 'e2', 'Omar Haddad'],
    ]);
    expect(built.introducers.map((p) => [p.email, p.threads, p.threadId, p.name])).toEqual([
      ['dana@birchlane.example', 2, 'e1', 'Dana Whitfield'],
      ['marco@gmail.com', 1, 'e3', 'Marco Ruiz'],
    ]);
    expect(built.introducers[0]!.lastAt).toBe('2026-09-01T00:00:00Z');
  });

  it('never offers Nick, TipTop staff, machines or the firm itself as an intro', () => {
    const emails = buildWarmPaths(threads, target, CTX).introducers.map((p) => p.email);
    for (const own of ['nick@tiptop.vc', 'nick@tiptopvc.com', 'arwin@tiptop.vc']) {
      expect(emails).not.toContain(own);
    }
    expect(emails).not.toContain('calendar-notification@google.com');
    expect(emails.some((e) => e.endsWith('@lakesidefo.example'))).toBe(false);
    expect(emails.some((e) => e.endsWith('@summit.example'))).toBe(false);
  });

  it('does not count people from a group email (an event invite) as intro paths', () => {
    const golf = mail('g1', '2026-09-20T00:00:00Z', [
      [
        'host@events.example',
        'grace@lakesidefo.example, nick@tiptop.vc, a@one.example, b@two.example, c@three.example, d@four.example, e@five.example',
      ],
    ]);
    const intro = buildWarmPaths([golf], target, CTX).introducers.map((p) => p.email);
    expect(intro).toEqual([]);
  });

  it('ranks by shared threads, then recency, and keeps the top five', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      mail(`f${i}`, `2026-0${i + 1}-01T00:00:00Z`, [
        ['grace@lakesidefo.example', `friend${i}@club.example, nick@tiptop.vc`],
      ]),
    );
    many.push(
      mail('f9', '2025-01-01T00:00:00Z', [
        ['grace@lakesidefo.example', 'friend0@club.example, nick@tiptop.vc'],
      ]),
    );
    const intro = buildWarmPaths(many, target, CTX).introducers.map((p) => p.email);
    expect(intro).toEqual([
      'friend0@club.example',
      'friend6@club.example',
      'friend5@club.example',
      'friend4@club.example',
      'friend3@club.example',
    ]);
  });

  it('for a personal address, other gmail users can still introduce', () => {
    const person: WarmTarget = {
      kind: 'person',
      label: 'sam@gmail.com',
      domains: [],
      addresses: ['sam@gmail.com'],
    };
    const built = buildWarmPaths(
      [
        mail('g1', '2026-05-01T00:00:00Z', [
          ['Sam <sam@gmail.com>', 'Lee <lee@gmail.com>, Nick <ntippman@gmail.com>'],
        ]),
      ],
      person,
      CTX,
    );
    expect(built.known.map((p) => p.email)).toEqual(['sam@gmail.com']);
    expect(built.introducers.map((p) => p.email)).toEqual(['lee@gmail.com']);
  });

  const harbor: WarmTarget = {
    kind: 'domain',
    label: 'harborlp.example',
    domains: ['harborlp.example'],
    addresses: [],
  };

  it('whoever Nick forwards an LP email to is not an introducer', () => {
    const built = buildWarmPaths(
      [
        mail('h1', '2026-08-01T00:00:00Z', [
          ['Jane Doe <jane@harborlp.example>', 'Nick <nick@tiptop.vc>'],
          // The forward stays on the same Gmail thread.
          ['Nick <nick@tiptop.vc>', 'Bob Lawyer <bob@lawfirm.example>'],
        ]),
      ],
      harbor,
      CTX,
    );
    expect(built.known.map((p) => p.email)).toEqual(['jane@harborlp.example']);
    expect(built.introducers).toEqual([]);
    expect(built.used).toBe(1);
  });

  it("a BCC'd letter from the firm is not someone Nick knows", () => {
    const built = buildWarmPaths(
      [
        mail('h2', '2026-08-01T00:00:00Z', [
          ['Jane Doe <jane@harborlp.example>', 'undisclosed-recipients:;'],
        ]),
      ],
      harbor,
      CTX,
    );
    expect(built).toEqual({ known: [], introducers: [], used: 0, groupSkipped: 0 });
  });

  it('someone on an email with the LP can introduce, even when Nick never wrote to the LP', () => {
    // Bob introduces Nick; Jane has not replied yet, so Nick does not know her yet.
    const built = buildWarmPaths(
      [
        mail('h3', '2026-08-01T00:00:00Z', [
          [
            'Bob Reyes <bob@introfirm.example>',
            'Jane Doe <jane@harborlp.example>',
            'nick@tiptop.vc',
          ],
        ]),
      ],
      harbor,
      CTX,
    );
    expect(built.known).toEqual([]);
    expect(built.introducers.map((p) => [p.email, p.name, p.threads])).toEqual([
      ['bob@introfirm.example', 'Bob Reyes', 1],
    ]);
    expect(built.used).toBe(1);
  });

  it('is honest when nothing matches', () => {
    expect(buildWarmPaths([], target, CTX)).toEqual({
      known: [],
      introducers: [],
      used: 0,
      groupSkipped: 0,
    });
  });
});

describe('query validation', () => {
  const parse = (qs: string) => parseWarmPathsQuery(new URLSearchParams(qs));

  it('accepts one email, lower-cased', () => {
    expect(parse('email=Priya%40HarborLP.example')).toEqual({
      ok: true,
      value: { kind: 'email', email: 'priya@harborlp.example' },
    });
  });

  it('rejects anything that is not a plain address', () => {
    for (const bad of [
      'not-an-email',
      'a@b',
      'x{y}@z.example',
      'a@b.example OR from:x',
      '"a"@b.example',
      `${'a'.repeat(250)}@b.example`,
    ]) {
      expect(parse(`email=${encodeURIComponent(bad)}`).ok, bad).toBe(false);
    }
  });

  it('takes a hex thread id, with an optional firm hint', () => {
    expect(parse('thread=0f0000000000F001')).toEqual({
      ok: true,
      value: { kind: 'thread', thread: '0f0000000000f001', firm: null },
    });
    expect(parse('thread=0f0000000000f001&firm=Lakeside+Family+Office')).toEqual({
      ok: true,
      value: { kind: 'thread', thread: '0f0000000000f001', firm: 'Lakeside Family Office' },
    });
    expect(parse('thread=xyz').ok).toBe(false);
    expect(parse('thread=0f00').ok).toBe(false);
    expect(parse(`thread=${'a'.repeat(25)}`).ok).toBe(false);
    expect(parse('thread=0f0000000000f001&firm=%22x%22').ok).toBe(false);
  });

  it('takes a firm on its own, tidied', () => {
    expect(parse('firm=++Lakeside+++Family+Office+')).toEqual({
      ok: true,
      value: { kind: 'firm', firm: 'Lakeside Family Office' },
    });
    expect(parse(`firm=${'a'.repeat(121)}`).ok).toBe(false);
    expect(parse('firm=A').ok).toBe(false);
    expect(parse('firm=%7Bfrom%3Ax%7D').ok).toBe(false);
  });

  it('rejects mixed, repeated, unknown or empty asks', () => {
    expect(parse('email=a%40b.example&thread=0f0000000000f001').ok).toBe(false);
    expect(parse('email=a%40b.example&email=c%40d.example').ok).toBe(false);
    expect(parse('who=someone').ok).toBe(false);
    expect(parse('').ok).toBe(false);
    expect(parse('email=').ok).toBe(false);
  });

  it('knows which firm names can be searched', () => {
    expect(searchableFirm('Brightline FoF')).toBe('Brightline FoF');
    expect(searchableFirm('Smith & Co.')).toBe('Smith & Co.');
    expect(searchableFirm("O'Neil (Family) Office")).toBe("O'Neil (Family) Office");
    expect(searchableFirm('"quoted"')).toBeNull();
    expect(searchableFirm('--')).toBeNull();
    expect(searchableFirm(null)).toBeNull();
    expect(searchableFirm(undefined)).toBeNull();
  });
});

describe('demo mode', () => {
  it('answers with fictional people and working thread links', async () => {
    const res = await findWarmPaths(
      {} as DataStore,
      'org-demo',
      null,
      { kind: 'email', email: 'priya@harborlp.demo' },
      { now: NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.state).toBe('ok');
    expect(res.value.target?.label).toBe('harborlp.demo');
    expect(res.value.known[0]?.email).toBe('jordan@harborlp.demo');
    expect(res.value.introducers).toHaveLength(3);
    for (const p of [...res.value.known, ...res.value.introducers]) {
      expect(p.href).toMatch(/^https:\/\/mail\.google\.com\/mail\/\?authuser=/);
    }
  });

  it('labels an LP card by its firm, and a personal address by itself', () => {
    expect(
      demoWarmPaths({ kind: 'thread', thread: '0f0000000000f001', firm: 'Lakeside FO' }, NOW).target
        ?.label,
    ).toBe('Lakeside FO');
    const person = demoWarmPaths({ kind: 'email', email: 'sam.okafor@gmail.com' }, NOW);
    expect(person.target?.kind).toBe('person');
    expect(person.known.map((p) => p.email)).toEqual(['sam.okafor@gmail.com']);
  });
});
