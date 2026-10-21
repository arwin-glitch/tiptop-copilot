import { describe, expect, it } from 'vitest';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { DEMO_IDS } from '@/lib/demo/ids';
import {
  autoCloseStatesProof,
  MONEY_LEGAL_RULES,
  moneyLegalMatches,
  moneyLegalState,
  moneyLegalWhy,
  PROOF_SCHEMA,
  proofExplains,
  STALE_DAYS,
  staleDays,
  staleLabel,
} from '@/lib/tasks/money-legal';
import type { Task } from '@/lib/types/domain';

/**
 * Which tasks count as money or legal, what may close one, and when one is
 * going stale. The rules are plain keywords on purpose, so these tests read
 * as the list of what they catch and what they leave alone. Every title is
 * invented.
 */

describe('the keyword rules', () => {
  it.each([
    ['Send the wire for the Fernhollow round', 'wire'],
    ['Wiring instructions for the Mossgate close', 'wire'],
    ['Answer the capital call from the fund admin', 'capital call'],
    ['Check the Q3 distribution reached the account', 'distribution'],
    ['Send K-1s to the two LPs who asked', 'K-1'],
    ['Find the K1 for the Brightkiln SPV', 'K-1'],
    ['Return the W-9 to the accountant', 'tax form'],
    ['Pay the franchise tax before the deadline', 'tax form'],
    ['Send the 1099 to the advisor', 'tax form'],
    ['Confirm the state filing went in', 'filing'],
    ['Get the annual report done', 'filing'],
    ['Chase the missing signature page', 'signature'],
    ['E-sign the engagement letter', 'signature'],
    ['Countersign the consulting contract', 'signature'],
    ['Review the SAFE from Quarrystone', 'SAFE'],
    ['Send the post-money safe note back', 'SAFE'],
    ['Agree the side letter wording', 'side letter'],
    ['Collect the subscription docs from the new LP', 'subscription docs'],
    ['Return the sub docs', 'subscription docs'],
    ['Set up the SPV for the Tidewell round', 'SPV'],
    ['Mark up the term sheet', 'term sheet'],
    ['Pay the Northwind invoice', 'invoice'],
    ['Approve the payment to the designer', 'payment'],
    ['Check the reimbursement went through', 'payment'],
    ['Update the bank details on file', 'bank'],
    ['Confirm the ACH reached them', 'bank'],
    ['Sign the operating agreement', 'contract'],
    ['Send the NDA before the data room opens', 'NDA'],
    ['Ask legal about the trademark', 'legal'],
    ['Get the form notarized', 'legal'],
  ])('"%s" matches %s', (title, label) => {
    expect(moneyLegalMatches(title)).toContain(label);
  });

  it.each([
    'Intro Priya Raman to Omar Haddad',
    'It is safe to send the deck now',
    'Design review with the Lumen team',
    'Fund II: write the quarterly LP note',
    'Ask Tom for the Girder AI onboarding numbers',
    'Read the Vetrix corpus licensing agreement',
    'Signal boost the Marlow Foods launch',
    'Track the paypal-style checkout flow',
    'Approach the Halyard founders',
  ])('"%s" matches nothing', (title) => {
    expect(moneyLegalMatches(title)).toEqual([]);
  });

  it('reads the detail too, and lists each rule once in rule order', () => {
    expect(moneyLegalMatches('Follow up with Ben', 'He still owes us the signed NDA')).toEqual([
      'NDA',
    ]);
    expect(moneyLegalMatches('Wire the payment and send the wire receipt')).toEqual([
      'wire',
      'payment',
    ]);
  });

  it('has a key and a label for every rule, none repeated', () => {
    const keys = MONEY_LEGAL_RULES.map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of MONEY_LEGAL_RULES) {
      expect(rule.label.trim()).not.toBe('');
      expect(rule.patterns.length).toBeGreaterThan(0);
    }
  });
});

