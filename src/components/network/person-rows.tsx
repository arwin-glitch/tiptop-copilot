import Link from 'next/link';
import { CalendarDays, FileText, Mail } from 'lucide-react';
import { ThreadLinks } from '@/components/email/thread-links';
import { formatContactDate } from '@/components/network/contact-status-tag';
import { Badge } from '@/components/ui/badge';
import { Notice, PlainText } from '@/components/ui/feedback';
import type { PersonMeeting, PersonThread } from '@/lib/services/person-profile';

/**
 * One email thread and one meeting with its notes, as the person page and
 * the task page list them.
 */

export function ThreadRow({
  thread: t,
  mailbox,
  timezone,
}: {
  thread: PersonThread;
  mailbox: string | null;
  timezone: string;
}) {
  return (
    <li className="flex items-start gap-2.5 py-3" data-person-thread="">
      <Mail className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{t.subject}</p>
        <p className="text-mini text-[var(--fg-muted)]">
          {t.direction === 'us' ? 'Latest from Nick' : 'Latest from them'} · {t.emailsIn} in /{' '}
          {t.emailsOut} out
          {t.flagged ? (
            <Badge tone="danger" className="ml-2">
              Flagged
            </Badge>
          ) : null}
        </p>
        {t.snippet ? (
          <PlainText
            text={t.snippet}
            className="text-mini mt-1 line-clamp-2 text-[var(--fg-subtle)]"
          />
        ) : null}
        <ThreadLinks
          id={t.gmailId}
          mailbox={mailbox}
          label={t.subject}
          variant="text"
          className="mt-1"
        />
      </div>
      <time
        dateTime={t.at}
        title={formatContactDate(t.at, timezone, true)}
        className="text-mini tabular shrink-0 whitespace-nowrap text-[var(--fg-subtle)]"
      >
        {formatContactDate(t.at, timezone)}
      </time>
    </li>
  );
}

export function MeetingRow({ meeting: m, timezone }: { meeting: PersonMeeting; timezone: string }) {
  const Icon = m.notes.length ? FileText : CalendarDays;
  return (
    <li className="flex items-start gap-2.5 py-3" data-person-meeting="">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{m.title}</p>
        {m.attendees.length ? (
          <p className="text-mini text-[var(--fg-muted)]">
            {m.upcoming ? <span className="text-[var(--accent)]">Upcoming · </span> : null}
            {m.attendees.map((a) => a.name ?? a.email).join(', ')}
          </p>
        ) : m.upcoming ? (
          <p className="text-mini text-[var(--accent)]">Upcoming</p>
        ) : null}
        {m.krakenHref ? (
          <Link
            href={m.krakenHref}
            className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Open the meeting: notes, transcript and chat
          </Link>
        ) : null}
        {m.notes.map((n) => (
          <div key={n.id} className="mt-2 rounded-md border border-[var(--border)] px-3 py-2">
            <p className="text-mini font-medium text-[var(--fg-muted)]">
              Notes from {n.source === 'kraken' ? 'Kraken' : 'Granola'}
            </p>
            {n.flagged ? (
              <Notice tone="warn" className="mt-1">
                This note contains text aimed at an AI assistant. It was treated as data, not
                instructions.
              </Notice>
            ) : null}
            <PlainText text={n.summary} className="text-mini mt-1 text-[var(--fg-muted)]" />
            <details className="mt-1">
              <summary className="text-mini cursor-pointer text-[var(--fg-muted)]">
                Read the whole note
              </summary>
              <PlainText text={n.content} className="mt-2 text-sm text-[var(--fg-muted)]" />
            </details>
            <Link
              href={n.href}
              className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
            >
              {n.source === 'kraken' ? 'Open the full note and transcript' : 'Open in Meetings'}
            </Link>
          </div>
        ))}
      </div>
      <time
        dateTime={m.at}
        title={formatContactDate(m.at, timezone, true)}
        className="text-mini tabular shrink-0 whitespace-nowrap text-[var(--fg-subtle)]"
      >
        {formatContactDate(m.at, timezone)}
      </time>
    </li>
  );
}
