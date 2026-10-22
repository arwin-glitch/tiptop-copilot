import { describe, expect, it } from 'vitest';
import { EMPTY_GUEST_COUNTS } from '@/lib/events/contracts';
import { EVENT_DETAIL_TAB_DEFS, EVENTS_LIBRARY_TABS } from '@/lib/events/library-tabs';
import {
  audienceGuestIds,
  cleanOffsets,
  computeFunnel,
  countsLine,
  formatWhen,
  nextActions,
  offsetLabel,
  readinessChecklist,
  reminderNeedsYou,
  reminderSlots,
  statusChip,
  tagCounts,
  type GuestRow,
  type GuestSessionRow,
  type ReadinessInput,
} from '@/lib/events/tab-view';

/**
 * The Events tab's view logic (D-075, WS5): pure, so every rule a page shows
 * is pinned here. Fictional ids and names only.
 */

const NOW = new Date('2026-11-01T18:00:00Z');
const day = 86_400_000;

describe('status chips', () => {
  const base = {
    status: 'published' as const,
    visibility: 'public' as const,
    access: 'open' as const,
    isTemplate: false,
    startsAt: new Date(NOW.getTime() + 10 * day).toISOString(),
    endsAt: null,
  };

  it('names every state the library shows', () => {
    expect(statusChip(base, NOW).label).toBe('Live');
    expect(statusChip({ ...base, visibility: 'unlisted' }, NOW).label).toBe('Unlisted');
    expect(statusChip({ ...base, visibility: 'private' }, NOW).label).toBe('Private');
    expect(statusChip({ ...base, access: 'invite_only' }, NOW).label).toBe('Invite-only');
    expect(statusChip({ ...base, status: 'draft' }, NOW).label).toBe('Draft');
    expect(statusChip({ ...base, status: 'cancelled' }, NOW)).toEqual({
      label: 'Cancelled',
      tone: 'danger',
    });
    expect(statusChip({ ...base, status: 'archived' }, NOW).label).toBe('Archived');
    expect(statusChip({ ...base, isTemplate: true, status: 'draft' }, NOW).label).toBe('Template');
  });

  it('calls an event past once it has ended, whatever its access', () => {
    const ended = { ...base, access: 'invite_only' as const, startsAt: '2026-10-01T18:00:00Z' };
    expect(statusChip(ended, NOW).label).toBe('Past');
  });
});

describe('dates in the venue time zone', () => {
  it('reads a same-day event with one zone name', () => {
    expect(formatWhen('2027-01-25T19:00:00Z', '2027-01-26T03:00:00Z', 'America/Chicago')).toBe(
      'Mon, Jan 25, 2027 · 1:00 PM – 9:00 PM CST',
    );
  });

  it('reads a multi-day event as a range, and says when there is no date', () => {
    expect(formatWhen('2027-03-01T15:00:00Z', '2027-03-03T22:00:00Z', 'America/New_York')).toBe(
      'Mar 1 – Mar 3, 2027',
    );
    expect(formatWhen(null, null, 'America/Chicago')).toBe('Date not set');
    expect(formatWhen('2027-01-25T19:00:00Z', null, 'Europe/London')).toBe(
      'Mon, Jan 25, 2027 · 7:00 PM GMT',
    );
  });
});

describe('reminders', () => {
  it('labels offsets the way people say them', () => {
    expect(offsetLabel(10_080)).toBe('1 week before');
    expect(offsetLabel(20_160)).toBe('2 weeks before');
    expect(offsetLabel(1_440)).toBe('1 day before');
    expect(offsetLabel(180)).toBe('3 hours before');
    expect(offsetLabel(90)).toBe('90 minutes before');
  });

  it('cleans a schedule: unique, longest first, in range, six at most', () => {
    expect(cleanOffsets([180, 10_080, 1_440, 180])).toEqual([10_080, 1_440, 180]);
    expect(cleanOffsets([0])).toBeNull();
    expect(cleanOffsets([86_401])).toBeNull();
    expect(cleanOffsets([1.5])).toBeNull();
    expect(cleanOffsets([1, 2, 3, 4, 5, 6, 7])).toBeNull();
    expect(cleanOffsets([])).toEqual([]);
  });

  const session = {
    id: '00000000-0000-4000-8000-00000000a001',
    name: 'Evening Reception',
    starts_at: new Date(NOW.getTime() + 2 * day).toISOString(),
  };

  it('works out each slot: scheduled, due, drafted, sent, missed', () => {
    const slots = reminderSlots([session], [10_080, 1_440, 180], [], NOW);
    expect(slots.map((s) => [s.label, s.state])).toEqual([
      ['1 week before', 'due'],
      ['1 day before', 'scheduled'],
      ['3 hours before', 'scheduled'],
    ]);
    const drafted = reminderSlots(
      [session],
      [10_080],
      [{ id: 'c1', status: 'draft', sessionId: session.id, offsetMinutes: 10_080 }],
      NOW,
    );
    expect(drafted[0]).toMatchObject({ state: 'drafted', campaignId: 'c1' });
    const sent = reminderSlots(
      [session],
      [10_080],
      [
        { id: 'c1', status: 'cancelled', sessionId: session.id, offsetMinutes: 10_080 },
        { id: 'c2', status: 'sent', sessionId: session.id, offsetMinutes: 10_080 },
      ],
      NOW,
    );
    expect(sent[0]).toMatchObject({ state: 'sent', campaignId: 'c2' });
    const later = new Date(NOW.getTime() + 3 * day);
    expect(reminderSlots([session], [180], [], later)[0]?.state).toBe('missed');
  });

  it('asks for a person when due, or when a draft sits past its time', () => {
    const [due] = reminderSlots([session], [10_080], [], NOW);
    expect(due && reminderNeedsYou(due, NOW)).toBe(true);
    const [scheduled] = reminderSlots([session], [180], [], NOW);
    expect(scheduled && reminderNeedsYou(scheduled, NOW)).toBe(false);
    const [early] = reminderSlots(
      [session],
      [180],
      [{ id: 'c3', status: 'draft', sessionId: session.id, offsetMinutes: 180 }],
      NOW,
    );
    // Prepared ahead: not nagging until it falls due.
    expect(early && reminderNeedsYou(early, NOW)).toBe(false);
  });

  it('skips sessions with no time', () => {
    expect(reminderSlots([{ ...session, starts_at: null }], [180], [], NOW)).toEqual([]);
  });
});

