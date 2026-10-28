import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { formatOffset } from '@/lib/notes/api';
import { getStore } from '@/lib/runtime';
import { clientAddress } from '@/lib/security/client-address';
import { resolveSharedNote } from '@/lib/services/notes-share';
import type { SharedNoteView } from '@/lib/types/notes';
import { DEFAULT_TIMEZONE, formatDate } from '@/lib/util/time';
import { Wordmark } from '@/components/brand/wordmark';
import { cn } from '@/lib/util/cn';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shared meeting notes',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

/**
 * A meeting's notes opened from a share link (D-076). Public: no sign-in, no
 * app chrome, server-rendered, never indexed, never cached, no referrer (the
 * proxy sets the headers for /n). The summary and action items, and the
 * transcript only when the link was made with it. No email address, no voice
 * data, no internal id. A revoked, expired or unknown link is a plain 404.
 */
export default async function SharedNotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await resolveSharedNote(getStore(), token, {
    ip: clientAddress(await headers()),
  });
  if (!shared.ok) notFound();
  const note = shared.value;
  return (
    <main id="main" className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6" data-shared-note="">
      <div className="mb-8">
        <Wordmark />
      </div>
      <p className="text-micro font-medium tracking-[0.16em] text-[var(--label-gold)] uppercase">
        Meeting notes
      </p>
      <h1 className="mt-1 font-serif text-2xl leading-tight font-semibold">{note.title}</h1>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">
        {formatDate(note.occurredAt, DEFAULT_TIMEZONE)}
      </p>

      <section aria-labelledby="summary-heading" className="mt-8">
        <h2 id="summary-heading" className="font-serif text-lg font-semibold">
          Summary
        </h2>
        <Blocks blocks={note.blocks} />
      </section>

      {note.actionItems.length > 0 ? (
        <section aria-labelledby="actions-heading" className="mt-8">
          <h2 id="actions-heading" className="font-serif text-lg font-semibold">
            Action items
          </h2>
          <ul className="mt-3 space-y-2">
            {note.actionItems.map((a, i) => (
              <li key={i} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
                {a.text}
                {a.ownerName || a.due ? (
                  <span className="mt-0.5 block text-xs text-[var(--fg-muted)]">
                    {[a.ownerName, a.due ? `due ${a.due}` : null].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {note.transcript ? (
        <section aria-labelledby="transcript-heading" className="mt-8">
          <h2 id="transcript-heading" className="font-serif text-lg font-semibold">
            Transcript
          </h2>
          <ol className="mt-3 space-y-2">
            {note.transcript.map((line, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="tabular font-mono text-xs text-[var(--fg-subtle)]">
                  {formatOffset(line.startMs)}
                </span>{' '}
                <span className="font-medium">{line.speaker}:</span> {line.text}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="mt-10 border-t border-[var(--border)] pt-4 text-xs text-[var(--fg-subtle)]">
        Shared from TipTop Kraken. This link stops working on{' '}
        {formatDate(note.expiresAt, DEFAULT_TIMEZONE)}, or sooner if it is revoked.
      </footer>
    </main>
  );
}

function Blocks({ blocks: all }: { blocks: SharedNoteView['blocks'] }) {
  // Arwin's notes carry their own "Summary" heading; under this page's
  // "Summary" it would say it twice.
  const blocks = all.filter((b) => !(b.kind === 'heading' && /^summary$/i.test(b.text.trim())));
  if (blocks.length === 0) {
    return <p className="mt-3 text-sm text-[var(--fg-muted)]">No summary was written.</p>;
  }
  return (
    <div className="mt-3 space-y-1.5">
      {blocks.map((b, i) => {
        const indent = b.depth === 2 ? 'ml-8' : b.depth === 1 ? 'ml-4' : '';
        if (b.kind === 'heading') {
          return (
            <h3 key={i} className="pt-2 font-serif text-base font-semibold">
              {b.text}
            </h3>
          );
        }
        return (
          <p key={i} className={cn('flex gap-2 text-sm leading-relaxed', indent)}>
            {b.kind === 'bullet' ? <span aria-hidden>•</span> : null}
            {b.kind === 'checkbox' ? <span aria-hidden>☐</span> : null}
            <span>{b.text}</span>
          </p>
        );
      })}
    </div>
  );
}
