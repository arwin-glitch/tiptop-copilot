import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES } from '@/lib/campaigns/limits';
import {
  BCC_SAMPLE_MARK,
  checkExtras,
  describeManifest,
  manifestTable,
  type ManifestPhoto,
  type ManifestRecipient,
} from '@/lib/campaigns/manifest';

/**
 * "Who gets what": the per-recipient check behind the review's photo and
 * copy problems, the manifest rows and their totals.
 */

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString();

const JANE: ManifestRecipient = {
  id: 'r1',
  email: 'jane@acme.example',
  name: 'Jane Doe',
  created_at: at(1),
};
const SAM: ManifestRecipient = {
  id: 'r2',
  email: 'sam@lee.example',
  name: 'Sam Lee',
  created_at: at(2),
};
const WEI: ManifestRecipient = {
  id: 'r3',
  email: 'wei@harbor.example',
  name: null,
  created_at: at(3),
};

const photo = (id: string, name: string, size = 1_000): ManifestPhoto => ({
  id,
  name,
  size,
  parts: [`campaigns/x/${id}/0`],
});

const plain = { attachments: [{ name: 'Letter.pdf', size: 2_000 }] };

describe('checkExtras', () => {
  it('a campaign with no photo and no copies has nothing to say', () => {
    const check = checkExtras({
      campaign: plain,
      pending: [SAM, JANE],
      photos: new Map(),
      suppressed: new Set(),
    });
    expect(check.issues).toEqual([]);
    expect(check.warnings).toEqual([]);
    // In send order, each with the shared attachment and nothing else.
    expect(check.rows.map((r) => r.to)).toEqual(['jane@acme.example', 'sam@lee.example']);
    expect(check.rows[0]).toMatchObject({
      photo: null,
      attachments: ['Letter.pdf'],
      cc: [],
      bcc: [],
      bccSample: false,
      bytes: 2_000,
      flags: [],
    });
    expect(check.summary).toMatchObject({
      recipients: 2,
      withPhoto: 0,
      withoutPhoto: 2,
      problems: 0,
      effectiveTotal: 2,
    });
  });

  it('a photo that cannot go stops the send and names the person', () => {
    // Under the photo limit, but over the per-email one with the shared deck.
    const big = photo('p-big', 'big.jpg', 6 * 1024 * 1024);
    const deck = {
      attachments: [{ name: 'Deck.pdf', size: MAX_ATTACHMENT_BYTES - 4 * 1024 * 1024 }],
    };
    const check = checkExtras({
      campaign: deck,
      pending: [
        { ...JANE, photo_id: 'p-gone' },
        { ...SAM, photo_id: 'p-big' },
        { ...WEI, photo_id: 'p-half' },
      ],
      photos: new Map([
        ['p-big', big],
        ['p-half', { ...photo('p-half', 'half.png'), parts: [] }],
      ]),
      suppressed: new Set(),
    });
    expect(check.issues).toEqual([
      'Photo missing for Jane Doe: pick it again or clear it.',
      'The photo for wei@harbor.example did not upload properly: upload it again.',
      'The photo for Sam Lee is too big to send (a photo can be 10.0 MB, and an email 20.0 MB with its attachments): use a smaller photo or fewer attachments.',
    ]);
    expect(check.rows.map((r) => r.flags.map((f) => f.text))).toEqual([
      ['Photo missing'],
      ['Photo too big to send'],
      ['Photo did not upload properly'],
    ]);
    expect(check.summary.problems).toBe(3);
    // A photo over the photo limit is too big whatever else the email carries.
    const huge = checkExtras({
      campaign: plain,
      pending: [{ ...JANE, photo_id: 'p' }],
      photos: new Map([['p', photo('p', 'huge.jpg', 11 * 1024 * 1024)]]),
      suppressed: new Set(),
    });
    expect(huge.rows[0]?.flags).toEqual([{ level: 'block', text: 'Photo too big to send' }]);
  });

  it('a photo goes on its person’s row only', () => {
    const check = checkExtras({
      campaign: plain,
      pending: [{ ...JANE, photo_id: 'p1' }, SAM],
      photos: new Map([
        ['p1', photo('p1', 'jane_doe.png', 500)],
        ['p2', photo('p2', 'group.png')],
      ]),
      suppressed: new Set(),
    });
    expect(check.issues).toEqual([]);
    expect(check.rows[0]?.photo).toEqual({ id: 'p1', name: 'jane_doe.png', size: 500 });
    expect(check.rows[0]?.bytes).toBe(2_500);
    expect(check.rows[1]?.photo).toBeNull();
    expect(check.summary).toMatchObject({ withPhoto: 1, withoutPhoto: 1, unmatchedPhotos: 1 });
    expect(check.warnings).toEqual(['1 photo is not given to anyone, so it goes nowhere.']);
  });

  it('copies: CC on every row, a person’s own on theirs, BCC every email', () => {
    const check = checkExtras({
      campaign: { ...plain, cc: ['partner@fund.example'], bcc: ['archive@fund.example'] },
      pending: [{ ...JANE, cc: ['assistant@acme.example'] }, SAM],
      photos: new Map(),
      suppressed: new Set(),
    });
    expect(check.rows.map((r) => [r.cc, r.personalCc, r.bcc, r.bccSample])).toEqual([
      [
        ['partner@fund.example', 'assistant@acme.example'],
        ['assistant@acme.example'],
        ['archive@fund.example'],
        false,
      ],
      [['partner@fund.example'], [], ['archive@fund.example'], false],
    ]);
    // 2 emails + 3 copies on the first + 2 on the second.
    expect(check.summary.effectiveTotal).toBe(7);
    expect(check.summary.personalCc).toBe(1);
  });

  it('first-only BCC sits on the first row in send order, and on none once used', () => {
    const campaign = { ...plain, bcc: ['archive@fund.example'], bcc_mode: 'first' };
    const fresh = checkExtras({
      campaign,
      pending: [SAM, JANE, WEI],
      photos: new Map(),
      suppressed: new Set(),
    });
    expect(fresh.rows.map((r) => [r.to, r.bcc.length, r.bccSample])).toEqual([
      ['jane@acme.example', 1, true],
      ['sam@lee.example', 0, false],
      ['wei@harbor.example', 0, false],
    ]);
    expect(fresh.summary.effectiveTotal).toBe(4);
    const used = checkExtras({
      campaign: { ...campaign, bcc_sample_at: at(9) },
      pending: [SAM, JANE],
      photos: new Map(),
      suppressed: new Set(),
    });
    expect(used.rows.every((r) => r.bcc.length === 0)).toBe(true);
    expect(used.summary.bccSampleUsed).toBe(true);
    // The line says where the sample goes: the first email that actually goes
    // out (a skip or failure moves it on), or that an earlier email used it.
    expect(describeManifest(fresh.summary)).toContain(
      'BCC: archive@fund.example (one sample, on the first email that actually goes out)',
    );
    expect(describeManifest(used.summary)).toContain(
      'BCC: archive@fund.example (one sample, already used by an earlier email)',
    );
    expect(BCC_SAMPLE_MARK).toBe(
      'BCC sample: goes on the first email actually sent (normally this one)',
    );
    // Never to the BCC address itself: the sample waits for the next email.
    const self = checkExtras({
      campaign: { ...plain, bcc: ['jane@acme.example'], bcc_mode: 'first' },
      pending: [JANE, SAM],
      photos: new Map(),
      suppressed: new Set(),
    });
    expect(self.rows.map((r) => r.bcc)).toEqual([[], ['jane@acme.example']]);
  });

  it('an unsubscribed copy blocks; a copy who is also a recipient only warns', () => {
    const check = checkExtras({
      campaign: {
        ...plain,
        cc: ['gone@fund.example', 'sam@lee.example'],
        bcc: ['old@fund.example'],
      },
      pending: [{ ...JANE, cc: ['left@acme.example'] }, SAM],
      photos: new Map(),
      suppressed: new Set(['gone@fund.example', 'old@fund.example', 'left@acme.example']),
    });
    expect(check.issues).toEqual([
      'gone@fund.example unsubscribed, so it cannot be copied: take it off CC.',
      'old@fund.example unsubscribed, so it cannot be copied: take it off BCC.',
      'An unsubscribed address is on the CC of Jane Doe: take it off their CC.',
    ]);
    expect(check.warnings).toEqual([
      "sam@lee.example is on CC and on the recipient list: they get their own email and a copy of everyone else's email.",
    ]);
    expect(check.rows[0]?.flags).toEqual([
      { level: 'block', text: 'Unsubscribed on CC: left@acme.example' },
    ]);
  });
});

