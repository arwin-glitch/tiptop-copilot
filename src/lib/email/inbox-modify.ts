/**
 * The Inbox's one-tap changes as Gmail label changes, shared by the modify
 * route and its tests. Delete is the TRASH label and Report spam the SPAM
 * label, so each is undone by taking that label off again: nothing here is a
 * permanent delete. There is deliberately no "delete forever" and no "empty
 * trash" action.
 */

export type SystemLabel = 'UNREAD' | 'STARRED' | 'INBOX' | 'IMPORTANT' | 'TRASH' | 'SPAM';

export const SYSTEM_ACTIONS = {
  archive: { remove: ['INBOX'] },
  inbox: { add: ['INBOX'] },
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] },
  important: { add: ['IMPORTANT'] },
  unimportant: { remove: ['IMPORTANT'] },
  /** Delete: to Trash, where Gmail keeps it 30 days. */
  trash: { add: ['TRASH'] },
  /** Undo a delete made outside the inbox. */
  untrash: { remove: ['TRASH'] },
  /** Undo a delete made in the inbox, and Trash's "Move to Inbox". */
  restore: { add: ['INBOX'], remove: ['TRASH'] },
  /** Report spam: out of the inbox, into Spam. */
  spam: { add: ['SPAM'], remove: ['INBOX'] },
  /** Not spam (and the Undo of Report spam): back to the inbox. */
  notspam: { add: ['INBOX'], remove: ['SPAM'] },
} as const satisfies Record<string, { add?: SystemLabel[]; remove?: SystemLabel[] }>;

export type SystemAction = keyof typeof SYSTEM_ACTIONS;

/** What undoes each action, for the toast's Undo and the z key. */
export const UNDO_OF: Partial<Record<SystemAction, SystemAction>> = {
  archive: 'inbox',
  trash: 'restore',
  spam: 'notspam',
  notspam: 'spam',
  restore: 'trash',
  untrash: 'trash',
  read: 'unread',
  unread: 'read',
  star: 'unstar',
  unstar: 'star',
  important: 'unimportant',
  unimportant: 'important',
  inbox: 'archive',
};

/** Actions that take a thread out of the folder on screen, by folder. */
export function leavesFolder(action: SystemAction, folder: string): boolean {
  switch (action) {
    case 'archive':
      return folder === 'inbox';
    case 'trash':
      return folder !== 'trash';
    case 'spam':
      return folder !== 'spam';
    case 'notspam':
      return folder === 'spam';
    case 'restore':
    case 'untrash':
      return folder === 'trash';
    case 'unstar':
      return folder === 'starred';
    case 'unimportant':
      return folder === 'important';
    case 'inbox':
      return folder === 'spam' || folder === 'trash';
    default:
      return false;
  }
}
