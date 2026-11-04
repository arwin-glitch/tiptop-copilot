import type { MailLabel } from '@/lib/email/inbox-actions';

/**
 * The demo mailbox's own Gmail labels, fictional like the rest of the demo: a
 * numbered family, where picking one moves the thread out of the others, and
 * a few plain labels that go on and off freely, one nested (Gmail's "/"),
 * and Gmail-style colours on all but one. Demo label changes are kept
 * on the demo messages (`email_messages.labels`); nothing reaches Gmail.
 */
export const DEMO_MAIL_LABELS: readonly MailLabel[] = [
  { id: 'Label_901', name: '1: Reply today', color: { bg: '#fb4c2f', fg: '#ffffff' } },
  { id: 'Label_902', name: '2: This week', color: { bg: '#ffad47', fg: '#ffffff' } },
  { id: 'Label_903', name: '3: Waiting on them', color: { bg: '#fad165', fg: '#000000' } },
  { id: 'Label_904', name: '4: Read later', color: { bg: '#4a86e8', fg: '#ffffff' } },
  { id: 'Label_911', name: 'Deal flow', color: { bg: '#16a766', fg: '#ffffff' } },
  { id: 'Label_914', name: 'Deal flow/Intro requests', color: { bg: '#b65775', fg: '#ffffff' } },
  { id: 'Label_912', name: 'LP updates', color: { bg: '#43d692', fg: '#000000' } },
  { id: 'Label_913', name: 'Portfolio' },
];
