import 'server-only';
import { demoStudents } from '@/lib/demo/students-fixtures';
import { studentId } from '@/lib/portfolio/student-id';
import {
  STUDENTS_MARKER,
  STUDENTS_POST_SCHEMA,
  STUDENT_ITEM_SCHEMA,
  dedupeStudentItems,
  isOpenStudentItem,
  studentWho,
  type StudentItem,
  type StudentsPost,
  type StudentsSnapshot,
} from '@/lib/portfolio/students';
import type { SlackMessage } from '@/lib/slack/relay-history';
import {
  collectRelaySnapshot,
  parseRelayPost,
  relaySnapshotReader,
  type RelaySnapshotResult,
  type RelaySnapshotSpec,
  type RelaySnapshotState,
} from './relay-snapshot';

/**
 * The Network page's "Students & interns" tab: mentoring, programs and
 * intern requests, read live from the students routine's `STUDENTS_V1`
 * snapshot in the private #deal-relay channel, exactly as Jobs reads
 * `JOBS_V1` (`relay-snapshot.ts`: the envelope, the parts, the newest
 * complete run, the cached read with its last good copy). Nothing is stored.
 *
 * The routine runs Mondays and Thursdays and posts the whole deduplicated
 * list each time. An item's id is the app's own hash of its kind, who it is
 * about and the program, whatever id the routine sent. A source is a Gmail
 * id, a date and a subject; no email text is ever in the post.
 */

export type PortfolioStudentsState = RelaySnapshotState;
export type PortfolioStudentsResult = RelaySnapshotResult<StudentsSnapshot>;

export interface ParsedStudentsPost {
  post: StudentsPost;
  items: StudentItem[];
  /** Rows that did not validate. */
  dropped: number;
}

const STUDENTS_SPEC: RelaySnapshotSpec<StudentItem, StudentsPost> = {
  marker: STUDENTS_MARKER,
  name: 'Students',
  post: STUDENTS_POST_SCHEMA,
  rows: (post) => post.items,
  item: (row) => {
    const parsed = STUDENT_ITEM_SCHEMA.safeParse(row);
    if (!parsed.success) return null;
    const { id: _ignored, ...fields } = parsed.data;
    return { ...fields, id: studentId(fields.kind, studentWho(fields), fields.program ?? null) };
  },
  // Open first, then the most recently seen; the tab sorts by deadline with the clock.
  finish: (items) =>
    dedupeStudentItems(items).sort(
      (a, b) =>
        Number(!isOpenStudentItem(a)) - Number(!isOpenStudentItem(b)) ||
        b.last_seen.localeCompare(a.last_seen),
    ),
};

/** One relay message -> a parsed `STUDENTS_V1` post, or null when it is not one. */
export function parseStudentsMessage(raw: unknown): ParsedStudentsPost | null {
  const parsed = parseRelayPost(raw, STUDENTS_SPEC);
  return parsed ? { post: parsed.post, items: parsed.items, dropped: parsed.dropped } : null;
}

/**
 * Slack pages (newest first) -> the snapshot to show: the newest run whose
 * parts are all there, else the newest run as it stands (marked partial).
 * Null when no `STUDENTS_V1` post is in the window. Pure, for tests.
 */
export function collectStudents(
  messages: readonly SlackMessage[],
  posterIds: readonly string[] = [],
): StudentsSnapshot | null {
  return collectRelaySnapshot(messages, posterIds, STUDENTS_SPEC);
}

const reader = relaySnapshotReader<StudentsSnapshot>({
  key: 'portfolio-students',
  name: 'students',
  collect: collectStudents,
  demo: demoStudents,
});

/**
 * The current students snapshot for this organization: cached five minutes,
 * the last good read standing in while Slack is down, never throws. Closed
 * until sign-in is limited to TipTop accounts: the posts name students and
 * what they asked for.
 */
export const readPortfolioStudents = reader.read;

/** The snapshot only if it is already in memory (or the demo's): for the tab's count. */
export const peekPortfolioStudents = reader.peek;

/** Test hook. */
export const resetPortfolioStudentsCache = reader.reset;
