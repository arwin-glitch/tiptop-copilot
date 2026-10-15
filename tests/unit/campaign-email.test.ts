import { describe, expect, it } from 'vitest';
import {
  readTestTrackingToken,
  readTrackingToken,
  testTrackingUrls,
  trackingUrls,
} from '@/lib/campaigns/tokens';
import { buildCampaignMime, encodeHeaderValue } from '@/lib/google/gmail-send';
import { composeCampaignEmail, formatAddress, recipientState } from '@/lib/services/campaigns';
import type { CampaignRecipient } from '@/lib/types/domain';

/** The email a recipient gets, and the MIME it travels in. */

const ORG = '00000000-0000-4000-8000-000000000001';
const RECIPIENT = '00000000-0000-4000-8000-000000002100';

const campaign = {
  subject: 'Q3 for {{company|you}}',
  body_template: 'Hi {{first_name|there}},\n\nRead [the letter](https://tiptop.example/q3).',
  track_activity: true,
  unsubscribe_link: true,
};
const recipient = {
  email: 'maren@oakhaven.example',
  name: 'Maren Solberg',
  merge: { first_name: 'Maren', company: 'Oakhaven' },
};

describe('composeCampaignEmail', () => {
  const urls = trackingUrls('https://copilot.example', {
    organizationId: ORG,
    recipientId: RECIPIENT,
  });

  it('fills merge fields, tracks links, adds the signature, unsubscribe and pixel', () => {
    const email = composeCampaignEmail(campaign, recipient, {
      signatureHtml: 'Nick<br>TipTop',
      urls,
    });
    expect(email.to).toBe('"Maren Solberg" <maren@oakhaven.example>');
    expect(email.subject).toBe('Q3 for Oakhaven');
    expect(email.html).toContain('Hi Maren,');
    expect(email.html).toContain(
      `href="${urls.click('https://tiptop.example/q3').replace(/&/g, '&amp;')}"`,
    );
    expect(email.html).not.toContain('href="https://tiptop.example/q3"');
    expect(email.html).toContain('<div class="gmail_signature">Nick<br>TipTop</div>');
    expect(email.html).toContain(`<img src="${urls.open}"`);
    expect(email.html).toContain(`href="${urls.unsubscribe}"`);
    expect(email.listUnsubscribe).toBe(urls.unsubscribe);
    // The plain part keeps the real link, untracked.
    expect(email.text).toContain('the letter (https://tiptop.example/q3)');
    expect(email.text).toContain('--\nNick\nTipTop');
    expect(email.text).toContain(`Unsubscribe: ${urls.unsubscribe}`);
  });

  it('with tracking off: no pixel and every link as written', () => {
    const email = composeCampaignEmail({ ...campaign, track_activity: false }, recipient, {
      signatureHtml: 'Nick',
      urls,
    });
    expect(email.html).not.toContain('<img');
    expect(email.html).not.toContain('/t/c/');
    expect(email.html).toContain('href="https://tiptop.example/q3"');
    // The unsubscribe line is its own switch.
    expect(email.listUnsubscribe).toBe(urls.unsubscribe);
  });

  it('with the unsubscribe link off: no line and no List-Unsubscribe header', () => {
    const email = composeCampaignEmail({ ...campaign, unsubscribe_link: false }, recipient, {
      signatureHtml: 'Nick',
      urls,
    });
    expect(email.html).not.toContain('/t/u/');
    expect(email.html).not.toContain('unsubscribe');
    expect(email.text).not.toContain('Unsubscribe');
    expect(email.listUnsubscribe).toBeNull();
    // Still tracked.
    expect(email.html).toContain(`<img src="${urls.open}"`);
  });

  it('never rewrites a link whose text is an address: it goes where it says', () => {
    const email = composeCampaignEmail(
      {
        ...campaign,
        body_template:
          'Deck: https://docsend.example/view/abc\n\n[docsend.example/view/def](https://docsend.example/view/def) and [the memo](https://tiptop.example/memo).',
      },
      recipient,
      { signatureHtml: 'Nick', urls },
    );
    expect(email.html).toContain('href="https://docsend.example/view/abc"');
    expect(email.html).toContain('href="https://docsend.example/view/def"');
    // Text that is not an address is still tracked.
    expect(email.html).toContain(urls.click('https://tiptop.example/memo').replace(/&/g, '&amp;'));
  });

  it('a test send carries the real endpoints on a test token, and a [Test] subject', () => {
    const test = testTrackingUrls('https://copilot.example', {
      organizationId: ORG,
      campaignId: '00000000-0000-4000-8000-000000002000',
    });
    const email = composeCampaignEmail(campaign, recipient, {
      signatureHtml: 'Nick',
      urls: test,
      subjectPrefix: '[Test] ',
    });
    expect(email.subject).toBe('[Test] Q3 for Oakhaven');
    expect(email.html).toContain(`<img src="${test.open}"`);
    expect(email.html).toContain(test.click('https://tiptop.example/q3').replace(/&/g, '&amp;'));
    expect(email.listUnsubscribe).toBe(test.unsubscribe);
    // A test token never reads as a recipient's.
    const token = test.open.split('/').pop() as string;
    expect(readTrackingToken(token)).toBeNull();
    expect(readTestTrackingToken(token)).toEqual({
      organizationId: ORG,
      campaignId: '00000000-0000-4000-8000-000000002000',
    });
  });

  it('formats addresses safely', () => {
    expect(formatAddress(null, 'a@x.example')).toBe('a@x.example');
    expect(formatAddress('a@x.example', 'a@x.example')).toBe('a@x.example');
    // A "name" carrying another address is dropped rather than quoted.
    expect(formatAddress('Evil" <b@y.example>, "x', 'a@x.example')).toBe('a@x.example');
    expect(formatAddress('Lee "Kim" <x>', 'k@x.example')).toBe('"Lee Kim x" <k@x.example>');
    expect(formatAddress('José Núñez', 'j@x.example')).toMatch(
      /^=\?UTF-8\?B\?.+\?= <j@x\.example>$/,
    );
  });
});

