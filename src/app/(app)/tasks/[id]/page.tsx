import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Briefcase, Building2, ExternalLink, FileText, Mail } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { buildTaskContext, type TaskContext } from '@/lib/services/task-context';
import { ThreadLinks } from '@/components/email/thread-links';
import { formatContactDate } from '@/components/network/contact-status-tag';
import { MeetingRow, ThreadRow } from '@/components/network/person-rows';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { ErrorState, PlainText } from '@/components/ui/feedback';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  return { title: UUID.test(id) ? 'Task' : 'Task not found' };
}

const FOUND_LABEL: Partial<Record<string, string>> = {
  deal: 'Deal',
  portfolio: 'Portfolio',
  lp: 'LP',
  person: 'Person',
  meeting: 'Meeting',
  task: 'Task',
  document: 'Document',
  crm_company: 'Company',
  crm_person: 'Person',
  crm_note: 'Note',
  space: 'Space',
};

const linkClass = 'text-sm text-[var(--accent)] underline-offset-2 hover:underline';
const listClass =
  'divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4';

/**
 * One task with everything behind it: the email it came from, links in it,
 * the deal or company, and for each person or company it names, the threads
 * and the meetings (with notes) where it was likely asked or promised.
 */
export default async function TaskPage({ params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const auth = await requireAuth();
  const timezone = auth.profile.timezone || 'UTC';
  const built = await buildTaskContext(getStore(), auth, id);
  if (!built.ok) {
    if (built.error.code === 'not_found') notFound();
    return (
      <PageShell>
        <BackLink />
        <ErrorState
          title="This task could not be loaded"
          message={built.error.message}
          stillUsable="The Tasks list, and everything else in Kraken."
        />
      </PageShell>
    );
  }
  const c = built.value;
  const t = c.task;
  const due = t.due_at ? formatContactDate(t.due_at, timezone) : null;
  const overdue = c.overdue;
  const nothing =
    !c.thread &&
    c.links.length === 0 &&
    !c.deal &&
    !c.company &&
    c.people.length === 0 &&
    c.found.length === 0;

  return (
    <PageShell>
      <BackLink />
      <PageHeader
        title={t.title}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            {t.source === 'suggested' ? <Badge tone="outline">Suggested</Badge> : null}
            {t.status !== 'open' ? <Badge tone="outline">{t.status}</Badge> : null}
            {due ? (
              <span className={overdue ? 'text-sm text-[var(--danger)]' : 'text-sm'}>
                {overdue ? 'Overdue, was due ' : 'Due '}
                {due}
              </span>
            ) : null}
          </span>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-8">
          {t.detail ? (
            <section aria-labelledby="task-what">
              <SectionHeading>
                <span id="task-what">What it is</span>
              </SectionHeading>
              <PlainText text={t.detail} className="text-sm text-[var(--fg-muted)]" />
            </section>
          ) : null}

          {c.people.map((p) => (
            <section key={p.email} aria-label={`With ${p.name ?? p.email}`}>
              <SectionHeading>
                <Link href={p.href} className="underline-offset-2 hover:underline">
                  {p.name ?? p.email}
                </Link>
                {p.name ? (
                  <span className="ml-2 text-xs font-normal text-[var(--fg-subtle)]">
                    {p.email}
                  </span>
                ) : null}
              </SectionHeading>
              {p.threads.length === 0 && p.meetings.length === 0 ? (
                <p className="text-sm text-[var(--fg-subtle)]">Nothing synced with them yet.</p>
              ) : (
                <ul className={listClass}>
                  {p.threads.map((th) => (
                    <ThreadRow key={th.key} thread={th} mailbox={c.mailbox} timezone={timezone} />
                  ))}
                  {p.meetings.map((m) => (
                    <MeetingRow key={m.key} meeting={m} timezone={timezone} />
                  ))}
                </ul>
              )}
            </section>
          ))}

          {c.found.length ? (
            <section aria-labelledby="task-found">
              <SectionHeading count={c.found.length}>
                <span id="task-found">Elsewhere in Kraken</span>
              </SectionHeading>
              <ul className={listClass}>
                {c.found.map((f) => (
                  <li key={f.href} className="flex items-start gap-2.5 py-3">
                    <div className="min-w-0 flex-1">
                      <Link href={f.href} className={linkClass}>
                        {f.label}
                      </Link>
                      {f.sub ? (
                        <p className="text-mini truncate text-[var(--fg-subtle)]">{f.sub}</p>
                      ) : null}
                    </div>
                    <span className="text-mini shrink-0 text-[var(--fg-subtle)]">
                      {FOUND_LABEL[f.kind] ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {nothing ? (
            <p className="text-sm text-[var(--fg-subtle)]">
              Nothing in synced mail, meetings or records points at this task yet. Older mail may
              still be in Gmail: use Search Gmail under Links.
            </p>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-8">
          <Sources context={c} />
        </aside>
      </div>
    </PageShell>
  );
}

function Sources({ context: c }: { context: TaskContext }) {
  const items: React.ReactNode[] = [];
  if (c.thread) {
    items.push(
      <li key="thread" className="space-y-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Mail className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
          {c.thread.subject ?? 'The email it came from'}
        </p>
        <ThreadLinks id={c.thread.gmailId} mailbox={c.mailbox} variant="text" />
      </li>,
    );
  }
  for (const l of c.links) {
    items.push(
      <li key={l.url}>
        <a href={l.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {l.kind === 'docsend' || l.kind === 'doc' ? (
            <FileText className="mr-1 inline size-3.5" aria-hidden="true" />
          ) : (
            <ExternalLink className="mr-1 inline size-3.5" aria-hidden="true" />
          )}
          {l.label}
        </a>
      </li>,
    );
  }
  if (c.deal) {
    items.push(
      <li key="deal">
        <Link href={`/deals/${c.deal.id}`} className={linkClass}>
          <Briefcase className="mr-1 inline size-3.5" aria-hidden="true" />
          Deal: {c.deal.name}
        </Link>
      </li>,
    );
  }
  if (c.company) {
    items.push(
      <li key="company">
        <Link href={`/portfolio/${c.company.id}`} className={linkClass}>
          <Building2 className="mr-1 inline size-3.5" aria-hidden="true" />
          Portfolio: {c.company.name}
        </Link>
      </li>,
    );
  }
  if (c.gmailSearch) {
    items.push(
      <li key="gmail-search">
        <a
          href={c.gmailSearch.url}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
          title={c.gmailSearch.query}
        >
          <Mail className="mr-1 inline size-3.5" aria-hidden="true" />
          Search Gmail for {c.gmailSearch.query}
        </a>
      </li>,
    );
  }
  for (const p of c.people) {
    items.push(
      <li key={p.email}>
        <Link href={p.href} className={linkClass}>
          Everything with {p.name ?? p.email}
        </Link>
      </li>,
    );
  }
  return (
    <section aria-labelledby="task-sources">
      <SectionHeading count={items.length}>
        <span id="task-sources">Links</span>
      </SectionHeading>
      {items.length ? (
        <ul className="space-y-2.5">{items}</ul>
      ) : (
        <p className="text-sm text-[var(--fg-subtle)]">No links found for this task.</p>
      )}
    </section>
  );
}

function BackLink() {
  return (
    <Link
      href="/tasks"
      className="text-mini mb-3 inline-flex items-center gap-1 text-[var(--fg-muted)] underline-offset-2 hover:underline"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Tasks
    </Link>
  );
}
