import { describe, expect, it } from 'vitest';
import {
  MAX_COPY_ADDRESSES,
  cleanBccMode,
  cleanCopyList,
  copiesFor,
  copyCount,
  parseCopyAddresses,
} from '@/lib/campaigns/copies';

/** CC and BCC: what a person can type, and what one email ends up copying. */

describe('parseCopyAddresses', () => {
  it('takes commas, semicolons, spaces and lines; lowercases and dedupes', () => {
    expect(
      parseCopyAddresses(
        'Partner@Fund.example, ops@fund.example;partner@fund.example\nx@y.example',
      ),
    ).toEqual({ ok: true, emails: ['partner@fund.example', 'ops@fund.example', 'x@y.example'] });
    expect(parseCopyAddresses('')).toEqual({ ok: true, emails: [] });
    expect(parseCopyAddresses('  ,  ')).toEqual({ ok: true, emails: [] });
  });

  it('keeps the address out of Name <address>, quoted names with commas included', () => {
    expect(
      parseCopyAddresses('Jo Park <jo@park.example>, "Doe, Jane" <jane@acme.example> a@b.example'),
    ).toEqual({ ok: true, emails: ['jo@park.example', 'jane@acme.example', 'a@b.example'] });
  });

  it('refuses the whole list when any word is not an address', () => {
    const bad = parseCopyAddresses('ok@fund.example, bob');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain('bob');
    expect(parseCopyAddresses('Jane Doe jane@acme.example').ok).toBe(false);
    expect(parseCopyAddresses('nope@').ok).toBe(false);
  });

  it(`refuses more than ${MAX_COPY_ADDRESSES} addresses`, () => {
    const many = Array.from({ length: MAX_COPY_ADDRESSES + 1 }, (_, i) => `p${i}@fund.example`);
    expect(parseCopyAddresses(many.join(',')).ok).toBe(false);
    expect(parseCopyAddresses(many.slice(1).join(',')).ok).toBe(true);
  });
});

describe('cleanCopyList and cleanBccMode', () => {
  it('reads an absent or odd column as nothing, never as a header', () => {
    expect(cleanCopyList(undefined)).toEqual([]);
    expect(cleanCopyList(null)).toEqual([]);
    expect(cleanCopyList('a@b.example')).toEqual([]);
    expect(cleanCopyList(['A@B.example', 'a@b.example', 'x\r\nBcc: e@v.example', 7])).toEqual([
      'a@b.example',
    ]);
    expect(cleanBccMode('first')).toBe('first');
    expect(cleanBccMode(undefined)).toBe('every');
    expect(cleanBccMode('weekly')).toBe('every');
  });
});

describe('copiesFor', () => {
  it('copies the campaign CC then the person’s own, without repeats', () => {
    expect(
      copiesFor('jane@acme.example', {
        campaignCc: ['partner@fund.example', 'ops@fund.example'],
        personalCc: ['assistant@acme.example', 'ops@fund.example'],
        bcc: [],
      }),
    ).toEqual({
      cc: ['partner@fund.example', 'ops@fund.example', 'assistant@acme.example'],
      bcc: [],
    });
  });

  it('never copies the recipient to themselves, and Bcc never repeats a Cc', () => {
    expect(
      copiesFor('Jane@Acme.example', {
        campaignCc: ['jane@acme.example', 'partner@fund.example'],
        personalCc: [],
        bcc: ['partner@fund.example', 'archive@fund.example', 'jane@acme.example'],
      }),
    ).toEqual({ cc: ['partner@fund.example'], bcc: ['archive@fund.example'] });
  });

  it('leaves unsubscribed addresses off', () => {
    const copies = copiesFor('jane@acme.example', {
      campaignCc: ['gone@fund.example', 'partner@fund.example'],
      personalCc: [],
      bcc: ['gone@fund.example'],
      suppressed: new Set(['gone@fund.example']),
    });
    expect(copies).toEqual({ cc: ['partner@fund.example'], bcc: [] });
    expect(copyCount(copies)).toBe(1);
  });

  it('copies nobody when nothing is set', () => {
    const none = copiesFor('jane@acme.example', { campaignCc: [], personalCc: [], bcc: [] });
    expect(none).toEqual({ cc: [], bcc: [] });
    expect(copyCount(none)).toBe(0);
  });
});
