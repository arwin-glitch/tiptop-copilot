import { describe, expect, it } from 'vitest';
import { inviteEmail, thisOnScreen, voiceAction, whenSaid } from '@/lib/voice/actions';

/** Voice Arwin's commands, read from what was said. Fictional names. */

// Tuesday 10 November 2026, 10:00 in this test's clock.
const NOW = new Date(2026, 10, 10, 10, 0, 0);
const TASK = '29927e7a-f2ce-4711-a8d4-a6aed476aa1e';
const onTask = { pathname: `/tasks/${TASK}`, search: '' };
const onThread = { pathname: '/inbox', search: '?thread=19a2b3c4d5e6f708' };
const elsewhere = { pathname: '/today', search: '' };

describe('voice actions: what "this" is', () => {
  it('reads the task or thread open on screen', () => {
    expect(thisOnScreen(onTask)).toEqual({ task: TASK });
    expect(thisOnScreen(onThread)).toEqual({ thread: '19a2b3c4d5e6f708' });
    expect(thisOnScreen(elsewhere)).toEqual({});
  });
});

describe('voice actions: when', () => {
  it('turns spoken times into a wake time', () => {
    expect(whenSaid('until tomorrow', NOW)?.at).toEqual(new Date(2026, 10, 11, 9, 0, 0));
    expect(whenSaid('until Monday', NOW)?.at).toEqual(new Date(2026, 10, 16, 9, 0, 0));
    expect(whenSaid('for 3 days', NOW)?.at).toEqual(new Date(2026, 10, 13, 9, 0, 0));
    expect(whenSaid('till next week', NOW)?.at).toEqual(new Date(2026, 10, 16, 9, 0, 0));
    expect(whenSaid('tonight', NOW)?.at).toEqual(new Date(2026, 10, 10, 18, 0, 0));
    expect(whenSaid('the deck', NOW)).toBeNull();
  });
});

describe('voice actions: commands', () => {
  it('snoozes what is open, tomorrow by default', () => {
    expect(voiceAction('Snooze this until Monday', onTask, NOW)).toMatchObject({
      kind: 'snooze',
      target: 'task',
      id: TASK,
      until: new Date(2026, 10, 16, 9, 0, 0),
    });
    expect(voiceAction('snooze it', onThread, NOW)).toMatchObject({
      kind: 'snooze',
      target: 'thread',
      until: new Date(2026, 10, 11, 9, 0, 0),
    });
    // Nothing open: not a command.
    expect(voiceAction('snooze this', elsewhere, NOW)).toBeNull();
  });

  it('marks the open task done', () => {
    expect(voiceAction('Mark this as done', onTask, NOW)).toEqual({ kind: 'done', taskId: TASK });
    expect(voiceAction('mark this done', elsewhere, NOW)).toBeNull();
  });

  it('adds a task, with its due day', () => {
    expect(voiceAction('Remind me to send Dana the deck by Friday', elsewhere, NOW)).toMatchObject({
      kind: 'new_task',
      title: 'Send Dana the deck',
      dueAt: new Date(2026, 10, 13, 9, 0, 0),
    });
    expect(voiceAction('Add a task to call Brightwave', elsewhere, NOW)).toMatchObject({
      kind: 'new_task',
      title: 'Call Brightwave',
      dueAt: null,
    });
  });

  it('drafts a reply to a person, with what to say', () => {
    expect(voiceAction('Reply to Dana saying Wednesday works', elsewhere, NOW)).toEqual({
      kind: 'reply',
      who: 'Dana',
      text: 'Wednesday works',
    });
    expect(voiceAction('Draft a reply to Dana Holt', elsewhere, NOW)).toEqual({
      kind: 'reply',
      who: 'Dana Holt',
      text: '',
    });
  });

  it('invites someone to meet', () => {
    expect(voiceAction('Book Nick a coffee with Sam Ortiz', elsewhere, NOW)).toEqual({
      kind: 'invite',
      who: 'Sam Ortiz',
      meeting: 'coffee',
    });
    expect(voiceAction('set up a call with Dana', elsewhere, NOW)).toEqual({
      kind: 'invite',
      who: 'Dana',
      meeting: 'call',
    });
    expect(voiceAction('invite Sam to dinner', elsewhere, NOW)).toEqual({
      kind: 'invite',
      who: 'Sam',
      meeting: 'dinner',
    });
  });

  it('leaves questions alone', () => {
    expect(voiceAction("What's on today?", elsewhere, NOW)).toBeNull();
    expect(voiceAction('Open my inbox', elsewhere, NOW)).toBeNull();
    expect(voiceAction('What did Dana say about the deck?', elsewhere, NOW)).toBeNull();
  });
});

describe('voice actions: the invite email', () => {
  it('links the booking page on that meeting, and is never sent', () => {
    const mail = inviteEmail(
      { name: 'Sam Ortiz', email: 'sam@example.com' },
      'coffee',
      'https://app.example',
    );
    expect(mail.to).toBe('sam@example.com');
    expect(mail.text).toContain('Hi Sam,');
    expect(mail.text).toContain('https://app.example/meet/nick?meal=coffee');
  });
});
