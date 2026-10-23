'use client';

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Ban, Copy, Mic, ShieldCheck } from 'lucide-react';
import { NOTES_API } from '@/lib/notes/api';
import {
  CONSENT_BANNER_TEXT,
  CONSENT_CHECKBOX_LABEL,
  CONSENT_NOTICE_TEXT,
  NEVER_RECORD_MESSAGE,
  type ConsentMethod,
  type NeverRecordMatch,
} from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/util/cn';
import { notesCall } from './api-client';
import type { StartInput } from './use-recorder';

const METHODS: { value: ConsentMethod; label: string }[] = [
  { value: 'chat_notice', label: 'Posted the notice in the meeting chat' },
  { value: 'verbal', label: 'Said it out loud at the start' },
  { value: 'in_person_notice', label: 'Told everyone in the room' },
  { value: 'invite_notice', label: 'It was in the invite' },
];

/**
 * The consent step (D-076): shown before any audio is captured, and the only
 * way to Start. Start stays disabled until "I've told everyone / posted the
 * notice" is ticked; a meeting on the never-record list shows that instead of
 * Start at all. The method and time are logged on the meeting by the server.
 */
export function ConsentBanner({
  open,
  onOpenChange,
  meetingId,
  neverRecord,
  inPerson,
  canRecord,
  cannotRecordReason,
  callAudioAvailable = true,
  liveCapture = false,
  error = null,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  neverRecord: NeverRecordMatch | null;
  inPerson: boolean;
  canRecord: boolean;
  cannotRecordReason: string | null;
  /** The browser can hear a meeting tab or screen; when not, only "In the room" is offered. */
  callAudioAvailable?: boolean;
  /** The browser recorder captures (not the demo's scripted call): offer the sound check. */
  liveCapture?: boolean;
  /** Why the last Start did not record (a refused microphone, no meeting audio). */
  error?: string | null;
  onStart: (input: StartInput) => Promise<boolean>;
}) {
  const [method, setMethod] = React.useState<ConsentMethod>(
    inPerson ? 'in_person_notice' : 'chat_notice',
  );
  const [chosenMode, setMode] = React.useState<StartInput['mode']>(inPerson ? 'in_person' : 'call');
  // A browser that cannot hear the meeting (a phone, Safari) records the room.
  const callOk = !liveCapture || callAudioAvailable;
  const mode: StartInput['mode'] = callOk ? chosenMode : 'in_person';
  const [told, setTold] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const checkId = React.useId();

  const copyNotice = async () => {
    try {
      await navigator.clipboard.writeText(CONSENT_NOTICE_TEXT);
      setCopied(true);
      setMethod('chat_notice');
      toast.success('Notice copied. Paste it in the meeting chat.');
    } catch {
      toast.error('Could not copy. Select the notice and copy it.');
    }
    // Logged even when the clipboard refused: the person saw the notice.
    void notesCall('POST', NOTES_API.consent(meetingId), { event: 'notice_copied' });
  };

  const start = async () => {
    if (!told || starting) return;
    setStarting(true);
    const started = await onStart({
      method,
      noticeText: method === 'chat_notice' ? CONSENT_NOTICE_TEXT : null,
      mode,
    });
    setStarting(false);
    if (started) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={CONSENT_BANNER_TEXT}
        description="Nothing is captured until you press Start. No audio is ever stored: only the words, as text."
        data-consent-banner=""
      >
        {neverRecord ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-3 text-sm"
          >
            <Ban className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden />
            <div>
              <p className="font-semibold text-[var(--danger)]">{NEVER_RECORD_MESSAGE}</p>
              <p className="mt-1 text-[var(--fg-muted)]">
                It matched the {neverRecord.label} rule: {neverRecord.reason}. Rules are in Notes
                settings.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3">
              <p className="text-sm leading-relaxed" data-consent-notice="">
                {CONSENT_NOTICE_TEXT}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => void copyNotice()}
              >
                <Copy aria-hidden /> {copied ? 'Copied' : 'Copy notice'}
              </Button>
            </div>

            <fieldset>
              <legend className="text-sm font-medium">How everyone knows</legend>
              <div className="mt-2 space-y-1.5">
                {METHODS.map((m) => (
                  <label key={m.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="consent-method"
                      value={m.value}
                      checked={method === m.value}
                      onChange={() => setMethod(m.value)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-sm font-medium">What to capture</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    [
                      'call',
                      'A call on this computer',
                      'You on the mic, everyone else from the meeting tab.',
                    ],
                    ['in_person', 'In the room', 'One microphone for everyone.'],
                  ] as const
                ).map(([value, label, hint]) => {
                  const unavailable = value === 'call' && !callOk;
                  return (
                    <label
                      key={value}
                      className={cn(
                        'flex items-start gap-2 rounded-md border p-2.5 text-sm',
                        unavailable ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                        mode === value
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border)]',
                      )}
                    >
                      <input
                        type="radio"
                        name="capture-mode"
                        value={value}
                        checked={mode === value}
                        disabled={unavailable}
                        onChange={() => setMode(value)}
                        className="mt-0.5 size-4 accent-[var(--accent)]"
                      />
                      <span>
                        <span className="font-medium">{label}</span>
                        <span className="block text-xs text-[var(--fg-muted)]">
                          {unavailable
                            ? 'This browser cannot hear a meeting tab: use Chrome or Edge on a computer.'
                            : hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {liveCapture ? (
                <p className="mt-2 text-xs text-[var(--fg-muted)]">
                  First time on this computer?{' '}
                  <Link href="/sound-check" target="_blank" className="link-inline">
                    Run a sound check
                  </Link>{' '}
                  (nothing is sent anywhere).
                </p>
              ) : null}
            </fieldset>

            <label
              htmlFor={checkId}
              className="flex items-start gap-2.5 rounded-md border border-[var(--gold-rule)] bg-[var(--note-soft)] p-3 text-sm font-medium"
            >
              <input
                id={checkId}
                type="checkbox"
                checked={told}
                onChange={(e) => setTold(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent)]"
                required
              />
              {CONSENT_CHECKBOX_LABEL}
            </label>
            {!canRecord && cannotRecordReason ? (
              <p className="text-sm text-[var(--fg-muted)]">{cannotRecordReason}</p>
            ) : null}
            {error ? (
              <p
                role="alert"
                data-consent-error=""
                className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
              >
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {neverRecord ? null : (
            <Button
              variant="primary"
              disabled={!told || !canRecord || starting}
              loading={starting}
              onClick={() => void start()}
            >
              {told ? <Mic aria-hidden /> : <ShieldCheck aria-hidden />}
              Start
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
