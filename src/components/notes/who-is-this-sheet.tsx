'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Combine, Scissors, Search, Sparkles, UserRound, X } from 'lucide-react';
import { formatOffset } from '@/lib/notes/api';
import type {
  ParticipantView,
  SegmentView,
  SpeakerPersonInput,
  SpeakerView,
} from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import { activeSpeakers, domainOf, initials } from './helpers';

interface NetworkPerson {
  name: string | null;
  email: string;
  company: string | null;
}

/**
 * "This is…": the sheet a name chip opens (D-076). Calendar guests first
 * (spelling from the invite), then a search of the network, then any name
 * typed. One pick is one update to the voice, and every line from it reads
 * the new name. Also here: split a line (or the rest) off to someone else,
 * merge two voices that are one person, and "Remember this voice", shown only
 * when that person's consent is on file.
 */
export function WhoIsThisSheet({
  open,
  onOpenChange,
  speaker,
  line,
  participants,
  speakers,
  busy,
  onRelabel,
  onSplit,
  onMerge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  speaker: SpeakerView | null;
  /** The line the sheet was opened from, which Split acts on. */
  line: SegmentView | null;
  participants: readonly ParticipantView[];
  speakers: readonly SpeakerView[];
  busy: boolean;
  onRelabel: (person: SpeakerPersonInput | null, rememberVoice: boolean) => void;
  onSplit: (mode: 'line' | 'from_here') => void;
  onMerge: (into: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<NetworkPerson[]>([]);
  const [remember, setRemember] = React.useState(false);
  const [mergeInto, setMergeInto] = React.useState('');
  const searchId = React.useId();
  const mergeId = React.useId();

  // Network search, debounced; the guests route caps it and needs two letters.
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const handle = setTimeout(() => {
      void fetch(`/api/calendar/guests?q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((json: { ok?: boolean; people?: NetworkPerson[] }) =>
          setResults(json.ok && Array.isArray(json.people) ? json.people : []),
        )
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  if (!speaker) return null;

  const guests = participants.filter((p) => p.role !== 'self' && (p.name || p.email));
  const taken = new Map(
    speakers
      .filter((s) => s.personEmail && s.clusterKey !== speaker.clusterKey && !s.mergedInto)
      .map((s) => [s.personEmail as string, s.displayName]),
  );
  const others = activeSpeakers(speakers).filter((s) => s.clusterKey !== speaker.clusterKey);
  const typed = query.trim();
  const visibleResults = typed.length >= 2 ? results : [];
  const exact = [...guests.map((g) => g.name), ...visibleResults.map((r) => r.name)].some(
    (n) => n && n.toLowerCase() === typed.toLowerCase(),
  );

  const pick = (person: SpeakerPersonInput) => onRelabel(person, remember);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('');
          setResults([]);
          setMergeInto('');
        }
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-x-0 top-[var(--titlebar-h)] bottom-0 z-[var(--z-overlay)] bg-[var(--scrim)] backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          data-who-is-this=""
          className={cn(
            'shadow-overlay fixed z-[var(--z-overlay)] flex max-h-[85dvh] flex-col overflow-hidden border border-[var(--border-strong)] bg-[var(--bg-overlay)]',
            // A bottom sheet on a phone, a dialog on a wider screen.
            'inset-x-0 bottom-0 rounded-t-[var(--radius-panel)]',
            'sm:inset-x-auto sm:top-[calc(50%+var(--titlebar-h)/2)] sm:bottom-auto sm:left-1/2 sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--radius-panel)]',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="font-serif text-lg font-semibold">
                This is…
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-sm text-[var(--fg-muted)]">
                {speaker.resolved ? `Now: ${speaker.displayName}` : speaker.displayName} ·{' '}
                {speaker.lineCount} {speaker.lineCount === 1 ? 'line' : 'lines'}. Every line from
                this voice changes.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="rounded-md p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          <div className="scrollbar-thin space-y-5 overflow-y-auto px-5 py-4">
            {speaker.suggestions.length > 0 ? (
              <section aria-label="Suggestions">
                <h3 className="text-micro font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                  Suggested
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {speaker.suggestions.map((s) => (
                    <li key={`${s.email ?? ''}-${s.name}`}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          pick({ name: s.name, email: s.email, crmPersonId: s.crmPersonId })
                        }
                        className="flex w-full items-start gap-2 rounded-md border border-dashed border-[var(--border-control)] px-3 py-2 text-left text-sm hover:border-[var(--gold)]"
                      >
                        <Sparkles
                          className="mt-0.5 size-4 shrink-0 text-[var(--gold)]"
                          aria-hidden
                        />
                        <span>
                          <span className="font-medium">{s.name}</span>
                          <span className="block text-xs text-[var(--fg-muted)]">{s.reason}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section aria-label="On the invite">
              <h3 className="text-micro font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                On the invite
              </h3>
              {guests.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-muted)]">
                  No guests on this meeting. Search below, or type a name.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {guests.map((g) => {
                    const on = g.email ? taken.get(g.email) : undefined;
                    return (
                      <li key={g.email ?? g.name ?? ''}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            pick({
                              name: g.name ?? g.email ?? 'Guest',
                              email: g.email,
                              crmPersonId: g.crmPersonId,
                            })
                          }
                          className="flex w-full items-center gap-3 rounded-md border border-[var(--border)] px-3 py-2 text-left text-sm hover:border-[var(--gold)] hover:bg-[var(--bg-hover)]"
                        >
                          <span
                            aria-hidden
                            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]"
                          >
                            {initials(g.name ?? g.email)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{g.name ?? g.email}</span>
                            <span className="block truncate text-xs text-[var(--fg-muted)]">
                              {[domainOf(g.email), g.isExternal ? 'Guest' : 'Your team']
                                .filter(Boolean)
                                .join(' · ')}
                              {on ? ` · already on ${on}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section aria-label="Someone else">
              <label
                htmlFor={searchId}
                className="text-micro font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase"
              >
                Search your network, or type a name
              </label>
              <div className="relative mt-2">
                <Search
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--fg-subtle)]"
                  aria-hidden
                />
                <Input
                  id={searchId}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Name, company or address"
                  className="pl-8"
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typed.length >= 2 && !busy) {
                      e.preventDefault();
                      pick({ name: typed });
                    }
                  }}
                />
              </div>
              {visibleResults.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {visibleResults.map((r) => (
                    <li key={r.email}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => pick({ name: r.name ?? r.email, email: r.email })}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                      >
                        <UserRound
                          className="size-4 shrink-0 text-[var(--fg-subtle)]"
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{r.name ?? r.email}</span>
                          {r.company ? (
                            <span className="text-[var(--fg-muted)]"> · {r.company}</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {typed.length >= 2 && !exact ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => pick({ name: typed })}
                >
                  Use “{typed}”
                </Button>
              ) : null}
            </section>

            {speaker.canRememberVoice ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span>
                  Remember this voice
                  <span className="block text-xs text-[var(--fg-muted)]">
                    Their consent is on file. Used only to put their name on their lines.
                  </span>
                </span>
              </label>
            ) : null}

            <section aria-label="Fix the voice" className="border-t border-[var(--border)] pt-4">
              <h3 className="text-micro font-sans font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Not one person?
              </h3>
              {line ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onSplit('line')}
                  >
                    <Scissors aria-hidden /> Only this line ({formatOffset(line.startMs)})
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onSplit('from_here')}
                  >
                    <Scissors aria-hidden /> Split from this line
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--fg-muted)]">
                  To split, open this from the line where someone else starts talking.
                </p>
              )}
              {others.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={mergeId} className="text-xs text-[var(--fg-muted)]">
                      Merge with…
                    </label>
                    <Select
                      id={mergeId}
                      value={mergeInto}
                      onChange={(e) => setMergeInto(e.target.value)}
                      className="mt-1"
                    >
                      <option value="">Pick the voice that is the same person</option>
                      {others.map((s) => (
                        <option key={s.clusterKey} value={s.clusterKey}>
                          {s.displayName} ({s.lineCount} lines)
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!mergeInto || busy}
                    onClick={() => onMerge(mergeInto)}
                  >
                    <Combine aria-hidden /> Merge
                  </Button>
                </div>
              ) : null}
              {speaker.resolved && !speaker.isOwner ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => onRelabel(null, false)}
                >
                  Clear the name
                </Button>
              ) : null}
            </section>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
