import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  STUDENT_KINDS,
  dedupeStudentItems,
  deadlineDistance,
  deadlineState,
  filterStudentItems,
  onArwin,
  parseStudentFilters,
  sortStudentItems,
  sourceEmailId,
  studentFilterParams,
  studentsFreshness,
  type StudentItem,
} from '@/lib/portfolio/students';
import { studentId } from '@/lib/portfolio/student-id';
import { collectStudents, parseStudentsMessage } from '@/lib/services/portfolio-students';
import { demoStudentEmail, demoStudents } from '@/lib/demo/students-fixtures';
import { demoJobs } from '@/lib/demo/jobs-fixtures';
import { demoSourceThread } from '@/lib/demo/source-emails-fixtures';

/** Every person, school, program, address and id below is fictional. */
const post = (value: unknown) => `STUDENTS_V1\n\`${JSON.stringify(value)}\``;
const msg = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({
  text,
  ts,
  ...extra,
});

const RUN = '2026-10-19T13:00:00.000Z';
const NOW = new Date('2026-10-21T12:00:00Z');

const ITEM = {
  kind: 'mentoring',
  person: 'Ada Example',
  school_or_org: 'Example State University',
  program: 'Example Mentor Program',
  ask: 'A mentor for her final year',
  commitment: 'Two 30-min calls, Nov-Dec',
  status: 'nick_agreed',
  nick_replied: true,
  last_reply_date: '2026-10-15',
  deadline: null,
  next_step: 'Book the first call',
  next_owner: 'arwin',
  first_seen: '2026-10-01',
  last_seen: '2026-10-15',
  sources: [
    {
      thread_id: '1a0000000000aaaa',
      message_id: '1a0000000000aaab',
      date: '2026-10-15',
      subject: 'Mentoring this fall',
    },
  ],
};

function item(overrides: Record<string, unknown> = {}): StudentItem {
  const parsed = parseStudentsMessage(post({ run_at: RUN, items: [{ ...ITEM, ...overrides }] }));
  const first = parsed?.items[0];
  if (!first) throw new Error('fixture did not parse');
  return first;
}

describe('parseStudentsMessage', () => {
  it('reads a post, with the app hashing its own id from kind, person and program', () => {
    const parsed = parseStudentsMessage(
      post({ run_at: RUN, items: [{ ...ITEM, id: 'routine-own-id' }] }),
    );
    expect(parsed?.dropped).toBe(0);
    const read = parsed!.items[0]!;
    expect(read.id).toBe(studentId('mentoring', 'Ada Example', 'Example Mentor Program'));
    expect(read.id).toMatch(/^student-[0-9a-f]{16}$/);
    expect(read).toMatchObject({
      kind: 'mentoring',
      status: 'nick_agreed',
      next_owner: 'arwin',
      deadline: null,
      last_reply_date: '2026-10-15T12:00:00.000Z',
    });
    expect(sourceEmailId(read.sources[0]!)).toBe('1a0000000000aaaa');
  });

  it('keeps an id through casing and punctuation, and tells people and programs apart', () => {
    expect(item({ person: 'ADA  EXAMPLE.', program: 'example mentor-program' }).id).toBe(item().id);
    expect(item({ person: 'Bo Example' }).id).not.toBe(item().id);
    expect(item({ kind: 'intern_request' }).id).not.toBe(item().id);
    // A program's own invitation is keyed by its school.
    const program = item({ kind: 'program', person: null, program: 'Example VC Lab' });
    expect(program.id).toBe(studentId('program', 'Example State University', 'Example VC Lab'));
  });

  it('maps the words a routine might use for a kind, a status and an owner', () => {
    expect(item({ kind: 'Internship' }).kind).toBe('intern_request');
    expect(item({ kind: 'Mentorship' }).kind).toBe('mentoring');
    expect(item({ kind: 'fellowship' }).kind).toBe('program');
    expect(item({ status: 'Awaiting Nick' }).status).toBe('awaiting_nick');
    expect(item({ status: 'declined' }).status).toBe('nick_declined');
    expect(item({ next_owner: 'ARWIN' }).next_owner).toBe('arwin');
    expect(item({ next_owner: 'someone else' }).next_owner).toBeNull();
    expect(item({ next_owner: null }).next_owner).toBeNull();
  });

  it('drops a row it cannot read and counts it, keeping the rest', () => {
    const parsed = parseStudentsMessage(
      post({
        run_at: RUN,
        items: [
          ITEM,
          { ...ITEM, kind: 'sales_lead' },
          { ...ITEM, status: 'maybe' },
          { ...ITEM, person: null, school_or_org: null },
          { ...ITEM, ask: '' },
          { ...ITEM, first_seen: 'last week' },
          'not an object',
        ],
      }),
    );
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.dropped).toBe(6);
  });

  it('leaves out a bad source, never the item, and keeps only hex ids', () => {
    const read = item({
      sources: [
        { thread_id: 'https://mail.example/x', date: '2026-10-15', subject: 'Phishy' },
        { date: '2026-10-14', subject: 'No id at all' },
        { message_id: '1a0000000000cccc', date: '2026-10-13', subject: 'Message id only' },
      ],
    });
    expect(read.sources.map((s) => s.subject)).toEqual(['Message id only']);
    expect(sourceEmailId(read.sources[0]!)).toBe('1a0000000000cccc');
  });

  it('cuts an over-long ask short, and reads a bad deadline as none', () => {
    const read = item({ ask: 'x'.repeat(400), deadline: 'soon-ish', next_step: '  ' });
    expect(read.ask).toHaveLength(300);
    expect(read.ask.endsWith('…')).toBe(true);
    expect(read.deadline).toBeNull();
    expect(read.next_step).toBeNull();
  });

  it('ignores other markers, bad JSON and a bad envelope', () => {
    expect(parseStudentsMessage(`JOBS_V1\n\`${JSON.stringify({ run_at: RUN })}\``)).toBeNull();
    expect(parseStudentsMessage('STUDENTS_V1\n`{not json`')).toBeNull();
    expect(parseStudentsMessage(post({ run_at: 'yesterday', items: [] }))).toBeNull();
    expect(parseStudentsMessage(42)).toBeNull();
  });
});

