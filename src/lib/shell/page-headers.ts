/**
 * Each tab's header words, kept apart from the pages so the page and its
 * loading skeleton (`loading.tsx`) print the same title and subtitle. The
 * skeleton shows the instant a tab is clicked; with the same words in the
 * same band, nothing moves when the real page streams in.
 */
export interface PageHeaderText {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}

export const PAGE_HEADERS = {
  followUps: {
    title: 'Follow-ups',
    subtitle:
      'Who is waiting on you, who you are waiting on, recaps drafted after your meetings, and meeting times drafted into replies. Every draft sits in Gmail for review; nothing is sent unless you tap Send in an email session.',
  },
  tasks: {
    title: 'Tasks',
    subtitle:
      'Things you owe someone. Who you are waiting on, and who is waiting on you, are on Follow-ups.',
  },
  deals: {
    title: 'Deals',
    subtitle:
      "Everything in the pipeline, with the current recommendation and how much of it rests on real evidence. Affinity's pipeline and watch lists sit beside it.",
  },
  inbox: {
    title: 'Inbox',
    subtitle:
      "Nick's Gmail, live and laid out like Gmail. Mail sends from his inbox only when someone taps Send (8 seconds to undo) or picks a Schedule time.",
  },
  calendar: {
    title: 'Calendar',
    subtitle:
      "Nick's calendar, live, by day, week or month, with his Google colour labels. Click an event for its card: whether it is a meeting or a block, why, and how it got there. Meetings ping his phone 5 minutes before; blocks never do.",
  },
  booking: {
    title: 'Booking',
    subtitle:
      "Nick's booking link: people pick a free time that passes his rules and it goes straight on his calendar. Open the months you want, close days, and see exactly what visitors see.",
  },
  portfolio: {
    title: 'Portfolio',
    subtitle:
      'Who needs help, what they asked for, and whether anyone in your network is actually a match.',
  },
  fundII: {
    title: 'Fund II',
    subtitle:
      'Who is reading your DocSend links, every LP conversation for Fund II and where it stands (read from your mail and carried over from Affinity; stages only, no amounts), and the updates you send LPs.',
  },
  meetings: {
    title: 'Meetings',
    subtitle:
      'Every note Granola has written, whether or not the company is already a deal, and every note carried over from Affinity. The record of what was actually said.',
  },
  network: {
    title: 'Network',
    subtitle:
      'Everyone you have actually corresponded or sat down with, counted from your own mail and calendar, students and interns from a twice-weekly mailbox scan, plus the investors, providers, operators and events carried over from Affinity. Every strength shows the evidence it was counted from.',
  },
  updates: {
    title: 'Dealflow reports',
    subtitle:
      "Weekly dealflow reports and Nick's update digests, read live from Slack, plus company updates that landed in Gmail since. Read-only.",
  },
  knowledge: {
    title: 'Knowledge',
    subtitle:
      'Thesis documents, memos, pass notes, market maps, your network, and everything carried over from Affinity. Retrieval is full-text over Postgres, with page-level citations.',
  },
  settings: {
    title: 'Settings',
    subtitle:
      'Your thesis, your thresholds, your integrations. Nothing here is inferred on your behalf.',
  },
  help: {
    eyebrow: 'Help & tours',
    title: 'How Kraken works',
    subtitle:
      'What every page holds and where to click. Tap Show me and the page walks you through itself.',
  },
  download: {
    title: 'Desktop app',
    subtitle: 'TipTop Kraken in its own window, with an icon in your Dock or taskbar.',
  },
  diagnostics: {
    title: 'Diagnostics',
    subtitle:
      'What is configured, what is missing, and whether each feed is still arriving. Values are never shown — only whether a variable is present and correctly shaped.',
  },
} as const satisfies Record<string, PageHeaderText>;
