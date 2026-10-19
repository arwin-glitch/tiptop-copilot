import type { FullMessage, FullThread } from '@/lib/google/gmail-inbox';
import { DEMO_USER } from './fixtures';

/**
 * Demo mode only: the full emails behind the demo follow-ups
 * (`follow-ups-fixtures.ts`), so Follow-ups and the email session can show
 * them without a mailbox. Every name, company, address and link is fictional,
 * and every address and link is on a `.demo` domain. Times are relative to
 * now and never ahead of it.
 */

const NICK = `${DEMO_USER.name} <${DEMO_USER.email}>`;

interface DraftMessage {
  from: string;
  to: string;
  cc?: string;
  at: string;
  text: string;
  attachments?: { name: string; mimeType: string; size: number }[];
}

interface DraftThread {
  subject: string;
  messages: DraftMessage[];
}

/** A Gmail thread shape (`readThreadFull`) from the short form above. */
function toThread(id: string, draft: DraftThread): FullThread {
  const messages: FullMessage[] = draft.messages.map((m, i) => ({
    id: `${id}${i}`,
    from: m.from,
    to: m.to,
    cc: m.cc ?? '',
    date: m.at,
    subject: i === 0 ? draft.subject : `Re: ${draft.subject}`,
    text: m.text,
    // No attachment id: the demo has no mailbox to fetch one from.
    attachments: (m.attachments ?? []).map((a) => ({ ...a, id: '' })),
    labelIds: ['INBOX'],
  }));
  return { id, subject: draft.subject, labelIds: ['INBOX'], messages };
}

/** "On Sat, Oct 17, 2026 ..." for a quoted reply, in UTC like the fixtures' times. */
const quotedDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));