describe('moneyLegalState', () => {
  it('follows the rules with no toggle', () => {
    expect(moneyLegalState({ title: 'Pay the invoice' }, null)).toEqual({
      on: true,
      by: 'rules',
      matched: ['invoice', 'payment'],
    });
    expect(moneyLegalState({ title: 'Book the offsite' }, undefined).on).toBe(false);
  });

  it("lets a person's toggle win either way", () => {
    expect(moneyLegalState({ title: 'Book the offsite' }, true)).toMatchObject({
      on: true,
      by: 'person',
    });
    expect(moneyLegalState({ title: 'Pay the invoice' }, false)).toMatchObject({
      on: false,
      by: 'person',
      matched: ['invoice', 'payment'],
    });
  });

  it('says why a task is on the tab', () => {
    expect(moneyLegalWhy(moneyLegalState({ title: 'Send the NDA' }, null))).toBe('Matched NDA');
    expect(moneyLegalWhy(moneyLegalState({ title: 'Book the offsite' }, true))).toBe(
      'Marked money & legal',
    );
    expect(moneyLegalWhy(moneyLegalState({ title: 'Book the offsite' }, null))).toBeNull();
  });
});

describe('PROOF_SCHEMA', () => {
  const PERSON = '00000000-0000-4000-8000-000000000003';

  it('takes a web link or a confirmation, each with an optional note', () => {
    expect(
      PROOF_SCHEMA.parse({ kind: 'link', url: ' https://mail.example.com/m/1 ', note: '  ' }),
    ).toEqual({ kind: 'link', url: 'https://mail.example.com/m/1', note: undefined });
    expect(
      PROOF_SCHEMA.parse({ kind: 'confirmed', confirmedBy: PERSON, note: 'Said so on the call' }),
    ).toEqual({ kind: 'confirmed', confirmedBy: PERSON, note: 'Said so on the call' });
  });

  it.each([
    { kind: 'link', url: 'javascript:alert(1)' },
    { kind: 'link', url: 'data:text/html,hi' },
    { kind: 'link', url: 'not a link' },
    { kind: 'link', url: 'ftp://files.example.com/receipt.pdf' },
    { kind: 'link' },
    { kind: 'confirmed' },
    { kind: 'confirmed', confirmedBy: 'someone' },
    { kind: 'link', url: 'https://ok.example.com', note: 'x'.repeat(501) },
    { kind: 'trust me' },
    null,
  ])('refuses %j', (input) => {
    expect(PROOF_SCHEMA.safeParse(input).success).toBe(false);
  });
});

describe('autoCloseStatesProof', () => {
  it('needs a reason and a sent email', () => {
    const sent = { reason: 'Sent the signed copy back', evidence_type: 'gmail_sent' };
    expect(autoCloseStatesProof({ ...sent, evidence_id: 'abc0000000000001' })).toBe(true);
    expect(autoCloseStatesProof({ ...sent, evidence_id: '' })).toBe(false);
    expect(autoCloseStatesProof({ ...sent, reason: '  ', evidence_id: 'abc1' })).toBe(false);
    expect(
      autoCloseStatesProof({
        reason: 'A call about it is booked',
        evidence_type: 'calendar_event',
        evidence_id: 'evt1',
      }),
    ).toBe(false);
  });
});

describe('proofExplains', () => {
  const done = '2026-10-20T15:00:00.000Z';
  it('ties a proof to the completion written just after it', () => {
    expect(proofExplains('2026-10-20T14:59:59.900Z', done)).toBe(true);
    expect(proofExplains('2026-10-20T14:45:00.000Z', done)).toBe(false);
    expect(proofExplains('2026-10-20T15:05:00.000Z', done)).toBe(false);
    expect(proofExplains('2026-10-20T14:59:59.900Z', null)).toBe(false);
    expect(proofExplains('nonsense', done)).toBe(false);
  });
});

describe('staleDays', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  it(`marks ${STALE_DAYS} or more quiet days, and nothing sooner`, () => {
    expect(staleDays(ago(6.9), now)).toBeNull();
    expect(staleDays(ago(7), now)).toBe(7);
    expect(staleDays(ago(12.5), now)).toBe(12);
    expect(staleLabel(12)).toBe('Going stale · 12 days quiet');
  });

  it('never marks a time it cannot read', () => {
    expect(staleDays(null, now)).toBeNull();
    expect(staleDays('soon', now)).toBeNull();
  });
});

describe('the demo tasks', () => {
  it('put only the two invented money and legal tasks on the tab', () => {
    const tasks = buildDemoDb(new Date('2026-10-21T12:00:00.000Z')).tasks as Task[];
    const money = tasks.filter((t) => moneyLegalState(t, null).on).map((t) => t.id);
    expect(money.sort()).toEqual([DEMO_IDS.taskSideLetter, DEMO_IDS.taskWireCheck].sort());
  });
});
