'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { DAILY_CAP } from '@/lib/campaigns/limits';
import {
  MAX_COPY_ADDRESSES,
  copiesFor,
  formatCopyList,
  parseCopyAddresses,
} from '@/lib/campaigns/copies';
import type { CampaignBccMode } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { createSaveQueue, type SaveQueue } from '@/lib/util/save-queue';
import { campaignCall, jsonBody } from './campaign-api';

interface Copies {
  cc: string[];
  bcc: string[];
  bccMode: CampaignBccMode;
}

type CopyKey = 'cc' | 'bcc' | 'mode';

/**
 * The campaign's CC and BCC, both empty by default. Each list saves when you
 * leave it (or press Enter), and only when every entry is a real address:
 * the server refuses anything else whole, and so does this. Saving makes any
 * earlier review stale, so the review always shows what is saved.
 *
 * Saves go one at a time in the order they were made, and nothing waits
 * disabled for an earlier one (see createSaveQueue): leaving the BCC field by
 * clicking "The first email only" saves the list, then the choice, where the
 * click used to land on a button disabled by the list's save. The buttons
 * show a choice at once; a refused one goes back to what is saved. Each save
 * is its own draft edit on the server, so each makes an earlier review stale.
 */
export function CampaignCopies({
  campaignId,
  copies,
  recipientCount,
  onChange,
  onBusy,
}: {
  campaignId: string;
  copies: Copies;
  recipientCount: number;
  onChange: () => void;
  onBusy: (what: string | null) => void;
}) {
  const [text, setText] = React.useState({
    cc: formatCopyList(copies.cc),
    bcc: formatCopyList(copies.bcc),
  });
  const [errors, setErrors] = React.useState<{ cc?: string; bcc?: string }>({});
  /** The save on its way to the server now, if any. */
  const [saving, setSaving] = React.useState<CopyKey | null>(null);
  /** Where the BCC goes as the buttons show it: the last choice, saved or still to be. */
  const [mode, setMode] = React.useState<CampaignBccMode>(copies.bccMode);

  // Read by saves that wait their turn, so each sends what is current then.
  const saved = React.useRef<Copies>(copies);
  const wantedMode = React.useRef<CampaignBccMode>(copies.bccMode);
  /** Per list, the text handed to a save not finished yet: the same text again is no new save. */
  const sending = React.useRef<{ cc?: string; bcc?: string }>({});
  /** Per list, the number of its newest save: only that one's answer is shown. */
  const newest = React.useRef({ cc: 0, bcc: 0 });
  /** Choices of where the BCC goes, queued or on their way. */
  const modesWaiting = React.useRef(0);
  const busy = React.useRef(onBusy);
  React.useEffect(() => {
    busy.current = onBusy;
  });
  const queue = React.useRef<SaveQueue | null>(null);
  /** Queue a save behind any still on its way (made on the first, from an event). */
  const enqueue = (run: () => Promise<void>) => {
    queue.current ??= createSaveQueue((on) => busy.current(on ? 'the CC/BCC change' : null));
    void queue.current.add(run);
  };

  /**
   * One PATCH; reports its own failure. A list's save carries its number
   * (`newest`): a refused one that a newer save of the same list is queued
   * behind says nothing, since the field already holds the newer text and
   * its own answer is the one that counts.
   */
  const send = async (key: CopyKey, patch: Record<string, string>, number = 0) => {
    setSaving(key);
    const r = await campaignCall<{ copies: Copies }>(
      `/api/campaigns/${campaignId}/copies`,
      jsonBody('PATCH', patch),
    );
    setSaving(null);
    const latest = key === 'mode' || number === newest.current[key];
    if (key !== 'mode' && latest) sending.current[key] = undefined;
    if (!r.ok) {
      if (key === 'mode') {
        toast.error(r.message);
        // Back to what is saved, unless a later choice is still to be sent.
        if (wantedMode.current === patch.bccMode) {
          wantedMode.current = saved.current.bccMode;
          setMode(saved.current.bccMode);
        }
      } else if (latest) {
        setErrors((e) => ({ ...e, [key]: r.message }));
      }
      return;
    }
    saved.current = r.data.copies;
    if (key !== 'mode') {
      const sent = patch[key];
      // The saved list, tidied, unless the field was changed again meanwhile.
      setText((t) => (t[key] === sent ? { ...t, [key]: formatCopyList(r.data.copies[key]) } : t));
    }
    if (modesWaiting.current === 0) {
      wantedMode.current = r.data.copies.bccMode;
      setMode(r.data.copies.bccMode);
    }
    onChange();
  };

  const commit = (key: 'cc' | 'bcc') => {
    const value = text[key];
    const current = sending.current[key] ?? formatCopyList(saved.current[key]);
    if (value.trim() === current.trim()) return;
    const parsed = parseCopyAddresses(value);
    if (!parsed.ok) {
      setErrors((e) => ({ ...e, [key]: parsed.message }));
      return;
    }
    setErrors((e) => ({ ...e, [key]: undefined }));
    sending.current[key] = value;
    const number = ++newest.current[key];
    enqueue(() => send(key, { [key]: value }, number));
  };

  const choose = (next: CampaignBccMode) => {
    if (wantedMode.current === next) return;
    wantedMode.current = next;
    setMode(next);
    modesWaiting.current++;
    enqueue(async () => {
      try {
        // The choice as it stands now: clicked twice while waiting, only the last is sent.
        const wanted = wantedMode.current;
        if (wanted !== saved.current.bccMode) await send('mode', { bccMode: wanted });
      } finally {
        modesWaiting.current--;
      }
    });
  };

  const field = (key: 'cc' | 'bcc', label: string, hint: string) => {
    const id = `campaign-${key}`;
    const error = errors[key];
    return (
      <div className="space-y-1.5">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <Input
          id={id}
          value={text[key]}
          placeholder="partner@firm.example, ops@firm.example"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            const value = e.target.value;
            setText((t) => ({ ...t, [key]: value }));
            if (error) setErrors((x) => ({ ...x, [key]: undefined }));
          }}
          onBlur={() => commit(key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(key);
            }
          }}
        />
        <p
          id={`${id}-hint`}
          className={cn('text-xs', error ? 'text-[var(--warn)]' : 'text-[var(--fg-muted)]')}
          aria-live="polite"
        >
          {error ?? (saving === key ? 'Saving…' : hint)}
        </p>
      </div>
    );
  };

  const people = `${recipientCount} ${recipientCount === 1 ? 'person' : 'people'}`;
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <section aria-labelledby="campaign-copies-heading" className="space-y-3">
          <h2 id="campaign-copies-heading" className="font-serif text-base font-semibold">
            CC and BCC{' '}
            <span className="text-sm font-normal text-[var(--fg-muted)]">(optional)</span>
          </h2>
          <p className="text-xs text-[var(--fg-muted)]">
            Every email still goes To one person only. Each address here gets a copy of every email
            it is on (with {people}, that is up to {recipientCount} copies each), and every copy
            counts toward the {DAILY_CAP}-a-day sending limit. Up to {MAX_COPY_ADDRESSES} addresses
            each. To copy someone on one person&rsquo;s email only, use CC on that person above.
          </p>
          {field('cc', 'CC on every email', 'Everyone the email goes to sees these addresses.')}
          {field(
            'bcc',
            'BCC',
            'Hidden from the people the email goes to. Choose below whether it is on every email or one sample copy.',
          )}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">BCC goes on</legend>
            <div className="inline-flex flex-wrap rounded-md border border-[var(--border)] p-0.5">
              {(
                [
                  ['every', 'Every email'],
                  ['first', 'The first email only'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => choose(value)}
                  className={cn(
                    'min-h-9 rounded px-3 text-sm',
                    mode === value
                      ? 'bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                      : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--fg-muted)]">
              The first email only: one sample copy goes with the first email this campaign actually
              sends, and never again, even after a pause.
            </p>
          </fieldset>
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Under "Send test to me": who the real email to the previewed person would
 * copy, and their photo. A test is never copied to anyone; this says so, as
 * text, instead.
 */
export function WouldCopyNote({
  copies,
  recipient,
}: {
  copies: Copies;
  recipient: { email: string; name: string | null; cc?: string[]; photoName?: string | null };
}) {
  const would = copiesFor(recipient.email, {
    campaignCc: copies.cc,
    personalCc: recipient.cc ?? [],
    bcc: copies.bcc,
  });
  const lines: string[] = [];
  if (recipient.photoName) lines.push(`Attaches ${recipient.photoName}, as it will for them.`);
  if (would.cc.length || would.bcc.length) {
    const parts = [
      would.cc.length ? `would CC ${would.cc.join(', ')}` : '',
      would.bcc.length
        ? `would BCC ${would.bcc.join(', ')}${copies.bccMode === 'first' ? ' (first email only)' : ''}`
        : '',
    ].filter(Boolean);
    lines.push(`Not copied on a test: the real email ${parts.join(' and ')}.`);
  }
  if (!lines.length) return null;
  return (
    <p className="text-xs text-[var(--fg-muted)]" data-testid="test-would-copy">
      {lines.join(' ')}
    </p>
  );
}
