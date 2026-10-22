'use client';

import * as React from 'react';
import type { PresenceEntry } from '@/lib/events/contracts';
import { initialsOf, presenceName } from '@/lib/events/editor/presence';
import { cn } from '@/lib/util/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useStudio } from './studio-context';

/**
 * Who is in Studio: one colour per person, outsiders tagged "outside",
 * people not seen in the last 20 seconds greyed. "Jump to" follows someone
 * to the section they are on.
 */
export function PresenceAvatars() {
  const { sessionState, boot, select, labelOf, doc } = useStudio();
  const others = sessionState.presence.filter((p) => p.actorKey !== boot.actor.key);
  const me: PresenceEntry = {
    actorKey: boot.actor.key,
    name: boot.actor.name,
    color: boot.actor.color,
    outside: boot.actor.outside,
    focusedSectionId: null,
    typing: false,
    lastSeenAt: '',
    active: true,
  };
  const people = [me, ...others];
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center rounded-md px-1 py-1 hover:bg-[var(--bg-hover)]"
        aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'} in Studio: ${people
          .map(presenceName)
          .join(', ')}`}
      >
        <span className="flex -space-x-2">
          {people.slice(0, 5).map((p) => (
            <Avatar key={p.actorKey} person={p} />
          ))}
        </span>
        {people.length > 5 ? (
          <span className="ml-1 text-xs text-[var(--fg-muted)]">+{people.length - 5}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <ul aria-label="People in Studio" className="space-y-1">
          {people.map((p) => {
            const section = p.focusedSectionId
              ? doc.sections.find((s) => s.id === p.focusedSectionId)
              : null;
            const isMe = p.actorKey === boot.actor.key;
            return (
              <li key={p.actorKey} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <Avatar person={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {presenceName(p)}
                    {isMe ? ' (you)' : ''}
                  </span>
                  <span className="block truncate text-xs text-[var(--fg-muted)]">
                    {isMe
                      ? 'Editing'
                      : !p.active
                        ? 'Away'
                        : section
                          ? `${p.typing ? 'Typing in' : 'On'} ${labelOf(section)}`
                          : 'Looking around'}
                  </span>
                </span>
                {!isMe && section ? (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                    onClick={() => {
                      select(section.id);
                      document
                        .querySelector(`[data-studio-frame] [data-section-id="${section.id}"]`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    Jump to {p.name.split(/\s+/)[0]}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function Avatar({
  person,
  size = 'md',
}: {
  person: Pick<PresenceEntry, 'name' | 'color' | 'active' | 'outside'>;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      aria-hidden="true"
      title={presenceName(person)}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-[var(--bg-raised)]',
        size === 'sm' ? 'size-5 text-[9px]' : 'size-7 text-[11px]',
        !person.active && 'opacity-45 grayscale',
      )}
      style={{ backgroundColor: person.color }}
    >
      {initialsOf(person.name)}
      {person.outside ? (
        <span className="absolute -right-1 -bottom-1 rounded-sm bg-[var(--bg-raised)] px-0.5 text-[8px] leading-tight text-[var(--fg)] ring-1 ring-[var(--border)]">
          out
        </span>
      ) : null}
    </span>
  );
}
