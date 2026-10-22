import type { StarterDoc } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';

/**
 * AGM Day + Evening: an LP annual meeting in the afternoon and a reception
 * in the evening. Invite-only and unlisted. All copy and names are
 * fictional placeholders for the host to replace.
 */
export const agmStarter: StarterDoc = {
  id: 'agm-day-evening',
  name: 'Annual Meeting + Evening Reception',
  description:
    'An LP annual meeting, then a reception. Two sessions, gated pre-reads, plus-ones for the evening.',
  themePresetId: 'tiptop-signature',
  access: 'invite_only',
  visibility: 'unlisted',
  startTime: '13:00',
  sessions: [
    { name: 'Annual Meeting', offsetMinutes: 0, durationMinutes: 240, capacity: 80 },
    { name: 'Evening Reception', offsetMinutes: 300, durationMinutes: 180, capacity: 125 },
  ],
  sections: [
    sectionTemplate(
      'hero',
      {
        eyebrow: 'Annual Meeting 2027',
        headline: '',
        subheadline:
          'An afternoon on the year in review and the road ahead, followed by an evening reception with the founders and partners who made it.',
        showDate: true,
        showVenue: true,
        ctaLabel: 'RSVP',
        ctaTarget: 'rsvp',
      },
      'centered',
    ),
    sectionTemplate(
      'details',
      {
        showDate: true,
        showTime: true,
        showVenue: true,
        showTimezone: true,
        showAccess: true,
        items: [{ label: 'Dress', value: 'Business; cocktail attire for the evening' }],
      },
      'chips',
    ),
    sectionTemplate(
      'text',
      {
        eyebrow: 'A note from the partners',
        heading: 'Dear {{first_name|friend}},',
        body: [
          'It has been a year of building. Our companies shipped, hired and found their footing, and several of them found their next stage of growth.',
          'We would like to spend an afternoon walking you through it properly: the numbers, the lessons and a few founders telling their own stories. Then we hope you will stay for the evening, when the conversation usually gets good.',
          'With gratitude,\nThe partners',
        ].join('\n\n'),
      },
      'drop_cap',
    ),
    {
      ...sectionTemplate(
        'agenda',
        {
          heading: 'The day',
          intro: '',
          columnA: 'Afternoon · Annual Meeting',
          columnB: 'Evening · Reception',
          items: [
            { time: '1:00 PM', title: 'Welcome and the year in review', column: 'a' },
            {
              time: '1:45 PM',
              title: 'Portfolio spotlights',
              description: 'Three founders on what changed this year.',
              column: 'a',
            },
            { time: '2:45 PM', title: 'Break', column: 'a' },
            {
              time: '3:15 PM',
              title: 'Market panel',
              description: 'Where the next two years are heading.',
              column: 'a',
            },
            { time: '4:15 PM', title: 'Fund outlook and Q&A', column: 'a' },
            { time: '6:00 PM', title: 'Reception opens', column: 'b' },
            { time: '7:00 PM', title: 'A few words from the partners', column: 'b' },
            { time: '7:15 PM', title: 'Dinner stations and conversation', column: 'b' },
            { time: '9:00 PM', title: 'Close', column: 'b' },
          ],
        },
        'two_column',
      ),
      style: {
        background: 'accent',
        backgroundMedia: null,
        padding: 'l',
        align: 'inherit',
        width: 'inherit',
        divider: 'inherit',
      },
    },
    sectionTemplate(
      'hosts',
      {
        heading: 'Your hosts',
        intro: '',
        people: [
          { name: 'Morgan Ellis', title: 'Managing Partner' },
          { name: 'Priya Raman', title: 'Partner' },
          { name: 'Jordan Okafor', title: 'Principal' },
        ],
      },
      'grid',
    ),
    {
      ...sectionTemplate(
        'materials',
        {
          heading: 'Pre-reads',
          intro: 'Shared with confirmed limited partners two weeks before the meeting.',
          items: [
            { title: 'Annual letter', kind: 'doc' },
            { title: 'Portfolio review deck', kind: 'deck' },
            { title: 'Fund financials', kind: 'sheet' },
          ],
        },
        'list',
      ),
      visibility: { mode: 'tags', tags: ['LP'] },
    },
    sectionTemplate(
      'venue',
      {
        heading: 'Getting there',
        notes: '',
        parking: 'Valet at the main entrance.',
        arrival: 'Check in at the front desk; your name badge will be ready.',
        showDirections: true,
        showMap: false,
      },
      'card',
    ),
    sectionTemplate(
      'rsvp',
      {
        heading: 'Will you join us?',
        body: 'Let us know for each part of the day. You are welcome to bring one guest to the evening reception.',
        cta: 'RSVP',
        going: 'Count me in',
        maybe: 'Maybe',
        notGoing: 'Regretfully decline',
      },
      'inline',
    ),
    sectionTemplate(
      'faq',
      {
        heading: 'Questions',
        items: [
          {
            q: 'Can I bring a guest?',
            a: 'Yes, to the evening reception. Add their name when you RSVP.',
          },
          { q: 'Is there parking?', a: 'Valet parking is available at the main entrance.' },
          {
            q: 'Will the meeting be recorded?',
            a: 'No. Slides are shared with limited partners afterwards.',
          },
          {
            q: 'Who do I contact with questions?',
            a: 'Reply to your invitation email and we will help.',
          },
        ],
      },
      'accordion',
    ),
    sectionTemplate(
      'footer',
      {
        text: 'With thanks for a remarkable year.',
        contactLabel: 'Contact the host',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
      'simple',
    ),
  ],
};
