'use client';

import * as React from 'react';
import {
  ArrowRight,
  Check,
  CloudOff,
  Cpu,
  HelpCircle,
  Link2,
  Loader2,
  Mic,
  Quote,
  ShieldOff,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/util/cn';

/**
 * A five-picture tour of Copilot Notes (D-076), for a visual learner:
 * diagrams, not paragraphs. The consent step, speech staying on this
 * computer, fixing a name, Arwin writing the notes (Quick notes at once, his
 * in a minute or three), and sharing.
 * Offered as a small banner the first time (never a pop-up over the meeting),
 * and from "How it works" afterwards. Whether it was seen is a display
 * preference, kept in this browser only.
 */

const SEEN_KEY = 'tiptop-notes-tour-seen';
const listeners = new Set<() => void>();
let seenInMemory = false;

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readSeen(): boolean {
  if (seenInMemory) return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen() {
  seenInMemory = true;
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Blocked storage only forgets the dismissal.
  }
  for (const l of listeners) l();
}

const STEPS = [
  { title: 'Before you start', caption: 'Tell everyone. Tick the box. Then Start.' },
  {
    title: 'Heard on this computer',
    caption: 'Your computer turns speech into text, for free. Only the words are saved.',
  },
  { title: 'Fix a name', caption: 'Tap a name chip, pick the person: every line changes.' },
  {
    title: 'Arwin writes the notes',
    caption: "Quick notes at once. Arwin's in 1-3 minutes, each point with its source.",
  },
  { title: 'Share', caption: 'Summary only unless you add the transcript. Revoke any time.' },
] as const;

export function NotesTour() {
  // Seen: true on the server, so the banner never flashes in before hydration.
  const seen = React.useSyncExternalStore(subscribe, readSeen, () => true);
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);

  const show = () => {
    setStep(0);
    setOpen(true);
  };

  return (
    <>
      {seen ? (
        <Button size="sm" variant="ghost" onClick={show}>
          <HelpCircle aria-hidden /> How it works
        </Button>
      ) : (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-l-2 border-[var(--border)] border-l-[var(--gold)] bg-[var(--note-soft)] px-3 py-2 text-sm"
          data-notes-tour-banner=""
        >
          <span>New to Copilot Notes? Five pictures show how it works.</span>
          <Button size="sm" variant="secondary" onClick={show}>
            Show me
          </Button>
          <button
            type="button"
            onClick={markSeen}
            aria-label="Hide the tour"
            className="rounded p-1 text-[var(--fg-subtle)] hover:bg-[var(--bg-hover)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) markSeen();
          setOpen(next);
        }}
      >
        <DialogContent
          title={`${step + 1} of ${STEPS.length}: ${STEPS[step]?.title ?? ''}`}
          description={STEPS[step]?.caption}
        >
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-4">
            {step === 0 ? (
              <ConsentSketch />
            ) : step === 1 ? (
              <SpeechSketch />
            ) : step === 2 ? (
              <NameSketch />
            ) : step === 3 ? (
              <ArwinSketch />
            ) : (
              <ShareSketch />
            )}
          </div>
          <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
            {STEPS.map((s, i) => (
              <span
                key={s.title}
                className={cn(
                  'size-1.5 rounded-full',
                  i === step ? 'bg-[var(--gold)]' : 'bg-[var(--border-strong)]',
                )}
              />
            ))}
          </div>
          <DialogFooter>
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
                Back
              </Button>
            ) : null}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
                Next
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => {
                  markSeen();
                  setOpen(false);
                }}
              >
                Got it
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Arrow() {
  return <ArrowRight className="size-5 shrink-0 text-[var(--gold)]" aria-hidden />;
}

function ConsentSketch() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3"
      role="img"
      aria-label="Copy the notice, tick the box, then Start"
    >
      <div className="w-36 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-2 text-[11px]">
        “I’m using TipTop Copilot to take notes…”
        <span className="mt-1 block rounded bg-[var(--accent-soft)] px-1 text-center">
          Copy notice
        </span>
      </div>
      <Arrow />
      <div className="flex items-center gap-1.5 rounded border border-[var(--gold-rule)] bg-[var(--note-soft)] px-2 py-1.5 text-[11px] font-medium">
        <span className="flex size-3.5 items-center justify-center rounded-sm bg-[var(--accent)] text-[var(--accent-fg)]">
          <Check className="size-2.5" aria-hidden />
        </span>
        I’ve told everyone
      </div>
      <Arrow />
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--danger)] px-2.5 py-1 text-[11px] font-semibold text-[var(--danger-fg)]">
        <Mic className="size-3" aria-hidden /> Recording
      </span>
    </div>
  );
}

