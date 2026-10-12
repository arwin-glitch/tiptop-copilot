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
            attachments: ['q3.pdf'],
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
    expect(thread.messages[0]!.attachments).toEqual(['q3.pdf']);
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
