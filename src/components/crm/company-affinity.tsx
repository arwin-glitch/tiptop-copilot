import Link from 'next/link';
import { statusTone } from '@/lib/crm/view';
import type { CompanyAffinity } from '@/lib/services/crm-pages';
import { CrmNoteList } from '@/components/lists/crm-note-list';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/ui/card';

/**
 * What Affinity holds on a company Kraken also tracks, for its deal or
 * portfolio profile: the lists it is on with its stage there, its people, and
 * the notes, newest first. Read-only; the company's Affinity profile is one
 * link away for everything else.
 *
 * Renders nothing at all when Affinity has nothing on the company, so a
 * profile without Affinity data looks exactly as it did.
 */
export function CompanyAffinitySection({
  data,
  timezone,
  headingLevel = 'h3',
  className,
}: {
  data: CompanyAffinity | null;
  timezone: string;
  headingLevel?: 'h2' | 'h3';
  className?: string;
}) {
  if (!data) return null;
  const { companies, people, memberships, notes } = data;
  const profile = companies[0] ?? null;
  return (
    <section aria-label="From Affinity" className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <FieldLabel as={headingLevel}>From Affinity</FieldLabel>
        {profile ? (
          <Link
            href={`/lists/records/${profile.id}`}
            className="text-mini text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Open the Affinity profile
          </Link>
        ) : null}
      </div>
      {memberships.length ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Affinity lists">
          {memberships.map((m) => (
            <li
              key={m.entry.id}
              className="text-mini inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1"
            >
              <span className="text-[var(--fg-muted)]">{m.list.name}</span>
              {m.status ? <Badge tone={statusTone(m.status)}>{m.status}</Badge> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {people.length ? (
        <p className="text-mini mt-2 text-[var(--fg-muted)]">
          People:{' '}
          {people.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ', ' : null}
              <Link
                href={`/lists/records/${p.id}`}
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {p.name}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <div className="mt-3">
        <CrmNoteList
          notes={notes}
          timezone={timezone}
          label="Affinity notes"
          empty="No Affinity notes on this company or its people."
        />
      </div>
    </section>
  );
}
