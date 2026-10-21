import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  classifyDeliverable,
  emailsIn,
  joinNames,
  notSeenLabel,
  proofJudgeAfter,
  seenSentLabel,
  TASK_PROOF_SCHEMA,
} from '@/lib/tasks/proof';

/**
 * The pure side of the proof check: which ticked tasks are deliverables
 * (conservative rules: a verb and a named recipient), the two-business-day
 * window, and the labels. Every name, company and address is invented.
 */

const CHICAGO = 'America/Chicago';

describe('classifyDeliverable: deliverables', () => {
  it.each([
    ['Reply to Dana about the Q3 numbers', 'reply', ['Dana']],
    ['Respond to Dana Ortiz (Fernhollow)', 'reply', ['Dana Ortiz']],
    ["Answer Dana's question on the pro-rata", 'reply', ['Dana']],
    ['Get back to Maya on the data room', 'reply', ['Maya']],
    ['Send Maya the Series A investor shortlist', 'send', ['Maya']],
    ['Send the onboarding deck to Tom', 'send', ['Tom']],
    ['Send Girder AI reference list to Tom', 'send', ['Tom']],
    ['Share the memo with Riley', 'send', ['Riley']],
    ["Forward Dana's email to Riley", 'send', ['Riley']],
    ['Email Dana', 'send', ['Dana']],
    ['Send LoomStack pass note', 'send', ['LoomStack']],
    ['Tell Dana we are passing', 'send', ['Dana']],
    ['Update Maya on the round', 'send', ['Maya']],
    ['Let Riley know the call moved', 'send', ['Riley']],
    ['Give Riley feedback on the LP letter', 'review', ['Riley']],
    ['Send feedback to Riley on the memo', 'review', ['Riley']],
    ['Review the newsletter draft so Riley can send it out', 'review', ['Riley']],
    ['Edit the memo and send it back to Riley', 'review', ['Riley']],
    ['Review the deck for Maya to send Friday', 'review', ['Maya']],
    ['Intro Maya to Dana', 'intro', ['Maya', 'Dana']],
    ['Introduce Dev to a founding-engineer recruiter', 'intro', ['Dev']],
    ['Intro: Ana (Northwind) <> Bo & Cy (Brightline)', 'intro', ['Ana', 'Bo', 'Cy']],
    ['Chris → Sam', 'intro', ['Chris', 'Sam']],
    ['Make the intro between Maya and Dana', 'intro', ['Maya', 'Dana']],
    ['Sign the SAFE for Fernhollow', 'sign', ['Fernhollow']],
    ['Countersign the Quarrystone side letter', 'sign', ['Quarrystone']],
    ['Pay Brightline invoice', 'payment', ['Brightline']],
    ['Reimburse Riley for the offsite', 'payment', ['Riley']],
    ['Wire the funds to Fernhollow', 'payment', ['Fernhollow']],
    ['[Urgent] Reply to Dana', 'reply', ['Dana']],
  ])('%s → %s to %j', (title, kind, recipients) => {
    const found = classifyDeliverable(title);
    expect(found).not.toBeNull();
    expect(found?.kind).toBe(kind);
    expect(found?.recipients).toEqual(recipients);
    expect(found?.proof[0]).toBe('gmail_sent');
  });

  it('takes a recipient address from the detail when the title names none', () => {
    const found = classifyDeliverable('Send the signed docs', 'Back to dana@fernhollow.example');
    expect(found).toMatchObject({ kind: 'send', recipients: ['dana@fernhollow.example'] });
  });

  it('keeps a reply with no named recipient, for the caller to address from its email', () => {
    expect(classifyDeliverable('Reply to the LP question on the Q3 timeline')).toMatchObject({
      kind: 'reply',
      recipients: [],
    });
  });

  it('proves a payment by a confirmation and an intro by an email only', () => {
    expect(classifyDeliverable('Pay Brightline invoice')?.proof).toEqual([
      'gmail_sent',
      'payment_confirmation',
    ]);
    expect(classifyDeliverable('Intro Maya to Dana')?.proof).toEqual(['gmail_sent']);
    expect(classifyDeliverable('Reply to Dana')?.proof).toEqual(['gmail_sent', 'slack_message']);
  });
});

describe('classifyDeliverable: plain to-dos are never deliverables', () => {
  it.each([
    'Prepare LPAC agenda',
    'Call Bob',
    'Check email',
    'Book a call with Dana',
    'Follow up with Dana',
    'Ask Tom for the Girder AI onboarding numbers',
    'Run Girder AI reference calls (Arborworks + 2)',
    'Review the Ridgeline agreement',
    'Read the Ridgeline agreement',
    'Send the onboarding notes',
    'Send Q3 report to LPs',
    'Send the deck to the board',
    'Send Ledgerly Series A intros',
    'Intro call with Dana',
    'Update the deck',
    'Pay the invoice',
    'Sign up for the conference',
    'Execute the plan',
    'Payroll review',
    'Draft the Fund II narrative',
  ])('%s', (title) => {
    expect(classifyDeliverable(title)).toBeNull();
  });
});