describe('buildCampaignMime', () => {
  it('carries both parts, the one-click unsubscribe headers and an encoded subject', () => {
    const mime = buildCampaignMime({
      from: 'nick@tiptop.example',
      to: '"Maren" <maren@oakhaven.example>',
      subject: 'Q3 update — highlights',
      html: '<div>Hi</div>',
      text: 'Hi',
      listUnsubscribe: 'https://copilot.example/t/u/abc',
    });
    expect(mime).toContain('From: nick@tiptop.example\r\n');
    expect(mime).toContain(`Subject: ${encodeHeaderValue('Q3 update — highlights')}\r\n`);
    expect(mime).toContain('List-Unsubscribe: <https://copilot.example/t/u/abc>\r\n');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n');
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="a_/);
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime).not.toContain('multipart/mixed');
  });

  it('wraps attachments in multipart/mixed', () => {
    const mime = buildCampaignMime({
      from: 'nick@tiptop.example',
      to: 'a@x.example',
      subject: 'Deck',
      html: '<div>See attached</div>',
      text: 'See attached',
      attachments: [
        { filename: 'Q3 "letter".pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
      ],
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="m_/);
    expect(mime).toContain('Content-Disposition: attachment; filename="Q3  letter .pdf"');
    expect(mime).toContain(Buffer.from('%PDF-1.4').toString('base64'));
  });

  it('leaves a plain ASCII subject alone and cannot be split by a newline', () => {
    expect(encodeHeaderValue('Plain subject')).toBe('Plain subject');
    const mime = buildCampaignMime({
      from: 'n@x.example',
      to: 'a@x.example\r\nBcc: everyone@x.example',
      subject: 'Hi\r\nBcc: everyone@x.example',
      html: 'x',
      text: 'x',
    });
    expect(mime).not.toMatch(/\r\nBcc:/);
  });
});

describe('recipientState', () => {
  const base = {
    status: 'sent',
    bounced_at: null,
    replied_at: null,
    unsubscribed_at: null,
    clicked_at: null,
    opened_at: null,
  } as unknown as CampaignRecipient;
  it('shows the most telling state', () => {
    expect(recipientState(base)).toBe('sent');
    expect(recipientState({ ...base, opened_at: 'x' })).toBe('opened');
    expect(recipientState({ ...base, opened_at: 'x', clicked_at: 'x' })).toBe('clicked');
    expect(recipientState({ ...base, clicked_at: 'x', replied_at: 'x' })).toBe('replied');
    expect(recipientState({ ...base, replied_at: 'x', bounced_at: 'x' })).toBe('bounced');
    expect(recipientState({ ...base, status: 'failed' })).toBe('failed');
    expect(recipientState({ ...base, status: 'unconfirmed' })).toBe('unconfirmed');
  });
});