describe('describeManifest and manifestTable', () => {
  it('says it in one line, and as a spreadsheet', () => {
    const check = checkExtras({
      campaign: {
        ...plain,
        cc: ['partner@fund.example'],
        bcc: ['archive@fund.example'],
        bcc_mode: 'first',
      },
      pending: [{ ...JANE, photo_id: 'p1', cc: ['assistant@acme.example'] }, SAM],
      photos: new Map([['p1', photo('p1', 'jane_doe.png')]]),
      suppressed: new Set(),
    });
    expect(describeManifest(check.summary)).toBe(
      '1 with photo, 1 without, 0 problems; CC: partner@fund.example; BCC: archive@fund.example (one sample, on the first email that actually goes out); 1 person has their own CC',
    );
    expect(manifestTable(check.rows)).toEqual([
      ['To', 'Name', 'Photo', 'Shared attachments', 'CC', 'BCC', 'Flags'],
      [
        'jane@acme.example',
        'Jane Doe',
        'jane_doe.png',
        'Letter.pdf',
        'partner@fund.example; assistant@acme.example',
        'archive@fund.example (BCC sample: goes on the first email actually sent (normally this one))',
        '',
      ],
      ['sam@lee.example', 'Sam Lee', 'none', 'Letter.pdf', 'partner@fund.example', '', ''],
    ]);
    // Before photos and copies are set up, their columns are not there at all.
    expect(manifestTable(check.rows, false)).toEqual([
      ['To', 'Name', 'Shared attachments', 'Flags'],
      ['jane@acme.example', 'Jane Doe', 'Letter.pdf', ''],
      ['sam@lee.example', 'Sam Lee', 'Letter.pdf', ''],
    ]);
  });
});
