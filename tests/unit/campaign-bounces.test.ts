import { describe, expect, it } from 'vitest';
import { bounceNames } from '@/lib/campaigns/activity';

/**
 * Which address a bounce is about, for an email that went with copies: only
 * a bounce naming the recipient's own address counts against them. Every
 * bounce and address here is invented.
 */

const bounce = (snippet: string, body: string | null = null) => ({ snippet, body_text: body });

describe('bounceNames', () => {
  it('finds the address in Gmail’s snippet, escaped as Gmail sends it, in any case', () => {
    const gmail = bounce(
      'Address not found Your message wasn&#39;t delivered to &lt;Jane@Acme.example&gt; because the address couldn&#39;t be found.',
    );
    expect(bounceNames(gmail, 'jane@acme.example')).toBe(true);
    expect(bounceNames(gmail, 'JANE@ACME.EXAMPLE')).toBe(true);
    expect(bounceNames(gmail, 'partner@fund.example')).toBe(false);
  });

  it('matches the exact address only, never one inside a longer one', () => {
    const text = bounce('Delivery to diana@acme.example and to ana@acme.example.org failed.');
    expect(bounceNames(text, 'ana@acme.example')).toBe(false);
    expect(bounceNames(text, 'diana@acme.example')).toBe(true);
    expect(bounceNames(text, 'ana@acme.example.org')).toBe(true);
    // A sentence may end straight after it.
    expect(bounceNames(bounce('It could not reach ana@acme.example.'), 'ana@acme.example')).toBe(
      true,
    );
  });

  it('leaves out the returned message: its quoted headers name everyone it went to', () => {
    const body = [
      "Your message wasn't delivered to partner@fund.example because the address couldn't be found.",
      '',
      '----- Original message -----',
      'To: Jane Doe <jane@acme.example>',
      'Cc: partner@fund.example',
      '',
      'Hi Jane, here is your portrait.',
    ].join('\n');
    expect(bounceNames(bounce('Address not found', body), 'jane@acme.example')).toBe(false);
    expect(bounceNames(bounce('Address not found', body), 'partner@fund.example')).toBe(true);
    // A header line on its own, quoted with ">", says nothing either.
    expect(bounceNames(bounce('', '> To: jane@acme.example'), 'jane@acme.example')).toBe(false);
    // Nor what follows Exchange's "Original message headers:".
    const exchange =
      'Delivery has failed to these recipients.\n\nOriginal message headers:\n\nReceived: from mx\nSender jane@acme.example';
    expect(bounceNames(bounce('', exchange), 'jane@acme.example')).toBe(false);
  });

  it('lets a delivery report’s own fields decide when it has them', () => {
    const report = (finalRecipient: string) =>
      [
        'This is the mail system at host mx.harbor.example.',
        'Your message to wei@harbor.example could not be delivered to one of its recipients.',
        '',
        'Reporting-MTA: dns; mx.harbor.example',
        `Final-Recipient: rfc822; ${finalRecipient}`,
        'Action: failed',
        'Status: 5.1.1',
      ].join('\n');
    expect(bounceNames(bounce('', report('Wei@Harbor.example')), 'wei@harbor.example')).toBe(true);
    // The words mention Wei, but the report says the copy failed.
    expect(bounceNames(bounce('', report('partner@fund.example')), 'wei@harbor.example')).toBe(
      false,
    );
    expect(
      bounceNames(
        bounce('', 'Original-Recipient: rfc822;sam@lee.example\nAction: failed'),
        'sam@lee.example',
      ),
    ).toBe(true);
    expect(
      bounceNames(
        bounce('', 'X-Failed-Recipients: partner@fund.example, sam@lee.example'),
        'sam@lee.example',
      ),
    ).toBe(true);
  });

  it('a bounce that names nobody names nobody', () => {
    expect(
      bounceNames(bounce('Delivery incomplete. There was a problem.'), 'jane@acme.example'),
    ).toBe(false);
    expect(bounceNames({ snippet: null, body_text: null }, 'jane@acme.example')).toBe(false);
    expect(bounceNames(bounce('jane@acme.example'), '')).toBe(false);
  });
});
