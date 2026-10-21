import { describe, expect, it } from 'vitest';
import {
  choosePrincipal,
  inTeamOrder,
  mailboxMember,
  principalMailbox,
  type MailboxRow,
  type TeamMember,
} from '@/lib/tasks/principal';

/**
 * The principal: whose work an organization's work is. Every person, address
 * and id here is invented. The shape that matters is a team where the person
 * who set the organization up (the owner) is not the person whose mailbox the
 * app reads.
 */

const OPS = '00000000-0000-4000-8000-00000000a001'; // set the organization up
const LEAD = '00000000-0000-4000-8000-00000000a002'; // whose mailbox it is
const THIRD = '00000000-0000-4000-8000-00000000a003';

function member(userId: string, overrides: Partial<TeamMember> = {}, daysAgo = 10): TeamMember {
  return {
    userId,
    role: 'member',
    email: null,
    fullName: null,
    createdAt: new Date(Date.UTC(2026, 9, 21) - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
}

function mailbox(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: '00000000-0000-4000-8000-00000000b001',
    user_id: OPS,
    provider: 'google',
    kinds: ['gmail', 'calendar'],
    account_email: 'lead@fund.example',
    status: 'connected',
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const TEAM: TeamMember[] = [
  member(OPS, { role: 'owner', email: 'ops@fund.example', fullName: 'Jordan Vale' }, 30),
  member(LEAD, { email: 'lead@fund.example', fullName: 'Casey Lark' }, 20),
  member(THIRD, { email: 'analyst@fund.example', fullName: 'Kit Moss' }, 5),
];

describe('choosePrincipal', () => {
  it('(a) is the member whose address the mailbox is, not the owner who connected it', () => {
    expect(choosePrincipal(TEAM, [mailbox()])).toEqual({
      userId: LEAD,
      basis: 'mailbox_address',
    });
  });

  it('compares addresses without case or surrounding spaces', () => {
    const shouty = [mailbox({ account_email: '  Lead@FUND.example ' })];
    expect(choosePrincipal(TEAM, shouty)?.userId).toBe(LEAD);
    const team = TEAM.map((m) => (m.userId === LEAD ? { ...m, email: ' LEAD@fund.EXAMPLE' } : m));
    expect(choosePrincipal(team, [mailbox()])?.userId).toBe(LEAD);
  });

  it('(b) is whoever connected the mailbox when no member has its address', () => {
    const other = [mailbox({ account_email: 'shared-inbox@fund.example', user_id: THIRD })];
    expect(choosePrincipal(TEAM, other)).toEqual({ userId: THIRD, basis: 'mailbox_connector' });
    const unnamed = [mailbox({ account_email: null, user_id: LEAD })];
    expect(choosePrincipal(TEAM, unnamed)).toEqual({ userId: LEAD, basis: 'mailbox_connector' });
  });

  it('(c) is the owner when the mailbox belongs to no member, or there is none', () => {
    const stranger = [
      mailbox({
        account_email: 'someone@elsewhere.example',
        user_id: '00000000-0000-4000-8000-00000000ffff',
      }),
    ];
    expect(choosePrincipal(TEAM, stranger)).toEqual({ userId: OPS, basis: 'owner' });
    expect(choosePrincipal(TEAM, [])).toEqual({ userId: OPS, basis: 'owner' });
  });

  it('(c) takes the oldest owner when there are several', () => {
    const owners = [
      member(THIRD, { role: 'owner' }, 50),
      member(OPS, { role: 'owner' }, 60),
      member(LEAD, {}, 70),
    ];
    expect(choosePrincipal(owners, [])).toEqual({ userId: OPS, basis: 'owner' });
  });

  it('(d) is the first member when no one is the owner', () => {
    const team = [member(THIRD, { role: 'admin' }, 5), member(LEAD, { role: 'member' }, 40)];
    expect(choosePrincipal(team, [])).toEqual({ userId: LEAD, basis: 'first_member' });
  });

  it('is no one for an organization with no members', () => {
    expect(choosePrincipal([], [mailbox()])).toBeNull();
  });

  it('gives the same answer whatever order the rows come in', () => {
    const reversed = [...TEAM].reverse();
    expect(choosePrincipal(reversed, [mailbox()])).toEqual(choosePrincipal(TEAM, [mailbox()]));
    expect(choosePrincipal(reversed, [])).toEqual(choosePrincipal(TEAM, []));
  });

  it('takes the oldest membership when two members share the address', () => {
    const twins = [
      member(THIRD, { email: 'lead@fund.example' }, 5),
      member(LEAD, { email: 'lead@fund.example' }, 20),
    ];
    expect(choosePrincipal(twins, [mailbox()])?.userId).toBe(LEAD);
  });
});

describe('principalMailbox', () => {
  it('is the oldest connected Google integration that reads Gmail', () => {
    const older = mailbox({ id: 'b-older', created_at: '2026-08-01T00:00:00.000Z' });
    const newer = mailbox({
      id: 'b-newer',
      created_at: '2026-10-01T00:00:00.000Z',
      account_email: 'ops@fund.example',
    });
    expect(principalMailbox([newer, older])?.id).toBe('b-older');
    // A second mailbox connected later never moves the principal.
    expect(choosePrincipal(TEAM, [newer, older])?.userId).toBe(LEAD);
  });

  it('skips a mailbox that is not connected or does not read Gmail', () => {
    const rows = [
      mailbox({ id: 'b-broken', status: 'needs_reauth', created_at: '2026-01-01T00:00:00.000Z' }),
      mailbox({ id: 'b-off', status: 'disconnected', created_at: '2026-02-01T00:00:00.000Z' }),
      mailbox({ id: 'b-cal', kinds: ['calendar'], created_at: '2026-03-01T00:00:00.000Z' }),
      mailbox({ id: 'b-good', created_at: '2026-04-01T00:00:00.000Z' }),
    ];
    expect(principalMailbox(rows)?.id).toBe('b-good');
    expect(principalMailbox(rows.slice(0, 3))).toBeNull();
    // With no usable mailbox, the owner decides.
    expect(choosePrincipal(TEAM, rows.slice(0, 3))).toEqual({ userId: OPS, basis: 'owner' });
  });

  it('breaks a tie in connection time by id', () => {
    const at = '2026-05-01T00:00:00.000Z';
    expect(
      principalMailbox([
        mailbox({ id: 'b-2', created_at: at }),
        mailbox({ id: 'b-1', created_at: at }),
      ])?.id,
    ).toBe('b-1');
  });
});

describe('mailboxMember', () => {
  it('is null with no mailbox, or when neither its address nor its connector is a member', () => {
    expect(mailboxMember(TEAM, null)).toBeNull();
    expect(
      mailboxMember(TEAM, {
        account_email: 'someone@elsewhere.example',
        user_id: '00000000-0000-4000-8000-00000000ffff',
      }),
    ).toBeNull();
  });
});

describe('inTeamOrder', () => {
  it('puts the oldest membership first, then sorts by id', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const order = inTeamOrder([
      member(THIRD, { createdAt: same }),
      member(LEAD, { createdAt: same }),
      member(OPS, { createdAt: '2025-12-01T00:00:00.000Z' }),
    ]).map((m) => m.userId);
    expect(order).toEqual([OPS, LEAD, THIRD]);
  });
});
