/**
 * Gmail's keyboard shortcuts for the Inbox tab, as a pure map: a key (and
 * the `g` or `*` before it, for two-key shortcuts) to the command it runs.
 * The Inbox listens for keys and asks `readKey` what to do; the `?` overlay
 * draws `SHORTCUT_GROUPS`. No I/O here, so both are tested as plain data.
 */

export type InboxCommand =
  | 'compose'
  | 'search'
  | 'help'
  | 'next'
  | 'prev'
  | 'open'
  | 'back'
  | 'archive'
  | 'archivePrev'
  | 'archiveNext'
  | 'delete'
  | 'spam'
  | 'star'
  | 'important'
  | 'notImportant'
  | 'label'
  | 'move'
  | 'snooze'
  | 'markRead'
  | 'markUnread'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'select'
  | 'undo'
  | 'goInbox'
  | 'goStarred'
  | 'goSent'
  | 'goDrafts'
  | 'goAll'
  | 'selectAll'
  | 'selectNone'
  | 'selectRead'
  | 'selectUnread';

export type KeyPrefix = 'g' | '*' | null;

/** A key the browser reports, reduced to what the map reads. */
export interface KeyPress {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}

const AFTER_G: Record<string, InboxCommand> = {
  i: 'goInbox',
  s: 'goStarred',
  t: 'goSent',
  d: 'goDrafts',
  a: 'goAll',
};

const AFTER_STAR: Record<string, InboxCommand> = {
  a: 'selectAll',
  n: 'selectNone',
  r: 'selectRead',
  u: 'selectUnread',
};

const SINGLE: Record<string, InboxCommand> = {
  c: 'compose',
  '/': 'search',
  '?': 'help',
  j: 'next',
  k: 'prev',
  o: 'open',
  Enter: 'open',
  u: 'back',
  e: 'archive',
  '[': 'archivePrev',
  ']': 'archiveNext',
  '#': 'delete',
  '!': 'spam',
  s: 'star',
  '+': 'important',
  '=': 'important',
  '-': 'notImportant',
  l: 'label',
  v: 'move',
  b: 'snooze',
  I: 'markRead',
  U: 'markUnread',
  r: 'reply',
  a: 'replyAll',
  f: 'forward',
  x: 'select',
  z: 'undo',
};

/**
 * What a key press does. `prefix` is the `g` or `*` pressed just before (the
 * caller keeps it for a moment, then forgets it). Returns the command, if
 * any, and the prefix for the next key. Keys with Ctrl, Cmd or Alt are never
 * the Inbox's (they are the browser's), and Shift only counts where Gmail
 * uses it (Shift+I, Shift+U and the symbols it types).
 */
export function readKey(
  press: KeyPress,
  prefix: KeyPrefix,
): { command: InboxCommand | null; prefix: KeyPrefix } {
  if (press.ctrl || press.meta || press.alt) return { command: null, prefix: null };
  const key = press.key;
  if (prefix === 'g') return { command: AFTER_G[key.toLowerCase()] ?? null, prefix: null };
  if (prefix === '*') return { command: AFTER_STAR[key.toLowerCase()] ?? null, prefix: null };
  if (key === 'g' && !press.shift) return { command: null, prefix: 'g' };
  if (key === '*') return { command: null, prefix: '*' };
  // Shift+i and Shift+u arrive as I and U; a lone capital otherwise is not a shortcut.
  if (/^[A-Z]$/.test(key) && !press.shift) return { command: null, prefix: null };
  if (/^[a-z]$/.test(key) && press.shift) return { command: null, prefix: null };
  return { command: SINGLE[key] ?? null, prefix: null };
}

/** How long a `g` or `*` waits for its second key. */
export const PREFIX_MS = 1_500;

export interface ShortcutGroup {
  title: string;
  keys: { keys: string; what: string }[];
}

/** The `?` overlay: every shortcut above, in Gmail's groups. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Jumping',
    keys: [
      { keys: 'g then i', what: 'Go to Inbox' },
      { keys: 'g then s', what: 'Go to Starred' },
      { keys: 'g then t', what: 'Go to Sent' },
      { keys: 'g then d', what: 'Go to Drafts' },
      { keys: 'g then a', what: 'Go to All Mail' },
      { keys: '/', what: 'Search mail' },
    ],
  },
  {
    title: 'Threads',
    keys: [
      { keys: 'j / k', what: 'Older / newer conversation' },
      { keys: 'o or Enter', what: 'Open conversation' },
      { keys: 'u', what: 'Back to the list' },
      { keys: 'x', what: 'Select conversation' },
      { keys: '* then a / n', what: 'Select all / none' },
      { keys: '* then r / u', what: 'Select read / unread' },
    ],
  },
  {
    title: 'Actions',
    keys: [
      { keys: 'e', what: 'Archive' },
      { keys: '[ / ]', what: 'Archive and go newer / older' },
      { keys: '#', what: 'Delete (to Trash)' },
      { keys: '!', what: 'Report spam' },
      { keys: 's', what: 'Star or unstar' },
      { keys: '+ / -', what: 'Mark important / not important' },
      { keys: 'l', what: 'Label as' },
      { keys: 'v', what: 'Move to' },
      { keys: 'b', what: 'Snooze' },
      { keys: 'Shift+i / Shift+u', what: 'Mark read / unread' },
      { keys: 'z', what: 'Undo the last action' },
    ],
  },
  {
    title: 'Writing',
    keys: [
      { keys: 'c', what: 'Compose' },
      { keys: 'r', what: 'Reply' },
      { keys: 'a', what: 'Reply all' },
      { keys: 'f', what: 'Forward' },
      { keys: 'Ctrl+Enter', what: 'Send (in a compose window)' },
      { keys: 'Esc', what: 'Close a menu or window' },
      { keys: '?', what: 'Show these shortcuts' },
    ],
  },
];
