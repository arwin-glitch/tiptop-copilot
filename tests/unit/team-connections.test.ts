import { describe, expect, it } from 'vitest';
import { buildRelationshipIndex } from '@/lib/network/evidence';
import { lastTouchSentence, teamConnections } from '@/lib/network/connections';
import type { CalendarEvent, EmailMessage } from '@/lib/types/domain';

/**
 * "Who on the team knows them" and "last contact, by whom", split back out
 * of the relationship index, on invented people at .example domains.
 */

const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const DANA = 'dana@fund.example';
const DANA_ALIAS = 'dana@fund-alt.example';
const LEE = 'lee@fund.example';
const ORG = 'org-1';
const JO = 'jo@larkspur.example';

let seq = 0;
function msg(thread: string, days: number, from: string, to: string[]): EmailMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    organization_id: ORG,
    thread_id: thread,
    provider: 'google',
    provider_message_id: `p-${seq}`,
    subject: `Subject ${thread}`,
    snippet: '',
    from_name: null,
    from_address: from,
    to_addresses: to,
    cc_addresses: [],
    labels: [],
    is_unread: false,
    sent_at: ago(days),
    body_text: null,
    body_fetched_at: null,
    body_hash: null,
    has_attachments: false,
    category: 'personal_or_unrelated',
    category_confidence: null,
    category_source: null,
    importance: null,
    is_ignored: false,
    linked_deal_id: null,
    linked_portfolio_company_id: null,
    injection_flagged: false,
    created_at: ago(days),
    updated_at: ago(days),
  } as EmailMessage;
}

function meeting(id: string, days: number): CalendarEvent {
  return {
    id,
    organization_id: ORG,
    user_id: 'u',
    provider: 'google',
    provider_event_id: id,
    title: `Coffee ${id}`,
    description: null,
    location: null,
    starts_at: ago(days),
    ends_at: ago(days),
    all_day: false,
    attendees: [
      { name: 'Dana', email: DANA, response: 'accepted' },
      { name: 'Jo Park', email: JO, response: 'accepted' },
    ],
    organizer_email: DANA,
    is_private: false,
    created_at: ago(days),
    updated_at: ago(days),
  } as CalendarEvent;
}

const names = new Map([
  [DANA, 'Dana Example'],
  [DANA_ALIAS, 'Dana Example'],
  [LEE, 'Lee Sample'],
]);

function index(messages: EmailMessage[], events: CalendarEvent[] = []) {
  return buildRelationshipIndex(
    { messages, events, threads: [], ownAddresses: [DANA, DANA_ALIAS, LEE] },
    NOW,
  );
}

describe('teamConnections', () => {
  it('credits the sender of our mail and the recipients of theirs, merging aliases', () => {
    const idx = index([
      msg('t1', 50, DANA, [JO]),
      msg('t1', 49, JO, [DANA]),
      msg('t2', 10, DANA_ALIAS, [JO]),
      msg('t3', 200, JO, [LEE]),
    ]);
    const { connections, lastTouch } = teamConnections(idx, [JO], { now: NOW, teamNames: names });
    expect(connections.map((c) => c.name)).toEqual(['Dana Example', 'Lee Sample']);
    expect(connections[0]).toMatchObject({
      threads: 2,
      emails: 3,
      addresses: [DANA_ALIAS, DANA].sort(),
    });
    expect(connections[1]?.threads).toBe(1);
    expect(connections[0]!.score).toBeGreaterThan(connections[1]!.score);
    expect(lastTouch).toMatchObject({ kind: 'email', fromUs: true, from: DANA_ALIAS, to: JO });
    expect(lastTouchSentence(lastTouch!, names)).toBe(`Dana Example sent an email to ${JO}`);
  });

  it('says who wrote when they wrote last', () => {
    const idx = index([msg('t1', 5, DANA, [JO]), msg('t1', 4, JO, [DANA])]);
    const { lastTouch } = teamConnections(idx, [JO], { now: NOW, teamNames: names });
    expect(lastTouchSentence(lastTouch!, names, () => 'Jo Park')).toBe(
      'Jo Park emailed Dana Example',
    );
  });

  it('lets a later meeting be the last contact, and finds the first meeting', () => {
    const idx = index([msg('t1', 30, DANA, [JO])], [meeting('e1', 90), meeting('e2', 3)]);
    const detail = teamConnections(idx, [JO], { now: NOW, teamNames: names });
    expect(detail.lastTouch).toMatchObject({ kind: 'meeting', title: 'Coffee e2' });
    expect(detail.firstMeetingAt).toBe(ago(90));
    expect(lastTouchSentence(detail.lastTouch!)).toBe('Meeting: Coffee e2');
  });

  it('ignores mail dated ahead of now and has nothing for a stranger', () => {
    const idx = index([msg('t1', -3, DANA, [JO])]);
    expect(teamConnections(idx, [JO], { now: NOW }).lastTouch).toBeNull();
    expect(teamConnections(idx, ['nobody@else.example'], { now: NOW })).toEqual({
      connections: [],
      lastTouch: null,
      firstMeetingAt: null,
    });
  });
});
