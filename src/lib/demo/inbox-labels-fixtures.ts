import type { MailLabel } from '@/lib/email/inbox-actions';

/**
 * The demo mailbox's own Gmail labels, fictional like the rest of the demo: a
 * numbered family, where picking one moves the thread out of the others, and
 * a few plain labels that go on and off freely. Demo label changes are kept
 * on the demo messages (`email_messages.labels`); nothing reaches Gmail.
 */
export const DEMO_MAIL_LABELS: readonly MailLabel[] = [
  { id: 'Label_901', name: '1: Reply today' },
  { id: 'Label_902', name: '2: This week' },
  { id: 'Label_903', name: '3: Waiting on them' },
  { id: 'Label_904', name: '4: Read later' },
  { id: 'Label_911', name: 'Deal flow' },
  { id: 'Label_912', name: 'LP updates' },
  { id: 'Label_913', name: 'Portfolio' },
];