describe('the Ready checklist and next actions', () => {
  const ready: ReadinessInput = {
    status: 'published',
    access: 'invite_only',
    visibility: 'unlisted',
    startsAt: '2027-01-25T19:00:00Z',
    venueSet: true,
    sessions: 2,
    publishedAt: '2026-10-20T16:00:00Z',
    unpublishedChanges: 0,
    sectionCount: 6,
    hasRsvpBlock: true,
    registrationOpen: true,
    guests: 40,
    invitesSent: 1,
    invitesDrafted: 0,
    reminderOffsets: 3,
    seoDescription: '',
  };

  it('is all done for a published invite-only event with invites out', () => {
    const items = readinessChecklist(ready);
    expect(items.map((i) => i.key)).toEqual([
      'details',
      'page',
      'guests',
      'published',
      'invites',
      'reminders',
    ]);
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('asks for search text on a public page only, and for invites only when invites come first', () => {
    const open = readinessChecklist({ ...ready, access: 'open', visibility: 'public' });
    expect(open.map((i) => i.key)).toEqual([
      'details',
      'page',
      'guests',
      'published',
      'reminders',
      'seo',
    ]);
    expect(open.find((i) => i.key === 'seo')?.done).toBe(false);
    expect(open.find((i) => i.key === 'guests')?.label).toBe('Registration open');
  });

  it('points each open item at the place to fix it', () => {
    const draft = readinessChecklist({
      ...ready,
      status: 'draft',
      publishedAt: null,
      hasRsvpBlock: false,
      guests: 0,
      invitesSent: 0,
      invitesDrafted: 1,
    });
    expect(draft.find((i) => i.key === 'page')).toMatchObject({ done: false, tab: 'studio' });
    expect(draft.find((i) => i.key === 'published')).toMatchObject({ done: false, tab: 'studio' });
    expect(draft.find((i) => i.key === 'guests')).toMatchObject({ done: false, tab: 'guests' });
    expect(draft.find((i) => i.key === 'invites')?.detail).toMatch(/waiting for your review/);
  });

  it('orders next actions by urgency, at most four', () => {
    const actions = nextActions({
      eventId: 'e1',
      status: 'cancelled',
      pending: 3,
      needsNotifying: 2,
      remindersReady: 1,
      outsideEdits: 2,
      unpublishedChanges: 4,
      updateFor: null,
      cancellationFor: 12,
      firstOpenItem: null,
    });
    expect(actions.map((a) => a.key)).toEqual(['cancellation', 'pending', 'notify', 'reminder']);
    expect(actions[0]?.href).toBe('/events/e1?tab=messages');
    expect(actions[1]?.label).toBe('3 people are waiting for approval');
  });

  it('falls back to the first open checklist item, and to publishing changes', () => {
    const actions = nextActions({
      eventId: 'e1',
      status: 'published',
      pending: 0,
      needsNotifying: 0,
      remindersReady: 0,
      outsideEdits: 0,
      unpublishedChanges: 1,
      updateFor: null,
      cancellationFor: null,
      firstOpenItem: readinessChecklist({ ...ready, reminderOffsets: 0 }).find((i) => !i.done)!,
    });
    expect(actions.map((a) => a.key)).toEqual(['publish', 'ready-reminders']);
    expect(actions[0]?.href).toBe('/events/e1/studio');
  });
});

describe('audiences and the funnel', () => {
  const g = (id: string, email: string | null, tags: string[] = [], parent: string | null = null) =>
    ({ id, email, tags, parent_guest_id: parent }) satisfies GuestRow;
  const guests: GuestRow[] = [
    g('a', 'avery@example.com', ['LP']),
    g('b', 'bianca@example.com', ['LP', 'Co-investor']),
    g('c', 'carlos@example.com', ['Founder']),
    g('d', 'dana@example.com', ['lp']),
    g('p', null, [], 'a'),
  ];
  const r = (
    guest: string,
    session: string,
    status: GuestSessionRow['status'],
    checkedIn = false,
  ) =>
    ({
      guest_id: guest,
      session_id: session,
      status,
      checked_in_at: checkedIn ? '2026-11-01T18:00:00Z' : null,
    }) satisfies GuestSessionRow;
  const rows: GuestSessionRow[] = [
    r('a', 's1', 'going', true),
    r('a', 's2', 'going'),
    r('b', 's1', 'maybe'),
    r('b', 's2', 'going'),
    r('c', 's2', 'invited'),
    r('d', 's1', 'not_going'),
    r('d', 's2', 'pending'),
    r('p', 's2', 'going'),
  ];

  it('counts an audience among guests with an email, by status, tag, session or check-in', () => {
    expect(audienceGuestIds(guests, rows, { kind: 'all' })).toEqual(['a', 'b', 'c', 'd']);
    expect(audienceGuestIds(guests, rows, { kind: 'status', statuses: ['going'] })).toEqual([
      'a',
      'b',
    ]);
    expect(
      audienceGuestIds(guests, rows, { kind: 'status', statuses: ['going'], sessionId: 's1' }),
    ).toEqual(['a']);
    expect(audienceGuestIds(guests, rows, { kind: 'tag', tag: 'LP' })).toEqual(['a', 'b', 'd']);
    expect(audienceGuestIds(guests, rows, { kind: 'checked_in' })).toEqual(['a']);
    expect(audienceGuestIds(guests, rows, { kind: 'all', sessionId: 's1' })).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(audienceGuestIds(guests, rows, { kind: 'guests', guestIds: ['c', 'p', 'zz'] })).toEqual([
      'c',
    ]);
  });

  it('tallies tags case-insensitively, most used first', () => {
    expect(tagCounts(guests)).toEqual([
      { tag: 'LP', count: 3 },
      { tag: 'Co-investor', count: 1 },
      { tag: 'Founder', count: 1 },
    ]);
  });

  it('walks invited → delivered → opened → viewed → answered → going, with the nudge segments', () => {
    const recipient = (
      email: string,
      extra: Partial<{ opened: boolean; bounced: boolean }> = {},
    ) => ({
      email,
      status: 'sent' as const,
      sent_at: '2026-10-20T16:00:00Z',
      opened_at: extra.opened ? '2026-10-20T17:00:00Z' : null,
      clicked_at: null,
      bounced_at: extra.bounced ? '2026-10-20T16:01:00Z' : null,
      replied_at: null,
    });
    const funnel = computeFunnel({
      guests,
      rows,
      sessions: [
        { id: 's1', name: 'Annual Meeting' },
        { id: 's2', name: 'Evening Reception' },
      ],
      recipients: [
        recipient('AVERY@example.com', { opened: true }),
        recipient('bianca@example.com'),
        recipient('carlos@example.com'),
        recipient('dana@example.com', { bounced: true }),
      ],
      viewed: new Set(['a', 'c']),
    });
    expect(funnel).toMatchObject({
      invited: 4,
      delivered: 3,
      opened: 1,
      viewed: 2,
      responded: 3,
      going: 2,
    });
    expect(funnel.segments).toEqual({ openedNoReply: [], neverOpened: ['c'] });
    expect(funnel.perSession).toEqual([
      { sessionId: 's1', name: 'Annual Meeting', invited: 3, responded: 3, going: 1 },
      { sessionId: 's2', name: 'Evening Reception', invited: 4, responded: 3, going: 2 },
    ]);
  });

  it('writes the card counts line', () => {
    expect(countsLine({ ...EMPTY_GUEST_COUNTS, going: 12, pending: 3, waitlist: 2 })).toBe(
      '12 going · 3 pending · 2 waitlist',
    );
    expect(countsLine({ ...EMPTY_GUEST_COUNTS, going: 0, invited: 40 })).toBe(
      '0 going · 40 invited',
    );
  });
});

describe('the tab bars', () => {
  const navNames = ['Today', 'Tasks', 'Deals', 'Calendar', 'Events', 'Settings', 'Network'];
  it('keep labels clear of menu names (Playwright matches by substring)', () => {
    for (const tab of [...EVENT_DETAIL_TAB_DEFS, ...EVENTS_LIBRARY_TABS.tabs]) {
      for (const name of navNames) {
        expect(tab.label.toLowerCase(), tab.key).not.toContain(name.toLowerCase());
      }
    }
  });

  it('cover every detail tab of the contract, overview first', () => {
    expect(EVENT_DETAIL_TAB_DEFS.map((t) => t.key)).toEqual([
      'overview',
      'page',
      'guests',
      'registration',
      'messages',
      'checkin',
      'sharing',
      'settings',
    ]);
  });
});
