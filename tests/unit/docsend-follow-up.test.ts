import { describe, expect, it } from 'vitest';
import type { DataStore } from '@/lib/db/store';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import { buildReaders, type DocSendView } from '@/lib/services/docsend';
import type { LpItem } from '@/lib/services/follow-ups';
import type { Integration } from '@/lib/types/domain';
import {
  FOLLOW_UP_SUBJECT,
  followUpDraft,
  followUpFirstName,
  followUpWhat,
  mailboxCanSend,
  readFollowUpContext,
  sentQuery,
} from '@/lib/services/docsend-follow-up';

const NOW = new Date('2026-10-13T16:00:00Z');

const PROSPECT = 'Northwind Ventures — LP Update #12 [Prospective Partner Version]';

describe('what the follow-up names', () => {
  it('names the prospective-partner update, decks and TL;DR docs', () => {
    expect(followUpWhat([PROSPECT])).toBe('our latest LP update');
    expect(followUpWhat(['Northwind Fund I Deck Final Live'])).toBe('the deck');
    expect(followUpWhat(['Northwind Fund II TL;DR'])).toBe('our TL;DR');
    expect(followUpWhat(['Fund II TLDR v3'])).toBe('our TL;DR');
    expect(followUpWhat(['Northwind One-Pager'])).toBe('our one-pager');
  });

  it('uses the newest fundraising document, skipping the Fund I LP update', () => {
    expect(followUpWhat(['LP Update #4 - Summer [Northwind Ventures]', 'Fund II Deck'])).toBe(
      'the deck',
    );
  });

  it('falls back to a neutral phrase', () => {
    expect(followUpWhat(['Board notes'])).toBe('what we sent over');
    expect(followUpWhat([])).toBe('what we sent over');
  });
});

describe('first name', () => {
  it('takes the first name, skipping honorifics', () => {
    expect(followUpFirstName('Jessica Whittington')).toBe('Jessica');
    expect(followUpFirstName('Dr. Jane Smith')).toBe('Jane');
    expect(followUpFirstName('priya')).toBe('Priya');
    expect(followUpFirstName("O'Neil Brown")).toBe("O'Neil");
  });

  it('says "there" when no usable name is known', () => {
    expect(followUpFirstName(null)).toBe('there');
    expect(followUpFirstName('')).toBe('there');
    expect(followUpFirstName('J')).toBe('there');
    expect(followUpFirstName('123 Capital')).toBe('there');
  });

  it('is stricter with a name guessed from an address', () => {
    expect(followUpFirstName('Jessica Whittington', { guessed: true })).toBe('Jessica');
    expect(followUpFirstName('Lynn Park', { guessed: true })).toBe('Lynn');
    expect(followUpFirstName('Investor Relations', { guessed: true })).toBe('there');
    expect(followUpFirstName('Ir Team', { guessed: true })).toBe('there');
    expect(followUpFirstName('Jw Smith', { guessed: true })).toBe('there');
    expect(followUpFirstName('Deal Team', { guessed: true })).toBe('there');
    // Short names from the pipeline are kept as written.
    expect(followUpFirstName('Al Gomez')).toBe('Al');
  });
});

