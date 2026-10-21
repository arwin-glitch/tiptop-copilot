import 'server-only';
import { demoJobs } from '@/lib/demo/jobs-fixtures';
import { jobId } from '@/lib/portfolio/job-id';
import {
  JOBS_MARKER,
  JOBS_POST_SCHEMA,
  JOB_ROLE_SCHEMA,
  dedupeJobRoles,
  sortJobRoles,
  type JobRole,
  type JobsPost,
  type JobsSnapshot,
} from '@/lib/portfolio/jobs';
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
 * The Portfolio page's Jobs tab: open roles at portfolio companies, read
 * live from the jobs routine's `JOBS_V1` snapshot in the private #deal-relay
 * channel, like the other routine snapshots. Nothing is stored; the newest
 * complete run wins.
 *
 * The routine runs weekly and posts the whole deduplicated list each time,
 * split into numbered parts when it is too long for one Slack message. The
 * envelope, the parts and the cached read are shared with the other relay
 * snapshots (`relay-snapshot.ts`); this file is what is Jobs' own: the role
 * rows, and a role's id as the app's own hash of its company and normalized
 * title, whatever id the routine sent.
 */

export type PortfolioJobsState = RelaySnapshotState;
export type PortfolioJobsResult = RelaySnapshotResult<JobsSnapshot>;

export interface ParsedJobsPost {
  post: JobsPost;
  roles: JobRole[];
  /** Rows that did not validate. */
  dropped: number;
}

const JOBS_SPEC: RelaySnapshotSpec<JobRole, JobsPost> = {
  marker: JOBS_MARKER,
  name: 'Jobs',
  post: JOBS_POST_SCHEMA,
  rows: (post) => post.roles,
  item: (row) => {
    const role = JOB_ROLE_SCHEMA.safeParse(row);
    if (!role.success) return null;
    const { id: _ignored, ...fields } = role.data;
    return { ...fields, id: jobId(fields.company, fields.title) };
  },
  finish: (roles) => sortJobRoles(dedupeJobRoles(roles)),
};

/**
 * One relay message -> a parsed `JOBS_V1` post, or null when it is not one or
 * its envelope does not validate. Slack's link markup is undone first, so a
 * job link or a contact email arrives as the text the routine wrote.
 */
export function parseJobsMessage(raw: unknown): ParsedJobsPost | null {
  const parsed = parseRelayPost(raw, JOBS_SPEC);
  return parsed ? { post: parsed.post, roles: parsed.items, dropped: parsed.dropped } : null;
}

/**
 * Slack pages (newest first) -> the snapshot to show: the newest run whose
 * parts are all there, else the newest run as it stands (marked partial).
 * Null when no `JOBS_V1` post is in the window. Pure, for tests.
 */
export function collectJobs(
  messages: readonly SlackMessage[],
  posterIds: readonly string[] = [],
): JobsSnapshot | null {
  const snapshot = collectRelaySnapshot(messages, posterIds, JOBS_SPEC);
  if (!snapshot) return null;
  const { items, ...rest } = snapshot;
  return { ...rest, roles: items };
}

const reader = relaySnapshotReader<JobsSnapshot>({
  key: 'portfolio-jobs',
  name: 'jobs',
  collect: collectJobs,
  demo: demoJobs,
});

/**
 * The current jobs snapshot for this organization: cached five minutes, the
 * last good read standing in while Slack is down, never throws. Closed until
 * sign-in is limited to TipTop accounts: the posts quote founders' emails and
 * name who to send candidates to.
 */
export const readPortfolioJobs = reader.read;

/** readPortfolioJobs for a page that only shows a count or a short list (a company page). */
export const readPortfolioJobsWithin = reader.readWithin;

/** The snapshot only if it is already in memory (or the demo's): for the tab's count. */
export const peekPortfolioJobs = reader.peek;

/** Test hook. */
export const resetPortfolioJobsCache = reader.reset;
