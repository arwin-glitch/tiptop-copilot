'use client';

import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import type { ParticipantView, SpeakerView } from '@/lib/types/notes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { activeSpeakers, certaintyWords, domainOf, initials } from './helpers';
import { SpeakerChip } from './speaker-chip';

/**
 * Who was in the meeting (D-076): every voice with how sure its name is (their
 * own mic, you confirmed, the calendar, a suggestion), and every guest on the
 * invite with links into the network and their company, and "Chat about this
 * person".
 */
export function PeoplePanel({
  participants,
  speakers,
  onOpenSpeaker,
  onChatAbout,
}: {
  participants: readonly ParticipantView[];
  speakers: readonly SpeakerView[];
  onOpenSpeaker: (speaker: SpeakerView) => void;
  onChatAbout: (email: string) => void;
}) {
  const voices = activeSpeakers(speakers);
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-people="">
      <section aria-labelledby="voices-heading">
        <h2 id="voices-heading" className="font-serif text-base font-semibold">
          Voices
        </h2>
        {voices.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            No one has spoken yet. Voices appear as the transcript fills in.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {voices.map((s) => (
              <li key={s.clusterKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <SpeakerChip speaker={s} onOpen={onOpenSpeaker} />
                <span className="text-xs text-[var(--fg-muted)]">
                  {certaintyWords(s.certainty)} · {s.lineCount}{' '}
                  {s.lineCount === 1 ? 'line' : 'lines'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="guests-heading">
        <h2 id="guests-heading" className="font-serif text-base font-semibold">
          On the invite
        </h2>
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {participants.map((p) => {
            const name = p.name ?? p.email ?? 'Guest';
            const domain = domainOf(p.email);
            return (
              <li
                key={`${p.email ?? ''}-${p.name ?? ''}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]"
                >
                  {initials(name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {name}
                    {p.role === 'self' ? <Badge tone="outline">You</Badge> : null}
                    {p.role === 'organizer' ? <Badge tone="outline">Organizer</Badge> : null}
                    {p.isExternal ? <Badge tone="neutral">Guest</Badge> : null}
                  </p>
                  <p className="flex flex-wrap gap-x-3 text-xs">
                    <Link
                      href={`/network?tab=people&q=${encodeURIComponent(p.name ?? domain ?? '')}`}
                      className="link-inline"
                    >
                      In your network
                    </Link>
                    {domain && p.isExternal ? (
                      <Link
                        href={`/deals?q=${encodeURIComponent(domain.split('.')[0] ?? domain)}`}
                        className="link-inline"
                      >
                        {domain}
                      </Link>
                    ) : null}
                  </p>
                </div>
                {p.email && p.role !== 'self' ? (
                  <Button size="sm" variant="ghost" onClick={() => onChatAbout(p.email as string)}>
                    <MessageSquare aria-hidden /> Chat about {p.name?.split(' ')[0] ?? 'them'}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
