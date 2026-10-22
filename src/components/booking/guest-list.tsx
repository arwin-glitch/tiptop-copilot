'use client';

import * as React from 'react';
import { UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/form';
import { isPlainEmail, LIMITS } from '@/lib/booking/request';

/**
 * "Add guests" on the booking form (D-078, like Calendly's): up to the
 * link's limit of other people's addresses, each invited with the visitor
 * by the calendar invitation. Checked here as they are added (a plain
 * address, once, not the visitor's own) and again on the server, which also
 * refuses the host's and the team's own addresses.
 */
export function GuestList({
  guests,
  max,
  booker,
  onChange,
}: {
  guests: string[];
  max: number;
  /** The visitor's own address, which is never their guest. */
  booker: string;
  onChange: (guests: string[]) => void;
}) {
  const [open, setOpen] = React.useState(guests.length > 0);
  const [draft, setDraft] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const uid = React.useId();
  const focusInput = () => document.getElementById(`${uid}-guest`)?.focus();
  const full = guests.length >= max;

  const add = () => {
    const entries = draft
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (!entries.length) return;
    const next = [...guests];
    for (const email of entries) {
      if (!isPlainEmail(email)) {
        setProblem(`Check ${email}: it does not look like an email address.`);
        return;
      }
      if (email === booker.trim().toLowerCase()) {
        setProblem('That is your own address: you are invited already.');
        return;
      }
      if (next.includes(email)) continue;
      if (next.length >= max) {
        setProblem(`Add at most ${max} guests.`);
        break;
      }
      next.push(email);
    }
    setProblem(null);
    setDraft('');
    onChange(next);
    focusInput();
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(focusInput);
        }}
      >
        <UserPlus aria-hidden="true" />
        Add guests
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${uid}-guest`}>
        Guests <span className="font-normal text-[var(--fg-subtle)]">(optional, up to {max})</span>
      </Label>
      {guests.length ? (
        <ul aria-label="Guests" className="flex flex-wrap gap-2">
          {guests.map((email) => (
            <li
              key={email}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--border-strong)] bg-[var(--bg)] py-1 pr-1 pl-3 text-sm"
            >
              <span className="min-w-0 truncate">{email}</span>
              <button
                type="button"
                onClick={() => onChange(guests.filter((g) => g !== email))}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
                aria-label={`Remove ${email}`}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!full ? (
        <div className="flex gap-2">
          <Input
            id={`${uid}-guest`}
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="name@company.com"
            maxLength={LIMITS.email}
            value={draft}
            onChange={(e) => {
              setProblem(null);
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              }
            }}
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="secondary" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-[var(--warn)]">
          {problem}
        </p>
      ) : (
        <p className="text-xs text-[var(--fg-muted)]">
          {full
            ? `That is the most guests one booking can have (${max}).`
            : 'They get the calendar invitation too.'}
        </p>
      )}
    </div>
  );
}
