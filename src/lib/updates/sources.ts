import type { UpdateSource } from '@/lib/updates/types';

/**
 * The channels the Updates tab mirrors. The IDs are not secrets, like the
 * relay channel ID: the channels are private and readable only by invited
 * members.
 *
 * One channel's name is a private person's name, so it is labelled here by its
 * role and addressed by ID only; the report's own heading, read at runtime,
 * identifies it on screen.
 */
export const UPDATE_SOURCES: readonly UpdateSource[] = [
  {
    key: 'pef',
    group: 'dealflow',
    label: 'PEF',
    channelId: 'C0BC93NTTSN',
    channelName: 'pef-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'rocket',
  },
  {
    key: 'openvc',
    group: 'dealflow',
    label: 'OpenVC',
    channelId: 'C0BKXJMF9AL',
    channelName: 'openvc-dealflow',
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'radar',
  },
  {
    key: 'referral',
    group: 'dealflow',
    label: 'Referral partner',
    channelId: 'C0BV1HS0CEL',
    channelName: null,
    cadence: 'Weekly · Fri',
    staleAfterDays: 8,
    icon: 'handshake',
  },
  {
    key: 'digest',
    group: 'digest',
    label: 'Nick Update Digest',
    channelId: 'C0C0E32Q6TT',
    channelName: 'nick-update-digest',
    cadence: 'Mon & Fri · month start/end',
    staleAfterDays: 5,
    icon: 'mailbox',
  },
];

/** `#name`, or `the <label> channel` when the name is not to be shown. */
export function channelLabel(source: UpdateSource): string {
  return source.channelName ? `#${source.channelName}` : `the ${source.label} channel`;
}
