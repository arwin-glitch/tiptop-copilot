import { describe, expect, it } from 'vitest';
import { instantIntent } from '@/lib/services/instant-answers';

/**
 * Ask Arwin's fast lane only takes the everyday shapes; anything more
 * specific goes to the full Arwin. Fictional names.
 */

describe('instant answers: which questions are everyday ones', () => {
  it('reads the calendar questions', () => {
    expect(instantIntent("What's on today?")).toEqual({ kind: 'calendar', day: 0 });
    expect(instantIntent("Hey Arwin, what's on Nick's calendar tomorrow")).toEqual({
      kind: 'calendar',
      day: 1,
    });
    expect(instantIntent('What meetings do I have today?')).toEqual({ kind: 'calendar', day: 0 });
    expect(instantIntent("What's my next meeting?")).toEqual({ kind: 'next_meeting' });
  });

  it('reads the task questions', () => {
    expect(instantIntent("What's overdue?")).toEqual({ kind: 'tasks', scope: 'overdue' });
    expect(instantIntent('overdue tasks')).toEqual({ kind: 'tasks', scope: 'overdue' });
    expect(instantIntent("What's due today?")).toEqual({ kind: 'tasks', scope: 'today' });
    expect(instantIntent('What does Nick owe?')).toEqual({ kind: 'tasks', scope: 'all' });
  });

  it('reads the Follow-ups questions', () => {
    expect(instantIntent("Who's waiting on Nick?")).toEqual({ kind: 'waiting_on_us' });
    expect(instantIntent('who is waiting on me')).toEqual({ kind: 'waiting_on_us' });
    expect(instantIntent('Who are we waiting on?')).toEqual({ kind: 'we_wait' });
    expect(instantIntent("Who hasn't replied?")).toEqual({ kind: 'we_wait' });
  });

  it('reads last-contact questions with the name', () => {
    expect(instantIntent('When did we last talk to Dana Holt?')).toEqual({
      kind: 'last_contact',
      who: 'dana holt',
    });
    expect(instantIntent('when did Nick last email Brightwave')).toEqual({
      kind: 'last_contact',
      who: 'brightwave',
    });
  });

  it('sends anything more specific to the full Arwin', () => {
    expect(instantIntent("What's on today with Dana about the deck?")).toBeNull();
    expect(instantIntent('What did Dana say about the Brightwave term sheet?')).toBeNull();
    expect(instantIntent('Draft a reply to Dana')).toBeNull();
    expect(instantIntent('Summarize the Northpeak board meeting notes')).toBeNull();
  });
});
