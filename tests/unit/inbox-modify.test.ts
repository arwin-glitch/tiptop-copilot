import { describe, expect, it } from 'vitest';
import { leavesFolder, SYSTEM_ACTIONS, UNDO_OF } from '@/lib/email/inbox-modify';

describe("the Inbox's one-tap changes", () => {
  it('only ever touches the six labels the send path allows', () => {
    const allowed = new Set(['UNREAD', 'STARRED', 'INBOX', 'IMPORTANT', 'TRASH', 'SPAM']);
    for (const [action, change] of Object.entries(SYSTEM_ACTIONS)) {
      const labels = [
        ...(('add' in change ? change.add : []) as readonly string[]),
        ...(('remove' in change ? change.remove : []) as readonly string[]),
      ];
      expect(labels.length, action).toBeGreaterThan(0);
      for (const l of labels) expect(allowed.has(l), `${action}: ${l}`).toBe(true);
    }
  });

  it('has no permanent delete: Delete and Report spam are labels, each with an undo', () => {
    const names = Object.keys(SYSTEM_ACTIONS);
    for (const banned of ['delete', 'deleteForever', 'emptyTrash', 'purge', 'destroy']) {
      expect(names).not.toContain(banned);
    }
    expect(SYSTEM_ACTIONS.trash).toEqual({ add: ['TRASH'] });
    expect(SYSTEM_ACTIONS.spam).toEqual({ add: ['SPAM'], remove: ['INBOX'] });
    expect(UNDO_OF.trash).toBe('restore');
    expect(SYSTEM_ACTIONS.restore).toEqual({ add: ['INBOX'], remove: ['TRASH'] });
    expect(UNDO_OF.spam).toBe('notspam');
    expect(SYSTEM_ACTIONS.notspam).toEqual({ add: ['INBOX'], remove: ['SPAM'] });
  });

  it('knows which changes take a thread out of the folder on screen', () => {
    expect(leavesFolder('archive', 'inbox')).toBe(true);
    expect(leavesFolder('archive', 'starred')).toBe(false);
    expect(leavesFolder('trash', 'all')).toBe(true);
    expect(leavesFolder('trash', 'trash')).toBe(false);
    expect(leavesFolder('restore', 'trash')).toBe(true);
    expect(leavesFolder('notspam', 'spam')).toBe(true);
    expect(leavesFolder('unstar', 'starred')).toBe(true);
    expect(leavesFolder('read', 'inbox')).toBe(false);
  });
});
