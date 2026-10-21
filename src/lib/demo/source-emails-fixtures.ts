import type { FullMessage, FullThread } from '@/lib/google/gmail-inbox';
import { jobPlace } from '@/lib/portfolio/jobs';
import { DEMO_USER } from './fixtures';
import { demoJobs } from './jobs-fixtures';
import { demoStudentEmail } from './students-fixtures';

/**
 * Demo mode only: the emails behind the routine snapshots' sources (Jobs and
 * Students), so every "Copilot" link on those tabs opens a thread in the
 * Inbox rather than "couldn't open that email". Students has its own short
 * threads (`students-fixtures.ts`); a Jobs source is a founder's note built
 * from the roles that cite it. Every name, company and address is fictional
 * and on a `.demo` domain.
 */

const NICK = `${DEMO_USER.name} <${DEMO_USER.email}>`;

/** A founder's hiring note for one Jobs source: the roles it lists, and who to send people to. */
function jobsEmail(id: string, now: Date): FullThread | null {
  const key = id.toLowerCase();
  const roles = demoJobs(now).roles.filter((r) => r.sources.some((s) => s.message_id === key));
  const first = roles[0];
  const source = first?.sources.find((s) => s.message_id === key);
  if (!first || !source) return null;
  const sender = first.contact_name
    ? `${first.contact_name} <${first.contact_email ?? `team@${first.company_domain ?? 'example.demo'}`}>`
    : `${first.company} <team@${first.company_domain ?? 'example.demo'}>`;
  const lines = roles.map((r) => {
    const place = jobPlace(r);
    return `- ${r.title}${place ? ` (${place})` : ''}${r.status_note ? `: ${r.status_note}` : ''}`;
  });
  const message: FullMessage = {
    id: key,
    from: sender,
    to: NICK,
    cc: '',
    date: source.date,
    subject: source.subject,
    text: [
      'Hi Nick,',
      '',
      `A quick note from ${first.company}. Hiring:`,
      ...lines,
      '',
      first.contact_email
        ? `If you know anyone strong, send them to ${first.contact_email}.`
        : 'If you know anyone strong, just reply here.',
      '',
      'Thanks,',
      first.contact_name ?? `The ${first.company} team`,
    ].join('\n'),
    attachments: [],
    labelIds: [],
  };
  return { id: key, subject: source.subject, labelIds: [], messages: [message] };
}

/** The demo email behind a Jobs or Students source, by id; null for any other id. */
export function demoSourceThread(id: string, now: Date): FullThread | null {
  return demoStudentEmail(id, now) ?? jobsEmail(id, now);
}