function threads(now: Date): Record<string, DraftThread> {
  // The same clock as follow-ups-fixtures.ts, so "You wrote Oct 3" there is
  // the time on Nick's message here. Days ago at an hour UTC; a day or more
  // back is always in the past, whatever the hour.
  const ago = (days: number, hour = 15) => {
    const d = new Date(now.getTime() - days * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  const danaAsked = ago(2, 15);
  const nickAnswered = ago(1, 17);

  return {
    // ---------------------------------------------------- You're waiting on
    '0f0000000000a001': {
      subject: 'Co-invest allocation on the Zeta round',
      messages: [
        {
          from: 'Priya Natarajan <priya@northwind.demo>',
          to: NICK,
          at: ago(20, 14),
          text: `Hi Nick,

Zeta's lead has confirmed the round at $18M and has set aside a co-invest block for existing investors. Northwind would like to take part alongside TipTop if you are going in.

Could you let me know your allocation by the end of next week? The lead wants the book closed before the board meeting.

Best,
Priya`,
        },
        {
          from: NICK,
          to: 'Priya Natarajan <priya@northwind.demo>',
          at: ago(16),
          text: `Hi Priya,

Thanks for sending the allocation details over, and for holding a spot for us. We are keen to take part.

A few things before I can confirm a number:

1. The pro rata. Our side letter gives us a pro rata on the next priced round. Can you confirm with the lead that the co-invest block sits on top of it rather than inside it?

2. Timing. Our Fund I reserves are reviewed at the start of each month, so a commitment before the 1st would come out of this month's pool. If the lead can wait until the 3rd, the number gets easier.

3. Information rights. If we come in through the co-invest vehicle, do we keep the quarterly reporting we have today, or does that move to the SPV's manager?

If all three come back the way I expect, we are likely in for $250K, with room to go to $400K if the block is undersubscribed. Happy to jump on a call this week if that is quicker than email.

Best,
Nick`,
        },
      ],
    },
    '0f0000000000a002': {
      subject: 'Data room access for diligence',
      messages: [
        {
          from: 'Marcus Webb <marcus@brightline.demo>',
          to: NICK,
          at: ago(11, 14),
          text: `Nick,

Good to meet last week. We would be glad to share the data room ahead of the partner meeting. Let me know who on your side needs access and I will send invites.

Marcus`,
        },
        {
          from: NICK,
          to: 'Marcus Webb <marcus@brightline.demo>',
          at: ago(8),
          text: `Hi Marcus,

Thanks again for the time last week. The team came away impressed with how far the product has come since the seed.

For the data room, could you add me? The items we would like to see first are:

- The last 12 months of revenue by customer, with churn and expansion broken out
- The cap table after the bridge, including the option pool top-up
- Any customer contracts with change-of-control or exclusivity terms
- The hiring plan behind the 2027 budget

If any of that is not ready yet, no problem, send what you have and we can start there. We would like to come back to you with questions before the partner meeting so nothing surprises anyone on the day.

Best,
Nick`,
        },
      ],
    },
    '0f0000000000a003': {
      subject: 'Intro to our healthcare LP',
      messages: [
        {
          from: 'Elena Ruiz <elena@girder.demo>',
          to: NICK,
          at: ago(6, 13),
          text: `Hi Nick, would you be open to an intro to one of our LPs who invests in healthcare infrastructure? I think there is a fit with your Fund II thesis.

Elena`,
        },
        {
          from: NICK,
          to: 'Elena Ruiz <elena@girder.demo>',
          at: ago(4),
          text: `Hi Elena, yes please, I'd love that. Happy for you to share my email.

Nick`,
        },
      ],
    },

    // ---------------------------------------------------- Scheduling drafts
    '0f0000000000c001': {
      subject: 'Quick intro call next week?',
      messages: [
        {
          from: 'Lena Fischer <lena@alderendowment.demo>',
          to: NICK,
          at: ago(1, 16),
          text: `Hi Nick,

Ivy suggested we connect. Alder Endowment is reviewing emerging managers this quarter and I would like to hear about Fund II. Do you have 30 minutes next week for a quick intro call?

Thanks,
Lena`,
        },
      ],
    },

    // ---------------------------------------------------- Waiting on you
    '0f0000000000e001': {
      subject: 'Fund II deck',
      messages: [
        {
          from: NICK,
          to: 'Grace Okafor <grace@lakesidefo.demo>',
          at: ago(5, 15),
          text: `Hi Grace,

Thanks for the time today. Really enjoyed hearing how Lakeside thinks about early-stage exposure.

Nick`,
        },
        {
          from: 'Grace Okafor <grace@lakesidefo.demo>',
          to: NICK,
          at: ago(3),
          text: `Hi Nick,

Likewise, thank you. Could you send over the Fund II deck when you have a moment? I would like to share it with our investment committee before our next meeting.

Best,
Grace`,
        },
      ],
    },
    '0f0000000000e002': {
      subject: 'Term sheet: quick read?',
      messages: [
        {
          from: 'Tom Reyes <tom@harborlabs.demo>',
          to: NICK,
          at: ago(4, 14),
          text: `Nick, we have a term sheet coming in from a strategic. Would you have time to give it a quick read before we respond?

Tom`,
        },
        {
          from: NICK,
          to: 'Tom Reyes <tom@harborlabs.demo>',
          at: ago(3, 16),
          text: `Of course. Send it over and I will look this week.

Nick`,
        },
        {
          from: 'Tom Reyes <tom@harborlabs.demo>',
          to: NICK,
          at: ago(2),
          text: `Attached. The parts I would most like your view on are the board seat and the right of first refusal on a sale. No rush before Friday.

Thanks,
Tom`,
          attachments: [
            {
              name: 'Harbor-Labs-term-sheet-draft.pdf',
              mimeType: 'application/pdf',
              size: 182_000,
            },
          ],
        },
      ],
    },

    // ---------------------------------------------------- The email session
    '0f0000000000c101': {
      subject: 'Dinner co-host tonight?',
      messages: [
        {
          from: 'Dana Whitfield <dana@whitfieldhouse.demo>',
          to: NICK,
          at: danaAsked,
          text: `Hi Nick,

We are hosting a small founders dinner at Whitfield House and I would love for you to co-host with me. About twenty people, mostly seed-stage founders and a few angels. Would you be up for it?

Dana`,
        },
        {
          from: NICK,
          to: 'Dana Whitfield <dana@whitfieldhouse.demo>',
          at: nickAnswered,
          text: `Hi Dana, that sounds great. Let me check the evening and come back to you.

Nick`,
        },
        {
          from: 'Dana Whitfield <dana@whitfieldhouse.demo>',
          to: NICK,
          cc: 'Events Team <events@whitfieldhouse.demo>',
          at: minutesAgo(140),
          text: `Hi Nick,

Circling back on tonight. We are finalising the seating plan this afternoon, so I need a yes or no on co-hosting by 4pm.

If you are in, here is what co-hosting would mean:
- A two-minute welcome at 7:15 before the first course
- Sitting at the centre table with the founders from the spring cohort
- Introducing our keynote, who is speaking on raising a seed round in this market

The run of show is attached, and the guest list and directions are here: https://events.whitfieldhouse.demo/dinner

If tonight doesn't work, no worries at all. We are planning another one in the new year and would love to have you then.

Thanks so much,
Dana

On ${quotedDate(nickAnswered)}, ${NICK} wrote:
> Hi Dana, that sounds great. Let me check the evening and come back to you.
>
> Nick`,
          attachments: [{ name: 'run-of-show.pdf', mimeType: 'application/pdf', size: 86_000 }],
        },
      ],
    },
    '0f0000000000c102': {
      subject: 'Invoice past due, third notice',
      messages: [
        {
          from: 'Ledgerly Billing <billing@ledgerly.demo>',
          to: NICK,
          at: ago(23, 14),
          text: `Hello,

Invoice LG-20417 for $4,800.00 is due today. You can pay it from your account page.

Ledgerly Billing`,
        },
        {
          from: 'Ledgerly Billing <billing@ledgerly.demo>',
          to: NICK,
          at: ago(16, 14),
          text: `Hello,

A reminder that invoice LG-20417 for $4,800.00 is now 7 days past due.

Ledgerly Billing`,
        },
        {
          from: 'Ledgerly Billing <billing@ledgerly.demo>',
          to: NICK,
          at: ago(9, 14),
          text: `Hello,

This is the third notice for invoice LG-20417, for $4,800.00, which is now 14 days past due.

To avoid an interruption to your workspace, please pay the balance or reply to this email with a payment date. If you have already paid, reply with the remittance reference and we will match it.

Invoice: LG-20417
Amount due: $4,800.00
Service period: last month

If the invoice is wrong, for example if the seat count does not match your team, reply and we will look into it before any late fee is applied.

Ledgerly Billing
https://billing.ledgerly.demo/invoices/LG-20417`,
        },
      ],
    },
    '0f0000000000c103': {
      subject: 'Harbor Labs closing the round this week',
      messages: [
        {
          from: 'Tom Reyes <tom@harborlabs.demo>',
          to: NICK,
          at: ago(9, 15),
          text: `Nick, a heads-up that we expect to close the extension this week. Would love TipTop in it.

Tom`,
        },
        {
          from: NICK,
          to: 'Tom Reyes <tom@harborlabs.demo>',
          at: ago(8, 16),
          text: `Great news, congratulations. Send me the final terms and the amount you have left and I will come back to you.

Nick`,
        },
        {
          from: 'Tom Reyes <tom@harborlabs.demo>',
          to: NICK,
          at: ago(4),
          text: `Hi Nick,

Final terms are the same as the seed, on a $24M post. We have $300K left in the round and are closing on Friday.

Are you in? If so, for how much? I want to send signature pages to everyone on Thursday.

Thanks,
Tom`,
        },
      ],
    },
    '0f0000000000c104': {
      subject: 'Intro you promised to Northwind',
      messages: [
        {
          from: NICK,
          to: 'Iris Chen <iris@lumenhealth.demo>',
          at: ago(7, 18),
          text: `Iris, great call today. Send me a short blurb and I will introduce you to Northwind.

Nick`,
        },
        {
          from: 'Iris Chen <iris@lumenhealth.demo>',
          to: NICK,
          at: ago(6, 14),
          text: `Thanks Nick! Here is a blurb you can forward:

"Lumen Health builds scheduling software for outpatient clinics. Since launching in March it has signed 40 clinics, grown revenue 3x, and cut no-shows by a third. Iris Chen, the CEO, is raising a $6M seed and would value Northwind's view on the round."

Let me know if you would like anything changed.

Iris`,
        },
      ],
    },
    '0f0000000000c105': {
      subject: 'Intro to a robotics founder?',
      messages: [
        {
          from: NICK,
          to: 'Ben Alvarez <ben@alvarezpartners.demo>',
          at: ago(5, 16),
          text: `Ben, good to catch up at the summit. Keep me posted on anything in robotics.

Nick`,
        },
        {
          from: 'Ben Alvarez <ben@alvarezpartners.demo>',
          to: NICK,
          at: ago(3),
          text: `Hi Nick,

Following up on our chat at the summit. I have been spending time with a founder building warehouse picking robots, and I think she would be a great fit for TipTop.

A few highlights:
- Former robotics lead at a large logistics company, with two patents in grasp planning
- Three paid pilots with regional distributors, one already converting to a full contract
- Raising a $3M pre-seed; about half of it is committed

She is not formally out yet, so this would be an early look. Would you like an intro? A yes or no is plenty, and no pressure either way.

Best,
Ben`,
        },
      ],
    },
    '0f0000000000c106': {
      subject: 'Thanks for the catch-up',
      messages: [
        {
          from: NICK,
          to: 'Maya Lindqvist <maya@fjordlabs.demo>',
          at: ago(6, 16),
          text: `Maya, great to catch up today. Good luck with the launch.

Nick`,
        },
        {
          from: 'Maya Lindqvist <maya@fjordlabs.demo>',
          to: NICK,
          at: ago(5),
          text: `Thanks Nick, really appreciated the time and the advice on pricing. I'll keep you posted on the launch.

Maya`,
        },
      ],
    },
    '0f0000000000c107': {
      subject: 'Past event reminder',
      messages: [
        {
          from: 'Event Hub <noreply@eventhub.demo>',
          to: NICK,
          at: ago(12, 9),
          text: `Reminder: the Founders Breakfast you registered for took place last week. Thanks for coming.

Event Hub`,
        },
      ],
    },
  };
}

/**
 * The fictional thread behind a demo follow-up or email session item, or null
 * for an id the demo has none for. The meeting recap draft (b001) has none:
 * recaps are drafts, which the reader leaves out.
 */
export function demoFollowUpThread(id: string, now: Date): FullThread | null {
  const key = id.toLowerCase();
  const draft = threads(now)[key];
  return draft ? toThread(key, draft) : null;
}

/** Every id with a demo thread (for the fixture tests). */
export function demoFollowUpThreadIds(now: Date): string[] {
  return Object.keys(threads(now));
}
