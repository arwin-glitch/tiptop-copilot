import { describe, expect, it } from 'vitest';
import { parseTemplate, rsvpLinkUsed, subjectIssues } from '@/lib/campaigns/template';
import { literal, messageCopy, type MessageContext } from '@/lib/events/message-copy';
import type { EventCampaignKind } from '@/lib/types/domain';

/**
 * Every event message starts as a draft with this copy (D-075). It must be a
 * valid campaign template (nothing for the review to refuse), carry the
 * guest's personal {{rsvp_link}} where an answer is wanted, and end at the
 * sign-off (the signature is added when it goes). Fictional event only.
 */

const context: MessageContext = {
  title: 'Harborview Annual Meeting',
  when: 'Mon, Jan 25, 2027 · 1:00 PM – 9:00 PM CST',
  venueName: 'The Lantern Hall',
  sessions: [
    { name: 'Annual Meeting', when: 'Mon, Jan 25, 2027 · 1:00 PM – 5:00 PM CST' },
    { name: 'Evening Reception', when: 'Mon, Jan 25, 2027 · 6:00 PM – 9:00 PM CST' },
  ],
  cancelMessage: 'We will share a new date soon.',
};

const KINDS: EventCampaignKind[] = [
  'invite',
  'reminder',
  'notice',
  'update',
  'cancellation',
  'blast',
  'nudge',
];

describe('event message copy', () => {
  it('is a template the campaign review accepts, for every kind', () => {
    for (const kind of KINDS) {
      const copy = messageCopy(kind, context, { offsetMinutes: 1_440 });
      expect(parseTemplate(copy.body).issues, kind).toEqual([]);
      expect(subjectIssues(copy.subject), kind).toEqual([]);
      expect(copy.body.startsWith('Hi {{first_name|there}},'), kind).toBe(true);
      expect(copy.name.startsWith('Harborview Annual Meeting · '), kind).toBe(true);
      // No typed signature: the sender's is added when it goes.
      expect(copy.body).not.toMatch(/Nick|Arwin|TipTop/);
    }
  });

  it('carries the personal RSVP link wherever a guest is asked to act', () => {
    for (const kind of ['invite', 'reminder', 'update', 'nudge', 'blast'] as const) {
      expect(rsvpLinkUsed(messageCopy(kind, context).body), kind).toBe(true);
    }
    // A cancellation asks nothing of the guest.
    expect(rsvpLinkUsed(messageCopy('cancellation', context).body)).toBe(false);
  });

  it('lists the sessions in an invite, and names the venue', () => {
    const invite = messageCopy('invite', context);
    expect(invite.subject).toBe("You're invited: Harborview Annual Meeting");
    expect(invite.body).toContain('at The Lantern Hall');
    expect(invite.body).toContain('- Annual Meeting: Mon, Jan 25, 2027 · 1:00 PM – 5:00 PM CST');
    expect(invite.body).toContain('{{rsvp_link|RSVP here}}');
  });

  it('words a reminder by its offset and session', () => {
    const reminder = messageCopy('reminder', context, {
      session: { name: 'Evening Reception', when: 'Mon, Jan 25 · 6:00 PM' },
      offsetMinutes: 1_440,
    });
    expect(reminder.subject).toBe(
      'Reminder: Harborview Annual Meeting, Evening Reception is tomorrow',
    );
    expect(reminder.name).toBe(
      'Harborview Annual Meeting · Reminder (1 day before, Evening Reception)',
    );
  });

  it('has one notice per status change', () => {
    expect(messageCopy('notice', context, { notifyKind: 'confirmed' }).subject).toBe(
      "You're confirmed for Harborview Annual Meeting",
    );
    expect(messageCopy('notice', context, { notifyKind: 'waitlisted' }).body).toContain('waitlist');
    expect(messageCopy('notice', context, { notifyKind: 'promoted' }).body).toContain(
      '{{rsvp_link|confirm your spot}}',
    );
    expect(messageCopy('notice', context, { notifyKind: 'declined' }).name).toBe(
      'Harborview Annual Meeting · Notice: Declined',
    );
  });

  it('carries the host’s cancel note', () => {
    expect(messageCopy('cancellation', context).body).toContain('We will share a new date soon.');
  });

  it('keeps host text from turning into merge tags', () => {
    expect(literal('Gala {{first_name}}\nnight')).toBe('Gala { {first_name} } night');
    const copy = messageCopy('invite', { ...context, title: 'Gala {{secret}}' });
    expect(parseTemplate(copy.body).issues).toEqual([]);
    expect(subjectIssues(copy.subject)).toEqual([]);
  });
});
