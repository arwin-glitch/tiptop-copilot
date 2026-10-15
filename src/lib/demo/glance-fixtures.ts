import type { AuditEvent, Task } from '@/lib/types/domain';
import type { DuePrecision, GlanceBucket } from '@/lib/tasks/glance';
import { DEMO_IDS, demoGlanceId } from './ids';

/**
 * Suggested tasks for Today's "At a glance" cards, each with the short label
 * and card the routine would have posted beside it (a `task.glance_set` row
 * with no user). Every company, person and task here is invented.
 *
 * Dates are relative to `now`. None is overdue: the demo's two overdue tasks
 * are the fixture's own, and the demo walk-through counts them.
 */

interface GlanceFixture {
  title: string;
  short: string;
  bucket: GlanceBucket;
  /** Hours from now; null for undated. */
  dueInHours: number | null;
  precision?: DuePrecision;
  createdDaysAgo: number;
  detail: string;
}

const FIXTURES: readonly GlanceFixture[] = [
  // Do now
  {
    title: 'Reply to Halyard on the follow-on question this week',
    short: 'Halyard: reply this week',
    bucket: 'now',
    dueInHours: 48,
    createdDaysAgo: 2,
    detail: 'Suggested from the inbox: the founders asked whether TipTop would follow on.',
  },
  {
    title: 'Quillfield: approve the hiring plan today',
    short: 'Quillfield: hiring plan',
    bucket: 'now',
    dueInHours: 3,
    createdDaysAgo: 1,
    detail: 'Suggested from the inbox: the founders want a yes before their team offsite.',
  },
  {
    title: 'Marlow Foods: send the SOW and book the kickoff',
    short: 'Marlow Foods: SOW + kickoff',
    bucket: 'now',
    dueInHours: null,
    createdDaysAgo: 1,
    detail: 'Suggested from a meeting note: promised on the last call.',
  },
  {
    title: 'Tallyworks: answer the angel on the terms',
    short: 'Tallyworks: angel terms',
    bucket: 'now',
    dueInHours: null,
    createdDaysAgo: 2,
    detail: 'Suggested from the inbox: an angel asked which terms the round settled on.',
  },
  // Intros owed
  {
    title: 'Intro Priya Raman to Omar Haddad',
    short: 'Priya → Omar',
    bucket: 'intro',
    dueInHours: null,
    createdDaysAgo: 9,
    detail: 'Suggested from a meeting note: promised to connect them about hiring.',
  },
  {
    title: 'Introduce Elena Marsh to Ben Adeyemi',
    short: 'Elena → Ben',
    bucket: 'intro',
    dueInHours: null,
    createdDaysAgo: 7,
    detail: 'Suggested from the inbox: Elena asked for the intro.',
  },
  {
    title: 'Intro Chris Dalton to Ivy Lin and Sam Park',
    short: 'Chris → Ivy + Sam P.',
    bucket: 'intro',
    dueInHours: null,
    createdDaysAgo: 6,
    detail: 'Suggested from a meeting note: both opted in.',
  },
  {
    title: 'Send Grace and Tom the notes from their intro call',
    short: 'Grace + Tom notes',
    bucket: 'intro',
    dueInHours: null,
    createdDaysAgo: 3,
    detail: 'Suggested from a meeting note: owed after the intro.',
  },
  // Coming up
  {
    title: 'Northwind: write the quarterly LP note',
    short: 'Northwind note',
    bucket: 'upcoming',
    dueInHours: 4 * 24,
    precision: 'week',
    createdDaysAgo: 4,
    detail: 'Suggested from the calendar: due the week of the LP update.',
  },
  {
    title: 'Lumen product walkthrough with the team',
    short: 'Lumen walkthrough',
    bucket: 'upcoming',
    dueInHours: 5 * 24,
    createdDaysAgo: 3,
    detail: 'Suggested from the calendar: prepare questions beforehand.',
  },
  {
    title: 'Cobalt Ridge: prepare questions for the board meeting',
    short: 'Cobalt Ridge: board prep',
    bucket: 'upcoming',
    dueInHours: 11 * 24,
    createdDaysAgo: 5,
    detail: 'Suggested from the calendar: the board pack arrives two days before.',
  },
  {
    title: 'Finish the founder field guide draft',
    short: 'Field guide',
    bucket: 'upcoming',
    dueInHours: 16 * 24,
    createdDaysAgo: 6,
    detail: 'Suggested from a meeting note: promised to the portfolio founders.',
  },
];

export function demoGlance(now: Date): { tasks: Task[]; audit_events: AuditEvent[] } {
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const tasks: Task[] = [];
  const audit_events: AuditEvent[] = [];
  FIXTURES.forEach((fixture, n) => {
    const created = at(-fixture.createdDaysAgo * 86_400_000);
    const taskId = demoGlanceId('task', n);
    tasks.push({
      id: taskId,
      organization_id: DEMO_IDS.org,
      title: fixture.title,
      detail: fixture.detail,
      status: 'open',
      due_at: fixture.dueInHours === null ? null : at(fixture.dueInHours * 3_600_000),
      snoozed_until: null,
      deal_id: null,
      portfolio_company_id: null,
      email_message_id: null,
      assigned_to: DEMO_IDS.user,
      created_by: DEMO_IDS.user,
      source: 'suggested',
      completed_at: null,
      created_at: created,
      updated_at: created,
    });
    audit_events.push({
      id: demoGlanceId('audit', n),
      organization_id: DEMO_IDS.org,
      user_id: null,
      action: 'task.glance_set',
      entity_type: 'task',
      entity_id: taskId,
      metadata: {
        v: 1,
        by: 'routine',
        source: 'slack-relay:task-auto-suggest',
        short: fixture.short,
        bucket: fixture.bucket,
        ...(fixture.precision ? { due_precision: fixture.precision } : {}),
      },
      ip_hash: null,
      created_at: created,
    });
  });
  return { tasks, audit_events };
}