describe('greeting, from real DocSend readers', () => {
  const view = (viewer: string, i: number): DocSendView => ({
    messageId: `0a${i}`,
    threadId: `0a${i}`,
    viewer,
    document: PROSPECT,
    downloaded: false,
    at: '2026-10-12T10:00:00.000Z',
  });
  const greet = (emails: string[], lps: LpItem[] = []) =>
    buildReaders(
      emails.map((e, i) => view(e, i)),
      { ownDomain: 'tiptop.vc', lps, now: NOW },
    ).map((r) => [r.email, followUpDraft(r).body.split(',')[0]]);

  it('never greets a role inbox or initials as a person', () => {
    expect(
      greet([
        'investor.relations@harborlp.example',
        'ir.team@birch.example',
        'deal.team@pine.example',
        'jw.smith@alder.example',
        'info@quill.example',
      ]),
    ).toEqual([
      ['investor.relations@harborlp.example', 'Hi there'],
      ['ir.team@birch.example', 'Hi there'],
      ['deal.team@pine.example', 'Hi there'],
      ['jw.smith@alder.example', 'Hi there'],
      ['info@quill.example', 'Hi there'],
    ]);
  });

  it('greets a plausible first.last address, and the pipeline name for a matched LP', () => {
    const lp = {
      who: 'Ana Ruiz',
      firm: 'Cedar Office',
      kind: 'family_office',
      stage: 'meeting',
    } as LpItem;
    expect(
      greet(['jessica.whittington@harborlp.example', 'a.ruiz@cedaroffice.example'], [lp]),
    ).toEqual([
      ['jessica.whittington@harborlp.example', 'Hi Jessica'],
      // Matched to the pipeline: "Ana" comes from there, not from "a.ruiz".
      ['a.ruiz@cedaroffice.example', 'Hi Ana'],
    ]);
  });
});

describe('the prefilled note', () => {
  it('is short, in Nick’s voice, and addressed to the reader', () => {
    expect(
      followUpDraft({
        email: 'priya@harborlp.example',
        name: 'Priya Raman',
        documents: [PROSPECT],
      }),
    ).toEqual({
      to: 'priya@harborlp.example',
      subject: FOLLOW_UP_SUBJECT,
      body:
        'Hi Priya,\n\nThanks for taking a look at our latest LP update. Happy to walk you ' +
        'through Fund II or answer any questions - would a quick call be helpful?\n\nNick',
    });
    expect(FOLLOW_UP_SUBJECT).toBe('Following up - TipTop Ventures');
  });

  it('never proposes meeting days and never uses an em dash', () => {
    const { body } = followUpDraft({
      email: 'sam.okafor@gmail.com',
      name: null,
      documents: ['Northwind Fund I Deck'],
    });
    expect(body.startsWith('Hi there,')).toBe(true);
    expect(body).toContain('the deck');
    expect(body).not.toMatch(
      /monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week/i,
    );
    expect(body).not.toContain('—');
    expect(body.trimEnd().endsWith('\n\nNick')).toBe(true);
  });
});

describe('sent-mail search', () => {
  it('looks for mail Nick sent to or copied the reader in the last 60 days', () => {
    expect(sentQuery('Sam.Okafor@gmail.com')).toBe(
      'in:sent {to:sam.okafor@gmail.com cc:sam.okafor@gmail.com} newer_than:60d',
    );
  });

  it('refuses anything that could change the search', () => {
    expect(sentQuery('x@y.example} OR {from:z@w.example')).toBeNull();
    expect(sentQuery('"quoted"@y.example')).toBeNull();
    expect(sentQuery('not an email')).toBeNull();
  });
});

describe('send grant', () => {
  const integration = (scopes: string[]) => ({ scopes }) as unknown as Integration;

  it('is on only with the opt-in send scope', () => {
    expect(mailboxCanSend(null)).toBe(false);
    expect(mailboxCanSend(integration([]))).toBe(false);
    expect(mailboxCanSend(integration(['openid', 'email']))).toBe(false);
    expect(mailboxCanSend(integration([...SEND_SCOPES]))).toBe(true);
  });
});

describe('demo mode', () => {
  it('shows a fictional earlier email and never offers sending', async () => {
    const ctx = await readFollowUpContext(
      {} as DataStore,
      'org-demo',
      ['priya@harborlp.demo', 'sam.okafor@gmail.com'],
      { now: NOW },
    );
    expect(ctx.canSend).toBe(false);
    expect(Object.keys(ctx.lastSent)).toEqual(['sam.okafor@gmail.com']);
    expect(ctx.lastSent['sam.okafor@gmail.com']).toBe('2026-10-07T16:00:00.000Z');
    expect(ctx.checked.has('priya@harborlp.demo')).toBe(true);
  });
});
