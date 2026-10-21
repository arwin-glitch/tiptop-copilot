import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_COPIES } from '@/lib/campaigns/copies';
import { trackingUrls } from '@/lib/campaigns/tokens';
import { buildCampaignMime, encodeHeaderValue } from '@/lib/google/gmail-send';
import { composeCampaignEmail, reviewIssues } from '@/lib/services/campaigns';
import type { Campaign, CampaignRecipient } from '@/lib/types/domain';
import {
  masterBuildCampaignMime,
  masterComposeCampaignEmail,
  masterReviewIssues,
} from '../helpers/master-campaign-email';

/**
 * A campaign that uses no photo and no copies behaves exactly as it did
 * before photos and copies existed: the same MIME, byte for byte (no Cc or
 * Bcc line), the same email object, the same review. Held against frozen
 * copies of the code from before (tests/helpers/master-campaign-email.ts).
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const RECIPIENT = '00000000-0000-4000-8000-000000002100';
const urls = trackingUrls('https://copilot.example', {
  organizationId: ORG,
  recipientId: RECIPIENT,
});

const campaigns = [
  {
    subject: 'Q3 for {{company|you}}',
    body_template: 'Hi {{first_name|there}},\n\nRead [the letter](https://tiptop.example/q3).',
    track_activity: true,
    unsubscribe_link: true,
  },
  {
    subject: 'Fund II — first close',
    body_template: 'Hi,\n\n- one\n- two\n\nhttps://docsend.example/view/abc',
    track_activity: false,
    unsubscribe_link: false,
  },
];
const recipients = [
  { email: 'maren@oakhaven.example', name: 'Maren Solberg', merge: { first_name: 'Maren' } },
  { email: 'jose@nunez.example', name: 'José Núñez', merge: {} },
  { email: 'lp@fund.example', name: null, merge: { company: 'Fund' } },
];
const attachments = [
  { filename: 'Q3 "letter".pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
];

describe('the email of a campaign with no photo and no copies', () => {
  beforeEach(() => {
    // Boundaries come from the clock and Math.random: pin both so the two
    // builders can be compared byte for byte.
    vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });
  afterEach(() => vi.restoreAllMocks());

  it('composes to exactly the same object, with no cc or bcc key at all', () => {
    for (const campaign of campaigns) {
      for (const recipient of recipients) {
        for (const options of [
          { signatureHtml: 'Nick<br>TipTop', urls },
          { signatureHtml: 'Nick', urls: null, attachments },
          { signatureHtml: '', urls, subjectPrefix: '[Test] ' },
        ]) {
          const before = masterComposeCampaignEmail(campaign, recipient, options);
          expect(composeCampaignEmail(campaign, recipient, options)).toStrictEqual(before);
          // Handing it "no copies" changes nothing either: the send loop does.
          const none = composeCampaignEmail(campaign, recipient, { ...options, copies: NO_COPIES });
          expect(none).toStrictEqual(before);
          expect(Object.keys(none)).not.toContain('cc');
          expect(Object.keys(none)).not.toContain('bcc');
        }
      }
    }
  });

  it('builds byte-for-byte the same MIME: no Cc line, no Bcc line', () => {
    const inputs = [
      {
        from: 'nick@tiptop.example',
        to: '"Maren" <maren@oakhaven.example>',
        subject: 'Q3 update — highlights',
        html: '<div>Hi</div>',
        text: 'Hi',
        listUnsubscribe: 'https://copilot.example/t/u/abc',
      },
      {
        from: 'nick@tiptop.example',
        to: 'a@x.example',
        subject: 'Deck',
        html: '<div>See attached</div>',
        text: 'See attached',
        attachments,
      },
      {
        from: 'n@x.example',
        to: 'a@x.example\r\nBcc: everyone@x.example',
        subject: 'Hi\r\nBcc: everyone@x.example',
        html: 'x',
        text: 'x',
      },
    ];
    for (const input of inputs) {
      const before = masterBuildCampaignMime(input);
      expect(buildCampaignMime(input)).toBe(before);
      expect(buildCampaignMime({ ...input, cc: [], bcc: [] })).toBe(before);
      expect(buildCampaignMime({ ...input, cc: undefined, bcc: undefined })).toBe(before);
      expect(before).not.toMatch(/\r\n(Cc|Bcc):/i);
    }
  });

  it('the email a sender gets from compose builds the same MIME as before', () => {
    const email = composeCampaignEmail(campaigns[0]!, recipients[0]!, {
      signatureHtml: 'Nick',
      urls,
      attachments,
      copies: NO_COPIES,
    });
    const asSent = { from: 'nick@tiptop.example', ...email };
    const before = masterComposeCampaignEmail(campaigns[0]!, recipients[0]!, {
      signatureHtml: 'Nick',
      urls,
      attachments,
    });
    expect(buildCampaignMime(asSent)).toBe(
      masterBuildCampaignMime({ from: 'nick@tiptop.example', ...before }),
    );
  });
});

describe('the review of a campaign with no photo and no copies', () => {
  const campaign = {
    id: 'c',
    subject: 'Q3 for {{company}}',
    body_template: 'Hi {{first_name}},\n\nThe letter: [read](https://tiptop.example/q3)',
    track_activity: true,
    unsubscribe_link: false,
    attachments: [],
  } as unknown as Campaign;
  const rows = [
    { id: 'r1', email: 'a@x.example', name: 'Ann Lee', merge: {}, status: 'pending' },
    { id: 'r2', email: 'b@x.example', name: null, merge: {}, status: 'pending' },
    { id: 'r3', email: 'c@x.example', name: null, merge: {}, status: 'skipped' },
  ] as unknown as CampaignRecipient[];

  it('is the same review, and carries no extras', () => {
    for (const options of [{}, { appUrl: null }, { appUrl: 'https://copilot.example' }]) {
      expect(reviewIssues(campaign, rows, options)).toStrictEqual(
        masterReviewIssues(campaign, rows, options),
      );
    }
    const empty = reviewIssues({ ...campaign, subject: '', body_template: '' }, []);
    expect(empty).toStrictEqual(
      masterReviewIssues({ ...campaign, subject: '', body_template: '' }, []),
    );
  });
});

describe('headers when a campaign does copy someone', () => {
  const base = {
    from: 'nick@tiptop.example',
    to: '"Jane Doe" <jane@acme.example>',
    subject: 'Q3',
    html: '<div>Hi</div>',
    text: 'Hi',
  };

  it('puts Cc and Bcc in their own lines, after To, and nowhere else', () => {
    const mime = buildCampaignMime({
      ...base,
      cc: ['partner@fund.example', 'assistant@acme.example'],
      bcc: ['archive@fund.example'],
    });
    const [head, body] = mime.split('\r\n\r\n');
    expect(head?.split('\r\n').slice(0, 5)).toEqual([
      'From: nick@tiptop.example',
      'To: "Jane Doe" <jane@acme.example>',
      'Cc: partner@fund.example, assistant@acme.example',
      'Bcc: archive@fund.example',
      `Subject: ${encodeHeaderValue('Q3')}`,
    ]);
    // To is still exactly one person.
    expect(mime.match(/^To: .*$/gm)).toEqual(['To: "Jane Doe" <jane@acme.example>']);
    // The blind copy is named on its own line only: not in another header, not in the body.
    expect(mime.split('archive@fund.example')).toHaveLength(2);
    expect(body).not.toContain('archive@fund.example');
    expect(Buffer.from(mime).toString('base64')).toBeTruthy();
  });

  it('only Cc when there is no Bcc, and only Bcc when there is no Cc', () => {
    expect(buildCampaignMime({ ...base, cc: ['partner@fund.example'] })).not.toMatch(/\r\nBcc:/);
    const onlyBcc = buildCampaignMime({ ...base, bcc: ['archive@fund.example'] });
    expect(onlyBcc).toContain('\r\nBcc: archive@fund.example\r\n');
    expect(onlyBcc).not.toMatch(/\r\nCc:/);
  });

  it('drops anything that is not a bare address rather than let it split a header', () => {
    const mime = buildCampaignMime({
      ...base,
      cc: ['ok@fund.example', 'x@y.example\r\nBcc: everyone@x.example', 'Name <n@x.example>'],
      bcc: ['bad address', ''],
    });
    expect(mime).toContain('\r\nCc: ok@fund.example\r\n');
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).not.toContain('everyone@x.example');
  });
});
