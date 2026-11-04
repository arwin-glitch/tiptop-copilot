import type { RelationshipIndex } from './evidence';
import { recencyFactor } from './strength';

/**
 * Who on the team knows a person or company, and the last time anyone was in
 * touch — Affinity's "Connections" and "Last contact", from the same
 * relationship index the strength score reads (so no Gmail call, and the two
 * always agree).
 *
 * The index counts every fund address as "us". This splits "us" back into
 * people: a message from one of our addresses credits its sender; a message
 * to us credits each of our addresses on To or Cc. Addresses that belong to
 * the same person (Nick's aliases) are merged by the name the caller gives
 * them. Meetings carry no "which of us" in the index, so they count towards
 * the last contact but not towards anyone's connection.
 *
 * Pure: the caller passes the index, the addresses, and the team's names.
 */

export interface TeamConnection {
  /** The display name the team address was given (or the address itself). */
  name: string;
  /** Our addresses that were on the mail, merged under this name. */
  addresses: string[];
  /** Threads this teammate is on with them. */
  threads: number;
  emails: number;
  lastAt: string | null;
  /** 0–100: frequency (threads) discounted by recency, as the strength score does. */
  score: number;
}

export interface LastTouch {
  at: string;
  kind: 'email' | 'meeting';
  /** For an email: whether our side sent it. */
  fromUs: boolean;
  /** For an email: who sent it (an address). */
  from: string | null;
  /** For an email: the first counted recipient on the other side (or ours, for an email to us). */
  to: string | null;
  /** The thread's subject or the meeting's title. */
  title: string | null;
}

export interface ConnectionsDetail {
  connections: TeamConnection[];
  lastTouch: LastTouch | null;
  firstMeetingAt: string | null;
}

/** Points per thread a teammate is on, before recency; five threads is the ceiling. */
export const CONNECTION_POINTS_PER_THREAD = 20;

const iso = (t: number) => new Date(t).toISOString();

export function teamConnections(
  index: RelationshipIndex,
  addresses: Iterable<string>,
  options: { now?: Date; teamNames?: ReadonlyMap<string, string> } = {},
): ConnectionsDetail {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const names = options.teamNames ?? new Map<string, string>();
  const who = new Set([...addresses].map((a) => a.trim().toLowerCase()));

  const threadKeys = new Set<string>();
  const meetingIds = new Set<number>();
  for (const address of who) {
    const entry = index.byAddress.get(address);
    if (!entry) continue;
    for (const k of entry.threads) threadKeys.add(k);
    for (const m of entry.meetings) meetingIds.add(m);
  }

  type Tally = { addresses: Set<string>; threads: Set<string>; emails: number; lastAt: number };
  const tallies = new Map<string, Tally>();
  const credit = (own: string, thread: string, at: number) => {
    const name = names.get(own) ?? own;
    const tally = tallies.get(name) ?? {
      addresses: new Set<string>(),
      threads: new Set<string>(),
      emails: 0,
      lastAt: 0,
    };
    tally.addresses.add(own);
    tally.threads.add(thread);
    tally.emails += 1;
    tally.lastAt = Math.max(tally.lastAt, at);
    tallies.set(name, tally);
  };

  let last: LastTouch | null = null;
  let lastMs = -Infinity;
  for (const key of threadKeys) {
    const thread = index.threads.get(key);
    if (!thread) continue;
    for (const m of thread.messages) {
      if (m.mass || m.at > nowMs) continue;
      if (m.fromUs) {
        const to = m.recipients.find((r) => who.has(r));
        if (!to) continue;
        if (m.from) credit(m.from, key, m.at);
        if (m.at > lastMs) {
          lastMs = m.at;
          last = {
            at: iso(m.at),
            kind: 'email',
            fromUs: true,
            from: m.from,
            to,
            title: thread.subject,
          };
        }
      } else {
        if (m.from === null || !who.has(m.from)) continue;
        const ours = m.recipients.filter((r) => index.own.has(r));
        for (const own of ours) credit(own, key, m.at);
        if (m.at > lastMs) {
          lastMs = m.at;
          last = {
            at: iso(m.at),
            kind: 'email',
            fromUs: false,
            from: m.from,
            to: ours[0] ?? null,
            title: thread.subject,
          };
        }
      }
    }
  }

  let firstMeeting: number | null = null;
  for (const i of meetingIds) {
    const meeting = index.meetings[i];
    if (!meeting || meeting.at > nowMs) continue;
    if (firstMeeting === null || meeting.at < firstMeeting) firstMeeting = meeting.at;
    if (meeting.at > lastMs) {
      lastMs = meeting.at;
      last = {
        at: iso(meeting.at),
        kind: 'meeting',
        fromUs: false,
        from: null,
        to: null,
        title: meeting.title,
      };
    }
  }

  const connections: TeamConnection[] = [...tallies.entries()]
    .map(([name, t]) => {
      const days = Math.max(0, Math.floor((nowMs - t.lastAt) / 86_400_000));
      const base = Math.min(100, t.threads.size * CONNECTION_POINTS_PER_THREAD);
      return {
        name,
        addresses: [...t.addresses].sort(),
        threads: t.threads.size,
        emails: t.emails,
        lastAt: iso(t.lastAt),
        score: Math.max(1, Math.round(base * recencyFactor(days))),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.lastAt ?? '').localeCompare(a.lastAt ?? '') ||
        a.name.localeCompare(b.name),
    );

  return {
    connections,
    lastTouch: last,
    firstMeetingAt: firstMeeting === null ? null : iso(firstMeeting),
  };
}

/**
 * The last contact in words: "Nick Tippmann sent an email to ada@x.example",
 * "ada@x.example emailed Nick Tippmann", "Meeting: Intro call".
 */
export function lastTouchSentence(
  touch: LastTouch,
  teamNames: ReadonlyMap<string, string> = new Map(),
  theirName: (address: string) => string | null = () => null,
): string {
  if (touch.kind === 'meeting') return `Meeting: ${touch.title?.trim() || 'untitled'}`;
  const ours = (a: string | null) => (a ? (teamNames.get(a) ?? a) : 'the team');
  const theirs = (a: string | null) => (a ? (theirName(a) ?? a) : 'them');
  return touch.fromUs
    ? `${ours(touch.from)} sent an email to ${theirs(touch.to)}`
    : `${theirs(touch.from)} emailed ${ours(touch.to)}`;
}
