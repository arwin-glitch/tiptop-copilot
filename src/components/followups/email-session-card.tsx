import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { sessionSummary, type EmailSession } from '@/lib/services/email-session';

/**
 * Top of Follow-ups: the way into the email session. The rest of the page
 * stays as it is, so a quick skim still works without opening anything.
 */
export function EmailSessionCard({ session }: { session: EmailSession }) {
  if (session.state !== 'ok') return null;
  const { forNick, forArwin, minutes, answered } = sessionSummary(session);
  const done = forNick === 0;
  return (
    <section
      aria-labelledby="email-session-heading"
      className="flex flex-wrap items-center gap-4 rounded-[var(--radius-card)] border border-[var(--border-strong)] bg-[var(--bg-raised)] p-4"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)]">
        <Inbox className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="email-session-heading" className="text-base font-semibold">
          Email session
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">
          {done
            ? `All done for now. ${answered} answered.`
            : `${forNick} need you · starts with the most urgent 10 min (about ${minutes} min for all)${forArwin ? ` · ${forArwin} with nothing to answer` : ''}`}
          {!done && answered > 0 ? ` · ${answered} done` : ''}
        </p>
      </div>
      <Link
        href="/follow-ups/session"
        className="inline-flex h-9 items-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-fg)] hover:opacity-90"
      >
        {done ? 'Review' : answered > 0 ? 'Continue' : 'Start'}
      </Link>
    </section>
  );
}
