import type { StarterDoc } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';

/**
 * Founder Golf / Pitch & Putt, Dinner Salon, Demo Day and Holiday Party.
 * Every company, person and place here is invented placeholder copy.
 */

export const founderGolfStarter: StarterDoc = {
  id: 'founder-golf',
  name: 'Founder Golf Day',
  description:
    'Golf, a putting challenge and a clubhouse reception, co-hosted with partners. Approval required.',
  themePresetId: 'pitch-putt-clubhouse',
  access: 'approval',
  visibility: 'unlisted',
  sessions: [
    { name: 'Golf (shotgun start)', offsetMinutes: 0, durationMinutes: 240, capacity: 72 },
    { name: 'Clubhouse reception', offsetMinutes: 270, durationMinutes: 120, capacity: 150 },
  ],
  sections: [
    sectionTemplate(
      'hero',
      {
        eyebrow: 'Founder Golf Day',
        headline: 'Tee off with the best founders in town',
        subheadline:
          'Nine holes, a putting challenge and a clubhouse reception. Founders, investors and partners welcome.',
        showDate: true,
        showVenue: true,
        ctaLabel: 'Request a spot',
        ctaTarget: 'rsvp',
      },
      'kinetic',
    ),
    sectionTemplate(
      'sponsors',
      {
        heading: 'Hosted by',
        intro: '',
        items: [
          { name: 'Northfield Capital' },
          { name: 'Juniper Labs' },
          { name: 'Example Partners' },
        ],
      },
      'lockup',
    ),
    sectionTemplate(
      'details',
      { showDate: true, showTime: true, showVenue: true, showTimezone: true, items: [] },
      'chips',
    ),
    sectionTemplate(
      'countdown',
      {
        heading: 'Tee time in',
        target: 'event',
        liveLabel: 'On the course now',
        endedLabel: 'Thanks for playing',
      },
      'split_flap',
    ),
    sectionTemplate(
      'agenda',
      {
        heading: 'The card',
        intro: '',
        items: [
          { hole: 1, time: '11:30 AM', title: 'Check-in and the range' },
          { hole: 2, time: '12:30 PM', title: 'Shotgun start' },
          {
            hole: 3,
            time: '2:00 PM',
            title: 'Pitch challenge',
            description: 'Closest to the pin wins.',
          },
          { hole: 4, time: '3:30 PM', title: 'Putting final' },
          { hole: 5, time: '4:30 PM', title: 'Clubhouse reception' },
          { hole: 6, time: '6:00 PM', title: 'Awards' },
        ],
      },
      'scorecard',
    ),
    sectionTemplate(
      'hosts',
      {
        heading: 'On the leaderboard',
        intro: 'A few of the founders playing this year.',
        people: [
          { name: 'Avery Chen', company: 'Lumen Robotics', stat: '−2' },
          { name: 'Sam Ortiz', company: 'Fieldnote', stat: '−1' },
          { name: 'Riley Park', company: 'Brightwater Bio', stat: 'E' },
          { name: 'Casey Nguyen', company: 'Parcel AI', stat: '+1' },
        ],
      },
      'leaderboard',
    ),
    sectionTemplate(
      'sponsors',
      {
        heading: 'Hole sponsors',
        intro: '',
        items: [
          { name: 'Example Partners', hole: 3, note: 'Closest to the pin' },
          { name: 'Juniper Labs', hole: 7, note: 'Longest drive' },
          { name: 'Northfield Capital', hole: 9, note: 'Putting final' },
        ],
      },
      'holes',
    ),
    sectionTemplate(
      'venue',
      {
        heading: 'The course',
        notes: '',
        parking: 'Free parking by the clubhouse.',
        arrival: 'Check in at the pro shop. Rental clubs are available.',
        showDirections: true,
        showMap: false,
      },
      'card',
    ),
    sectionTemplate(
      'rsvp',
      {
        heading: 'Request your tee time',
        body: 'Founders, tell us about your company in the questions below. We confirm spots within a few days.',
        cta: 'Request a spot',
        going: 'I am in',
        maybe: 'Maybe',
        notGoing: "Can't make it",
      },
      'inline',
    ),
    sectionTemplate(
      'faq',
      {
        heading: 'Questions',
        items: [
          {
            q: 'Do I need to be good at golf?',
            a: 'Not at all. Teams are mixed and the format is a scramble.',
          },
          { q: 'What should I wear?', a: 'Golf or smart casual; soft-spike shoes on the course.' },
          {
            q: 'Can I come just for the reception?',
            a: 'Yes. Choose only the reception when you RSVP.',
          },
        ],
      },
      'accordion',
    ),
    sectionTemplate(
      'footer',
      {
        text: 'See you on the first tee.',
        contactLabel: 'Contact the hosts',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
      'simple',
    ),
  ],
};

export const dinnerSalonStarter: StarterDoc = {
  id: 'dinner-salon',
  name: 'Dinner Salon',
  description:
    'A seated dinner for a dozen founders: a host note, a menu-card agenda, a dress code.',
  themePresetId: 'supper-club',
  access: 'invite_only',
  visibility: 'unlisted',
  sessions: [{ name: 'Dinner', offsetMinutes: 0, durationMinutes: 180, capacity: 16 }],
  sections: [
    sectionTemplate(
      'hero',
      {
        eyebrow: 'An evening salon',
        headline: '',
        subheadline: 'Twelve founders, one long table and a conversation worth staying late for.',
        showDate: true,
        showVenue: true,
        ctaLabel: 'Reply',
        ctaTarget: 'rsvp',
      },
      'centered',
    ),
    sectionTemplate(
      'text',
      {
        heading: 'A note from your host',
        body: 'We are gathering a small group of founders working on hard problems, for an unhurried dinner and no slides. Come curious; leave with a few new people you will want to call.',
      },
      'single',
    ),
    sectionTemplate(
      'agenda',
      {
        heading: 'The evening',
        intro: '',
        items: [
          {
            time: '7:00 PM',
            title: 'Aperitivo',
            description: 'Sparkling wine and small plates in the courtyard',
          },
          {
            time: '7:45 PM',
            title: 'First course',
            description: 'Heirloom tomato, burrata, basil oil',
          },
          {
            time: '8:30 PM',
            title: 'Main',
            description: 'Slow-roasted short rib, charred root vegetables',
          },
          {
            time: '9:30 PM',
            title: 'Dessert and digestifs',
            description: 'Olive oil cake, a little amaro',
          },
        ],
      },
      'menu',
    ),
    sectionTemplate(
      'info_cards',
      {
        heading: '',
        items: [
          { title: 'Dress code', body: 'Smart casual. Jackets optional.', icon: 'shirt' },
          { title: 'Seating', body: 'One long table; seats are mixed.', icon: 'utensils' },
          {
            title: 'Dietary needs',
            body: 'Tell us in your reply and the kitchen will plan for it.',
            icon: 'info',
          },
        ],
      },
      'dress_code',
    ),
    sectionTemplate(
      'details',
      { showDate: true, showTime: true, showVenue: true, showTimezone: true, items: [] },
      'card',
    ),
    sectionTemplate(
      'rsvp',
      {
        heading: 'Save your seat',
        body: 'Seats are limited and held for a week.',
        cta: 'Reply',
        going: 'Delighted to attend',
        maybe: 'Maybe',
        notGoing: 'Regretfully decline',
      },
      'inline',
    ),
    sectionTemplate(
      'footer',
      {
        text: 'Until then.',
        contactLabel: 'Contact the host',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
      'simple',
    ),
  ],
};

export const demoDayStarter: StarterDoc = {
  id: 'demo-day',
  name: 'Demo Day',
  description:
    'Live demos then a reception: countdown, cohort stats, presenting companies, sponsors.',
  themePresetId: 'blueprint',
  access: 'approval',
  visibility: 'public',
  sessions: [
    { name: 'Demos', offsetMinutes: 0, durationMinutes: 180, capacity: 200 },
    { name: 'Reception', offsetMinutes: 180, durationMinutes: 120, capacity: 200 },
  ],
  sections: [
    sectionTemplate(
      'hero',
      {
        eyebrow: 'Demo Day · Spring cohort',
        headline: 'Ten companies. Six minutes each.',
        subheadline: "Live demos from this season's founders, then drinks with the teams.",
        showDate: true,
        showVenue: true,
        ctaLabel: 'Request a seat',
        ctaTarget: 'rsvp',
      },
      'framed',
    ),
    sectionTemplate(
      'details',
      { showDate: true, showTime: true, showVenue: true, showTimezone: true, items: [] },
      'card',
    ),
    sectionTemplate(
      'countdown',
      {
        heading: 'Doors open in',
        target: 'event',
        liveLabel: 'Demos are live',
        endedLabel: 'Thanks for coming',
      },
      'digital',
    ),
    sectionTemplate(
      'stats',
      {
        heading: 'This cohort',
        stats: [
          { value: '10', label: 'companies demoing' },
          { value: '6', label: 'minutes each' },
          { value: '4', label: 'countries' },
          { value: '1', label: 'reception after' },
        ],
        countUp: true,
      },
      'stats',
    ),
    sectionTemplate(
      'agenda',
      {
        heading: 'Run of show',
        intro: '',
        items: [
          { time: '3:00 PM', title: 'Doors open' },
          { time: '3:30 PM', title: 'Welcome' },
          { time: '3:40 PM', title: 'Demos, part one' },
          { time: '4:40 PM', title: 'Break' },
          { time: '5:00 PM', title: 'Demos, part two' },
          { time: '6:00 PM', title: 'Reception with the teams' },
        ],
      },
      'timeline',
    ),
    sectionTemplate(
      'hosts',
      {
        heading: 'Presenting companies',
        intro: '',
        people: [
          { name: 'Lumen Robotics', title: 'Warehouse automation' },
          { name: 'Fieldnote', title: 'Field service software' },
          { name: 'Brightwater Bio', title: 'Water testing' },
          { name: 'Parcel AI', title: 'Logistics planning' },
          { name: 'Kestrel Health', title: 'Clinic scheduling' },
          { name: 'Tidewell', title: 'Energy storage' },
        ],
      },
      'grid',
    ),
    sectionTemplate(
      'sponsors',
      {
        heading: 'With support from',
        intro: '',
        items: [
          { name: 'Example Partners', tier: 'presenting' },
          { name: 'Juniper Labs', tier: 'gold' },
          { name: 'Northfield Capital', tier: 'partner' },
          { name: 'Harbor Coffee', tier: 'community' },
        ],
      },
      'tiers',
    ),
    sectionTemplate(
      'venue',
      { heading: 'Venue', notes: '', showDirections: true, showMap: true },
      'map',
    ),
    sectionTemplate(
      'rsvp',
      {
        heading: 'Request a seat',
        body: 'Seats are confirmed in the order requests arrive.',
        cta: 'Request a seat',
        going: 'Going',
        maybe: 'Maybe',
        notGoing: "Can't go",
      },
      'inline',
    ),
    sectionTemplate(
      'faq',
      {
        heading: 'Questions',
        items: [
          { q: 'Is it recorded?', a: 'Demos are recorded and shared with attendees afterwards.' },
          { q: 'Can I meet the founders?', a: 'Yes, at the reception. Each team has a table.' },
        ],
      },
      'two_column',
    ),
    sectionTemplate(
      'footer',
      {
        text: '',
        contactLabel: 'Contact the organisers',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
      'columns',
    ),
  ],
};

export const holidayPartyStarter: StarterDoc = {
  id: 'holiday-party',
  name: 'Holiday Party',
  description:
    'A festive evening with plus-ones: timeline, last year’s photos, travel and a gift swap.',
  themePresetId: 'winter-lodge',
  access: 'open',
  visibility: 'unlisted',
  sessions: [{ name: 'Party', offsetMinutes: 0, durationMinutes: 270, capacity: 120 }],
  sections: [
    sectionTemplate(
      'hero',
      {
        eyebrow: "Season's greetings",
        headline: '',
        subheadline: 'Warm drinks, good music and the people who made this year. Bring a plus-one.',
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
        items: [{ label: 'Dress', value: 'Festive' }],
      },
      'chips',
    ),
    sectionTemplate(
      'text',
      {
        heading: 'Join us',
        body: 'It has been a big year, and we would love to celebrate it with you. Come for the cider, stay for the dancing.',
      },
      'single',
    ),
    sectionTemplate(
      'agenda',
      {
        heading: 'The evening',
        intro: '',
        items: [
          { time: '6:30 PM', title: 'Doors and mulled cider' },
          { time: '7:30 PM', title: 'A toast to the year' },
          { time: '8:00 PM', title: 'Dinner and the dessert bar' },
          { time: '9:00 PM', title: 'Music and dancing' },
          { time: '11:00 PM', title: 'Last call' },
        ],
      },
      'timeline',
    ),
    sectionTemplate('gallery', { heading: 'Last year', images: [] }, 'polaroid'),
    sectionTemplate(
      'info_cards',
      {
        heading: 'Good to know',
        items: [
          {
            title: 'Getting there',
            body: 'Street parking nearby; rideshare drop-off at the front.',
            icon: 'car',
          },
          { title: 'Gift swap', body: 'Optional: bring a wrapped gift under $25.', icon: 'gift' },
        ],
      },
      'travel',
    ),
    sectionTemplate(
      'rsvp',
      {
        heading: 'Will you be there?',
        body: '',
        cta: 'RSVP',
        going: 'Going',
        maybe: 'Maybe',
        notGoing: "Can't go",
      },
      'inline',
    ),
    sectionTemplate(
      'footer',
      {
        text: 'Happy holidays.',
        contactLabel: 'Contact the host',
        contactHref: '',
        links: [],
        showMadeWith: false,
      },
      'simple',
    ),
  ],
};