function SpeechSketch() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3"
      role="img"
      aria-label="Your voice goes to Whisper on this computer, and only lines of text go to Copilot; no speech service"
    >
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--gold-rule)] bg-[var(--note-soft)] px-2.5 py-1 text-[11px] font-medium">
        <Mic className="size-3" aria-hidden /> Voices
      </span>
      <Arrow />
      <div className="w-32 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-2 text-center text-[11px]">
        <Cpu className="mx-auto mb-1 size-4 text-[var(--accent)]" aria-hidden />
        <span className="block font-semibold">This computer</span>
        <span className="block text-[var(--fg-muted)]">Whisper, free</span>
      </div>
      <Arrow />
      <div className="space-y-1">
        <span className="block rounded bg-[var(--accent-soft)] px-2 py-0.5 text-[11px]">
          Dana: We ship in March.
        </span>
        <span className="block rounded bg-[var(--accent-soft)] px-2 py-0.5 text-[11px]">
          Priya: Pilots start now.
        </span>
      </div>
      <span className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--border-control)] px-2 py-1 text-[11px] text-[var(--fg-muted)]">
        <CloudOff className="size-3" aria-hidden /> No audio sent
      </span>
    </div>
  );
}

function NameSketch() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3"
      role="img"
      aria-label="Tap Guest 2, choose the person, and every line takes the name"
    >
      <span className="rounded-full border border-dashed border-[var(--border-control)] px-2 py-0.5 text-[11px]">
        Guest 2 · Who is this?
      </span>
      <Arrow />
      <div className="w-32 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-2 text-[11px]">
        <span className="block font-semibold">This is…</span>
        <span className="mt-1 block rounded bg-[var(--accent-soft)] px-1">Priya Shah</span>
        <span className="mt-0.5 block px-1 text-[var(--fg-muted)]">Dana Reyes</span>
      </div>
      <Arrow />
      <div className="space-y-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="block rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium"
          >
            Priya Shah
          </span>
        ))}
      </div>
    </div>
  );
}

function ArwinSketch() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3"
      role="img"
      aria-label="Stop, Quick notes at once, then Arwin's notes with a source on every point"
    >
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-raised)] px-2.5 py-1 text-[11px] font-semibold">
        <Square className="size-3" aria-hidden /> Stop
      </span>
      <Arrow />
      <div className="w-32 space-y-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-2 text-[11px]">
        <span className="block font-semibold">Quick notes</span>
        <span className="flex items-center gap-1 text-[var(--fg-muted)]">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Arwin is writing…
        </span>
      </div>
      <Arrow />
      <div className="w-36 space-y-1 rounded border border-[var(--gold-rule)] bg-[var(--note-soft)] p-2 text-[11px]">
        <span className="block font-semibold">Written by Arwin</span>
        <span className="flex items-center justify-between gap-1">
          Raising $4M seed
          <Quote className="size-2.5 text-[var(--fg-subtle)]" aria-hidden />
        </span>
        <span className="flex items-center justify-between gap-1">
          Send the data room
          <Check className="size-3 text-[var(--ok)]" aria-hidden />
        </span>
      </div>
    </div>
  );
}

function ShareSketch() {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-3"
      role="img"
      aria-label="Summary only, 30 days, copy the link, revoke any time"
    >
      <div className="w-36 space-y-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-2 text-[11px]">
        <span className="flex justify-between">
          Summary <Check className="size-3 text-[var(--ok)]" aria-hidden />
        </span>
        <span className="flex justify-between text-[var(--fg-muted)]">
          Transcript <X className="size-3" aria-hidden />
        </span>
        <span className="block text-[var(--fg-muted)]">Expires in 30 days</span>
      </div>
      <Arrow />
      <span className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 font-mono text-[10px]">
        <Link2 className="size-3" aria-hidden /> /n/…
      </span>
      <Arrow />
      <span className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px]">
        <ShieldOff className="size-3" aria-hidden /> Revoke
      </span>
    </div>
  );
}