describe('collectStudents', () => {
  it('joins the parts of the newest run, merging one item seen in two parts', () => {
    const older = { ...ITEM, last_seen: '2026-10-10', status: 'awaiting_nick', nick_replied: true };
    const newer = {
      ...ITEM,
      status: 'scheduled',
      nick_replied: false,
      sources: [
        {
          thread_id: '1a0000000000dddd',
          message_id: '1a0000000000dddd',
          date: '2026-10-16',
          subject: 'Call booked',
        },
      ],
      last_seen: '2026-10-16',
    };
    const snapshot = collectStudents([
      msg(post({ run_at: RUN, part: 2, parts: 2, items: [newer] }), '1792400010.000100'),
      msg(post({ run_at: RUN, part: 1, parts: 2, items: [older] }), '1792400000.000100'),
    ]);
    expect(snapshot?.partial).toBe(false);
    expect(snapshot?.items).toHaveLength(1);
    const merged = snapshot!.items[0]!;
    expect(merged.status).toBe('scheduled');
    // A reply once seen stays seen; every source once, newest first.
    expect(merged.nick_replied).toBe(true);
    expect(merged.sources.map((s) => s.subject)).toEqual(['Call booked', 'Mentoring this fall']);
    expect(merged.first_seen).toBe('2026-10-01T12:00:00.000Z');
  });

  it('passes over a run still posting for the last complete one', () => {
    const LATER = '2026-10-22T13:00:00.000Z';
    const snapshot = collectStudents([
      msg(post({ run_at: LATER, part: 1, parts: 2, items: [] }), '1792500000.000100'),
      msg(post({ run_at: RUN, part: 1, parts: 1, items: [ITEM] }), '1792400000.000100'),
    ]);
    expect(snapshot?.runAt).toBe(RUN);
    expect(snapshot?.items).toHaveLength(1);
  });

  it('skips anyone not on the poster list, and answers null with no post', () => {
    const messages = [
      msg(post({ run_at: RUN, items: [ITEM] }), '1792400000.000100', { user: 'U1' }),
    ];
    expect(collectStudents(messages, ['U2'])).toBeNull();
    expect(collectStudents(messages, ['U1'])?.items).toHaveLength(1);
    expect(collectStudents([])).toBeNull();
  });
});

describe('filters', () => {
  const items = [
    item(),
    item({ person: 'Bo Example', kind: 'intern_request', status: 'new', next_owner: 'nick' }),
    item({ person: 'Cy Example', kind: 'intern_request', status: 'done', next_owner: null }),
    item({ kind: 'program', person: null, program: 'Example VC Lab', status: 'expired' }),
  ];

  it('open on Open, reading anything unknown as the default', () => {
    expect(parseStudentFilters({})).toEqual({ kind: null, status: 'open', owner: null, q: '' });
    expect(parseStudentFilters({ kind: 'sales', status: 'zzz', owner: 'eve' })).toEqual({
      kind: null,
      status: 'open',
      owner: null,
      q: '',
    });
    expect(studentFilterParams(parseStudentFilters({}))).toEqual({});
    expect(
      studentFilterParams(
        parseStudentFilters({ kind: 'program', status: 'all', owner: 'arwin', q: 'lab' }),
      ),
    ).toEqual({ kind: 'program', status: 'all', owner: 'arwin', q: 'lab' });
  });

  it('hide done, declined and expired by default, and filter by kind, owner and words', () => {
    const f = parseStudentFilters({});
    expect(filterStudentItems(items, f).map((i) => i.person)).toEqual([
      'Ada Example',
      'Bo Example',
    ]);
    expect(filterStudentItems(items, { ...f, status: 'all' })).toHaveLength(4);
    expect(filterStudentItems(items, { ...f, status: 'done' }).map((i) => i.person)).toEqual([
      'Cy Example',
    ]);
    expect(filterStudentItems(items, { ...f, kind: 'intern_request' })).toHaveLength(1);
    expect(filterStudentItems(items, { ...f, owner: 'arwin' }).map((i) => i.person)).toEqual([
      'Ada Example',
    ]);
    expect(filterStudentItems(items, { ...f, status: 'all', q: 'vc lab' })).toHaveLength(1);
    // A chip's count leaves its own filter out.
    expect(filterStudentItems(items, { ...f, kind: 'mentoring' }, 'kind')).toHaveLength(2);
    expect(onArwin(items).map((i) => i.person)).toEqual(['Ada Example']);
  });
});

