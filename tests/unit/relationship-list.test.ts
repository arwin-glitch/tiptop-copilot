import { describe, expect, it } from 'vitest';
import { isAutomatedAddress } from '@/lib/services/network';
import {
  asRelationshipSortKey,
  exchanges,
  sortRelationships,
  type RelationshipRow,
} from '@/lib/network/relationship-view';

/**
 * The relationship list is the product's answer to Affinity, and the thing that
 * makes it an answer rather than an imitation is that it never scores anybody.
 * It counts. So the rules worth pinning down are the ones that decide what gets
 * counted, what gets hidden, and where an absent value sorts — because each of
 * those is a place where a plausible shortcut would quietly invent a fact.
 */

function person(over: Partial<RelationshipRow> & { email: string }): RelationshipRow {
  return {
    name: null,
    inboundCount: 0,
    outboundCount: 0,
    meetingCount: 0,
    firstContactAt: '2026-01-01T00:00:00.000Z',
    lastContactAt: '2026-01-01T00:00:00.000Z',
    nextMeetingAt: null,
    awaitingUs: false,
    company: null,
    role: null,
    links: {
      dealId: null,
      dealName: null,
      portfolioCompanyId: null,
      portfolioCompanyName: null,
    },
    importedContactId: null,
    relationship: null,
    expertise: [],
    ...over,
  };
}

describe('automated address detection', () => {
  it('hides machinery that would otherwise crowd out real people', () => {
    for (const address of [
      'no-reply@stripe.com',
      'noreply@github.com',
      'do-not-reply@bank.com',
      'notifications@slack.com',
      'billing@vendor.io',
      'newsletter@substack.com',
      'bounce+123@mailgun.org',
      'digest@news.co',
    ]) {
      expect(isAutomatedAddress(address), address).toBe(true);
    }
  });

  it('keeps anything it is not sure about, because a hidden person is the worse error', () => {
    for (const address of [
      'priya@vetrix.demo',
      'nick@tiptop.vc',
      'j.baptiste@meridianops.demo',
      'founder+tiptop@startup.io',
      // A real person at a company whose name merely contains a flagged word.
      'dana@newsroom-capital.com',
      'tom@supportive.vc',
    ]) {
      expect(isAutomatedAddress(address), address).toBe(false);
    }
  });

  it('treats a malformed address as machinery rather than crashing', () => {
    expect(isAutomatedAddress('not-an-address')).toBe(true);
    expect(isAutomatedAddress('@nolocal.com')).toBe(true);
  });
});

describe('ordering', () => {
  it('sends people with no recorded company to the end, not to the top of an A-Z', () => {
    // The trap: null sorting as an empty string puts everyone unknown first and
    // buries the companies the reader actually asked to see.
    const rows = [
      person({ email: 'c@x.com', company: null, name: 'Zoe' }),
      person({ email: 'a@x.com', company: 'Arborworks' }),
      person({ email: 'b@x.com', company: 'Bellhaven' }),
    ];

    const sorted = sortRelationships(rows, 'company', 'asc');
    expect(sorted.map((r) => r.company)).toEqual(['Arborworks', 'Bellhaven', null]);

    // And still at the end when the direction flips — absent is not "lowest".
    const reversed = sortRelationships(rows, 'company', 'desc');
    expect(reversed[reversed.length - 1]?.company).toBeNull();
  });

  it('sorts a nameless contact by their address rather than dropping them to one end', () => {
    const rows = [
      person({ email: 'zeta@x.com' }),
      person({ email: 'alpha@x.com' }),
      person({ email: 'mid@x.com', name: 'Mona' }),
    ];

    expect(sortRelationships(rows, 'person', 'asc').map((r) => r.name ?? r.email)).toEqual([
      'alpha@x.com',
      'Mona',
      'zeta@x.com',
    ]);
  });

  it('counts exchanges in both directions', () => {
    expect(exchanges(person({ email: 'a@x.com', inboundCount: 11, outboundCount: 4 }))).toBe(15);
  });

  it('ranks by total contact, not by whichever direction is larger', () => {
    const chatty = person({ email: 'chatty@x.com', inboundCount: 1, outboundCount: 20 });
    const quiet = person({ email: 'quiet@x.com', inboundCount: 9, outboundCount: 0 });

    expect(sortRelationships([quiet, chatty], 'exchanges', 'desc')[0]?.email).toBe('chatty@x.com');
  });

  it('defaults to most recent contact for an unknown sort key', () => {
    expect(asRelationshipSortKey(undefined)).toBe('last');
    expect(asRelationshipSortKey('nonsense')).toBe('last');
    expect(asRelationshipSortKey('meetings')).toBe('meetings');
  });

  it('orders by last contact with the most recent first', () => {
    const rows = [
      person({ email: 'old@x.com', lastContactAt: '2026-01-01T00:00:00.000Z' }),
      person({ email: 'new@x.com', lastContactAt: '2026-08-01T00:00:00.000Z' }),
    ];
    expect(sortRelationships(rows, 'last', 'desc')[0]?.email).toBe('new@x.com');
  });

  it('puts someone you have only ever been booked to meet at the end, not the top', () => {
    // The bug this pins down shipped in the first version of the screen: a
    // meeting in tomorrow's diary was treated as contact, so the list reported
    // "last contact: 6 hours from now". A booking is not an encounter, so the
    // date is null — and null belongs at the end in either direction, exactly
    // like an unscored deal.
    const stranger = person({
      email: 'stranger@x.com',
      firstContactAt: null,
      lastContactAt: null,
      nextMeetingAt: '2026-12-01T00:00:00.000Z',
    });
    const known = person({ email: 'known@x.com', lastContactAt: '2026-02-01T00:00:00.000Z' });

    expect(sortRelationships([stranger, known], 'last', 'desc').at(-1)?.email).toBe(
      'stranger@x.com',
    );
    expect(sortRelationships([stranger, known], 'last', 'asc').at(-1)?.email).toBe(
      'stranger@x.com',
    );
  });
});
