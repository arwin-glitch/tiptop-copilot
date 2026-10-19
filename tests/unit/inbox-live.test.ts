import { describe, expect, it } from 'vitest';
import { toLiveThread, userLabels } from '@/lib/services/inbox-live';

describe('live inbox', () => {
  const names = new Map([
    ['Label_12', '@/@Ready to Archive'],
    ['Label_7', '7: actioned'],
  ]);

  it('shows user labels by name and leaves system labels and categories out', () => {
    expect(
      userLabels(['INBOX', 'UNREAD', 'CATEGORY_PERSONAL', 'Label_12', 'Label_99'], names),
    ).toEqual(['@/@Ready to Archive']);
  });

  it('turns a Gmail thread into the reading pane, marking our own messages', () => {
    const thread = toLiveThread(
      {
        id: 'abc1234567',
        subject: 'Q3 update',
        labelIds: ['INBOX', 'UNREAD', 'STARRED', 'Label_7'],
        messages: [
          {
            id: 'm1',
            from: 'Jane Founder <jane@co.example>',
            to: 'nick@acme.vc',
            cc: '',
            date: '2026-10-12T15:00:00.000Z',
            subject: 'Q3 update',
            text: 'Numbers attached.',
            attachments: [{ name: 'q3.pdf', id: 'att1', mimeType: 'application/pdf', size: 1200 }],
            labelIds: ['INBOX'],
          },
          {
            id: 'm2',
            from: 'Nick <nick@acme.vc>',
            to: 'jane@co.example',
            cc: '',
            date: '2026-10-12T16:00:00.000Z',
            subject: 'Re: Q3 update',
            text: 'Thanks!',
            attachments: [],
            labelIds: ['SENT'],
          },
        ],
      },
      names,
      'nick@acme.vc',
    );
    expect(thread).toMatchObject({
      unread: true,
      starred: true,
      inInbox: true,
      labels: ['7: actioned'],
    });
    expect(thread.messages.map((m) => [m.fromName, m.fromUs])).toEqual([
      ['Jane Founder', false],
      ['Nick', true],
    ]);
    expect(thread.messages[0]!.attachments.map((a) => a.name)).toEqual(['q3.pdf']);
  });

  it('never marks a lookalike sender as our own', () => {
    const message = (id: string, from: string) => ({
      id,
      from,
      to: 'nick@acme.vc',
      cc: '',
      date: '2026-10-12T15:00:00.000Z',
      subject: 'Wire details',
      text: 'New wire instructions attached.',
      attachments: [],
      labelIds: ['INBOX'],
    });
    const thread = toLiveThread(
      {
        id: 'abc1234568',
        subject: 'Wire details',
        labelIds: ['INBOX'],
        messages: [
          message('m1', 'Nick <nick@acme.vc.evil.example>'),
          message('m2', '"Nick <nick@acme.vc>" <wires@evil.example>'),
          message('m3', 'xnick@acme.vc'),
          message('m4', 'NICK@ACME.VC'),
        ],
      },
      names,
      'nick@acme.vc',
    );
    expect(thread.messages.map((m) => m.fromUs)).toEqual([false, false, false, true]);
  });
});

describe('reading plain-text mail', () => {
  it('rejoins hard-wrapped sentences but keeps paragraphs and sign-offs', async () => {
    const { reflow } = await import('@/components/inbox/live-inbox');
    const text =
      'Our hesitation is the corpus licensing: five-year exclusive is fine for a\ngood while, but what then?\n\nDaniel';
    expect(reflow(text)).toBe(
      'Our hesitation is the corpus licensing: five-year exclusive is fine for a good while, but what then?\n\nDaniel',
    );
  });
});

describe('row and message times', () => {
  // The server renders the list and the browser hydrates it, so the text must
  // not depend on which zone the process runs in: Render is UTC, a browser is
  // wherever its reader is.
  const ZONE = 'America/Chicago';
  // 11:35 PM Central on Oct 18, already Oct 19 in UTC and further east.
  const NOW = new Date('2026-10-19T04:35:00Z');

  async function underProcessZone<T>(tz: string, run: () => Promise<T>): Promise<T> {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      return await run();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  }

  async function times() {
    const { shortTime, longTime } = await import('@/components/inbox/live-inbox');
    return [
      shortTime('2026-10-19T01:05:00Z', ZONE, NOW),
      shortTime('2026-10-18T03:00:00Z', ZONE, NOW),
      shortTime('2025-12-31T18:00:00Z', ZONE, NOW),
      longTime('2026-10-19T01:05:00Z', ZONE),
    ];
  }

  it('reads the profile timezone, whatever zone the process is in', async () => {
    const expected = ['8:05 PM', 'Oct 17', 'Dec 31, 2025', 'Sun, Oct 18, 8:05 PM'];
    for (const tz of ['UTC', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      expect(await underProcessZone(tz, times)).toEqual(expected);
    }
  });

  it('leaves a missing or unreadable time blank', async () => {
    const { shortTime, longTime } = await import('@/components/inbox/live-inbox');
    expect(shortTime(null, ZONE, NOW)).toBe('');
    expect(shortTime('not a date', ZONE, NOW)).toBe('');
    expect(longTime('not a date', ZONE)).toBe('');
  });
});