describe('deadlines, order and freshness', () => {
  it('reads a deadline as soon within 14 days, past only while open', () => {
    expect(deadlineState(item({ deadline: '2026-10-21' }), NOW)).toBe('soon');
    expect(deadlineState(item({ deadline: '2026-11-04' }), NOW)).toBe('soon');
    expect(deadlineState(item({ deadline: '2026-11-05' }), NOW)).toBe('later');
    expect(deadlineState(item({ deadline: '2026-10-20' }), NOW)).toBe('passed');
    expect(deadlineState(item({ deadline: '2026-10-20', status: 'done' }), NOW)).toBe('later');
    expect(deadlineState(item(), NOW)).toBeNull();
    expect([0, 1, -1, 9, -3].map(deadlineDistance)).toEqual([
      'today',
      'tomorrow',
      'yesterday',
      'in 9 days',
      '3 days ago',
    ]);
  });

  it('puts open before closed, a close deadline first, then the most recently seen', () => {
    const sorted = sortStudentItems(
      [
        item({ person: 'Done Example', status: 'done', last_seen: '2026-10-20' }),
        item({ person: 'Recent Example', last_seen: '2026-10-19' }),
        item({ person: 'Deadline Example', last_seen: '2026-09-01', deadline: '2026-10-28' }),
        item({ person: 'Far Example', last_seen: '2026-10-18', deadline: '2027-03-01' }),
      ],
      NOW,
    );
    expect(sorted.map((i) => i.person)).toEqual([
      'Deadline Example',
      'Recent Example',
      'Far Example',
      'Done Example',
    ]);
  });

  it('calls a scan overdue once it is more than five days old', () => {
    const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    expect(studentsFreshness(hours(5 * 24 - 1), NOW)).toEqual({ days: 4, stale: false });
    expect(studentsFreshness(hours(5 * 24 + 1), NOW)).toEqual({ days: 5, stale: true });
  });

  it('merges an item listed twice into one', () => {
    const a = item({ last_seen: '2026-10-10', deadline: '2026-11-01' });
    const b = item({ last_seen: '2026-10-16', status: 'scheduled', deadline: null });
    const [merged, ...rest] = dedupeStudentItems([a, b]);
    expect(rest).toHaveLength(0);
    expect(merged).toMatchObject({ status: 'scheduled', deadline: '2026-11-01T12:00:00.000Z' });
  });
});

describe('the demo snapshot', () => {
  const snapshot = demoStudents(NOW);

  it('covers each kind: a mentoring item on Arwin, a program with a deadline, two intern requests', () => {
    expect(new Set(snapshot.items.map((i) => i.kind))).toEqual(new Set(STUDENT_KINDS));
    const mentoring = snapshot.items.find((i) => i.kind === 'mentoring')!;
    expect(mentoring.next_owner).toBe('arwin');
    const program = snapshot.items.find((i) => i.kind === 'program' && i.deadline)!;
    expect(deadlineState(program, NOW)).toBe('soon');
    const interns = snapshot.items.filter((i) => i.kind === 'intern_request');
    expect(interns.map((i) => i.status).sort()).toEqual(['new', 'replied']);
    expect(studentsFreshness(snapshot.runAt, NOW).stale).toBe(false);
  });

  it('has ids that match the rule, and an email behind every source', () => {
    for (const i of snapshot.items) {
      expect(i.id).toBe(studentId(i.kind, i.person ?? i.school_or_org ?? '', i.program ?? null));
      for (const s of i.sources) {
        const thread = demoStudentEmail(sourceEmailId(s), NOW);
        expect(thread, s.subject).not.toBeNull();
        // A source with a message id leads to the thread holding that message.
        if (s.message_id) expect(demoStudentEmail(s.message_id, NOW)?.id).toBe(thread?.id);
      }
    }
  });

  it('uses fictional .demo addresses only, in the emails behind it', () => {
    for (const i of snapshot.items) {
      for (const s of i.sources) {
        const thread = demoSourceThread(sourceEmailId(s), NOW)!;
        for (const m of thread.messages) {
          for (const address of `${m.from} ${m.to} ${m.cc}`.match(/[^\s<>]+@[^\s<>]+/g) ?? []) {
            expect(address).toMatch(/\.demo$/);
          }
        }
      }
    }
  });

  it('also has an email behind every Jobs source, built from the roles that cite it', () => {
    for (const role of demoJobs(NOW).roles) {
      for (const s of role.sources) {
        const thread = demoSourceThread(s.message_id, NOW);
        expect(thread?.subject, s.message_id).toBe(s.subject);
        expect(thread?.messages[0]?.text).toContain(role.title);
      }
    }
    expect(demoSourceThread('0f00000000009999', NOW)).toBeNull();
  });
});