describe('emailsIn', () => {
  it('finds each address once, lowercased', () => {
    expect(
      emailsIn('Ping Dana@Fernhollow.example and dana@fernhollow.example, tom@girder.example'),
    ).toEqual(['dana@fernhollow.example', 'tom@girder.example']);
    expect(emailsIn(null)).toEqual([]);
  });
});

describe('addBusinessDays', () => {
  it('counts Monday to Friday at the same wall time', () => {
    // Tue 10:00 Chicago (15:00Z in October) + 2 = Thu 10:00.
    expect(addBusinessDays(new Date('2026-10-20T15:00:00Z'), 2, CHICAGO).toISOString()).toBe(
      '2026-10-22T15:00:00.000Z',
    );
  });

  it('skips the weekend: Friday 4pm plus two is Tuesday 4pm', () => {
    expect(addBusinessDays(new Date('2026-10-23T21:00:00Z'), 2, CHICAGO).toISOString()).toBe(
      '2026-10-27T21:00:00.000Z',
    );
  });

  it('starts a weekend tick from Monday morning', () => {
    // Sat 11:00 → Wed 00:00 Chicago (05:00Z).
    expect(addBusinessDays(new Date('2026-10-24T16:00:00Z'), 2, CHICAGO).toISOString()).toBe(
      '2026-10-28T05:00:00.000Z',
    );
  });

  it('counts days in the given time zone, not UTC', () => {
    // Fri 8pm Chicago is already Saturday in UTC, but Friday in Chicago.
    expect(addBusinessDays(new Date('2026-10-24T01:00:00Z'), 2, CHICAGO).toISOString()).toBe(
      '2026-10-28T01:00:00.000Z',
    );
    // The same instant in Tokyo is Saturday morning: counts from Monday.
    expect(addBusinessDays(new Date('2026-10-24T01:00:00Z'), 2, 'Asia/Tokyo').toISOString()).toBe(
      '2026-10-27T15:00:00.000Z',
    );
  });

  it('is the proof window', () => {
    expect(proofJudgeAfter(new Date('2026-10-20T15:00:00Z'), CHICAGO).toISOString()).toBe(
      '2026-10-22T15:00:00.000Z',
    );
  });
});

describe('labels', () => {
  it('joins names', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Riley'])).toBe('Riley');
    expect(joinNames(['Maya', 'Dana'])).toBe('Maya and Dana');
    expect(joinNames(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo and Cy');
  });

  it('says what was seen, quietly', () => {
    expect(seenSentLabel('gmail_sent', '2026-10-20T15:00:00Z', ['Maya'], CHICAGO)).toBe(
      'Seen sent · email to Maya, Oct 20',
    );
    expect(seenSentLabel('slack_message', null, ['Riley'], CHICAGO)).toBe(
      'Seen sent · Slack message to Riley',
    );
    expect(seenSentLabel('payment_confirmation', '2026-10-20T15:00:00Z', [], CHICAGO)).toBe(
      'Seen sent · payment confirmation, Oct 20',
    );
  });

  it('says why a ticked task is flagged', () => {
    expect(notSeenLabel('2026-10-14T15:00:00Z', ['Riley'], true, CHICAGO)).toBe(
      'Ticked Oct 14 · no email to Riley seen since',
    );
    expect(notSeenLabel('2026-10-14T15:00:00Z', ['Riley'], false, CHICAGO)).toBe(
      'Ticked Oct 14 · no address found for Riley, so no email could be matched',
    );
  });
});

describe('TASK_PROOF_SCHEMA', () => {
  const base = {
    title: 'Give Riley feedback on the LP letter',
    kind: 'review',
    evidence_at: '2026-10-20T15:00:00Z',
    evidence: { type: 'slack_message', id: '1729436400.000100', channel: 'D0ZZTEST01' },
    reason: 'Sent Riley the edits in a DM.',
  };

  it('takes a Slack proof', () => {
    expect(TASK_PROOF_SCHEMA.safeParse(base).success).toBe(true);
  });

  it('refuses an invented task id, a bare date and an unknown evidence type', () => {
    expect(TASK_PROOF_SCHEMA.safeParse({ ...base, task_id: 'task-1' }).success).toBe(false);
    expect(TASK_PROOF_SCHEMA.safeParse({ ...base, evidence_at: '2026-10-20' }).success).toBe(false);
    expect(
      TASK_PROOF_SCHEMA.safeParse({ ...base, evidence: { type: 'phone_call', id: 'x' } }).success,
    ).toBe(false);
  });
});
