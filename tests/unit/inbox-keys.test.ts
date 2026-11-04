import { describe, expect, it } from 'vitest';
import { readKey, SHORTCUT_GROUPS, type KeyPrefix } from '@/lib/email/inbox-keys';

const press = (key: string, prefix: KeyPrefix = null, extra: object = {}) =>
  readKey({ key, ...extra }, prefix);

describe("Gmail's keys", () => {
  it('maps the single keys', () => {
    const cases: [string, string, object?][] = [
      ['c', 'compose'],
      ['/', 'search'],
      ['?', 'help'],
      ['j', 'next'],
      ['k', 'prev'],
      ['o', 'open'],
      ['Enter', 'open'],
      ['u', 'back'],
      ['e', 'archive'],
      ['[', 'archivePrev'],
      [']', 'archiveNext'],
      ['#', 'delete'],
      ['!', 'spam'],
      ['s', 'star'],
      ['+', 'important'],
      ['-', 'notImportant'],
      ['l', 'label'],
      ['v', 'move'],
      ['b', 'snooze'],
      ['r', 'reply'],
      ['a', 'replyAll'],
      ['f', 'forward'],
      ['x', 'select'],
      ['I', 'markRead', { shift: true }],
      ['U', 'markUnread', { shift: true }],
    ];
    for (const [key, command, extra] of cases) {
      expect(press(key, null, extra).command, key).toBe(command);
    }
  });

  it('waits for the second key after g and *', () => {
    expect(press('g')).toEqual({ command: null, prefix: 'g' });
    expect(press('*', null, { shift: true })).toEqual({ command: null, prefix: '*' });
    expect(press('i', 'g').command).toBe('goInbox');
    expect(press('s', 'g').command).toBe('goStarred');
    expect(press('t', 'g').command).toBe('goSent');
    expect(press('d', 'g').command).toBe('goDrafts');
    expect(press('a', 'g').command).toBe('goAll');
    expect(press('a', '*').command).toBe('selectAll');
    expect(press('n', '*').command).toBe('selectNone');
    expect(press('r', '*').command).toBe('selectRead');
    expect(press('u', '*').command).toBe('selectUnread');
    // A second key that means nothing ends the sequence without running anything.
    expect(press('q', 'g')).toEqual({ command: null, prefix: null });
    // After g, s is "go to Starred", never "star".
    expect(press('s', 'g').command).not.toBe('star');
  });

  it("never takes a key with Ctrl, Cmd or Alt (the browser's), or a stray capital", () => {
    expect(press('c', null, { ctrl: true }).command).toBeNull();
    expect(press('e', null, { meta: true }).command).toBeNull();
    expect(press('e', null, { alt: true }).command).toBeNull();
    expect(press('E').command).toBeNull();
    expect(press('e', null, { shift: true }).command).toBeNull();
  });

  it('lists every shortcut in the help overlay', () => {
    const all = SHORTCUT_GROUPS.flatMap((g) => g.keys.map((k) => k.keys)).join(' | ');
    for (const k of ['#', '!', 'g then i', '* then a', 'Shift+i', 'Ctrl+Enter', '?', 'v', 'l']) {
      expect(all, k).toContain(k);
    }
  });
});
