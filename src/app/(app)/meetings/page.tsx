import type { Metadata } from 'next';
import { Suspense } from 'react';
import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listMeetingNotes } from '@/lib/services/meetings';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { EmptyState, SkeletonText } from '@/components/ui/feedback';
import { Stat, StatGroup } from '@/components/ui/stat';
import { MeetingNoteList } from '@/components/meetings/meeting-note-list';
import { MeetingsFilterBar } from '@/components/meetings/meetings-client';

export const metadata: Metadata = { title: 'Meetings' };
export const dynamic = 'force-dynamic';

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';

  return (
    <PageShell>
      <PageHeader
        title="Meetings"
        subtitle="Every note Granola has written, whether or not the company is already a deal. The record of what was actually said."
      />
      <Suspense fallback={<SkeletonText lines={10} />}>
        <MeetingsContent q={q} />
      </Suspense>
    </PageShell>
  );
}

async function MeetingsContent({ q }: { q: string }) {
  const auth = await requireAuth();
  const notes = await listMeetingNotes(getStore(), auth.organizationId, { search: q || undefined });
  // `notes` is one page, capped by listMeetingNotes. Reading its length as the
  // meeting count showed a flat "500" — the cap, presented as a fact — while
  // the real figure was 922. A stat that reports a limit is worse than no stat.
  const total = await getStore().count('meeting_notes', auth.organizationId, {
    eq: { provider: 'granola' },
  });

  const people = new Set<string>();
  const companies = new Set<string>();
  for (const note of notes) {
    for (const attendee of note.attendees) {
      const email = attendee.email.toLowerCase();
      people.add(email);
      const at = email.lastIndexOf('@');
      if (at > 0) companies.add(email.slice(at + 1));
    }
  }

  return (
    <>
      <StatGroup className="mb-5" columns={3}>
        <Stat
          size="sm"
          label="Meetings"
          value={q ? notes.length : total}
          hint={q ? `matching, of ${total}` : 'notes from Granola'}
        />
        <Stat size="sm" label="People" value={people.size} hint="across every meeting" />
        <Stat size="sm" label="Organisations" value={companies.size} hint="by email domain" />
      </StatGroup>

      <MeetingsFilterBar q={q} />

      <div className="mt-4">
        {notes.length === 0 ? (
          <EmptyState
            title={q ? 'No meeting matches' : 'No meeting notes yet'}
            description={
              q
                ? 'Clear the search, or try part of a title, a name or an address.'
                : 'Notes arrive automatically once Granola is connected. Diagnostics shows whether it is, and the backlog can be imported in one pass.'
            }
            action={{
              label: q ? 'Clear search' : 'Check Diagnostics',
              href: q ? '/meetings' : '/diagnostics',
            }}
          />
        ) : (
          <MeetingNoteList notes={notes} timezone={auth.profile.timezone} />
        )}
      </div>
    </>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
