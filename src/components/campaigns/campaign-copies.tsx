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
import { campaignCall, jsonBody } from './campaign-api';

interface Copies {
  cc: string[];
  bcc: string[];
  bccMode: CampaignBccMode;
}

/**
 * The campaign's CC and BCC, both empty by default. Each list saves when you
 * leave it (or press Enter), and only when every entry is a real address:
 * the server refuses anything else whole, and so does this. Saving makes any
 * earlier review stale, so the review always shows what is saved.
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
  const [saved, setSaved] = React.useState(copies);
  const [errors, setErrors] = React.useState<{ cc?: string; bcc?: string }>({});
  const [saving, setSaving] = React.useState<'cc' | 'bcc' | 'mode' | null>(null);

  const save = async (key: 'cc' | 'bcc' | 'mode', patch: Record<string, string>) => {
    setSaving(key);
    onBusy('the CC/BCC change');
    const r = await campaignCall<{ copies: Copies }>(
      `/api/campaigns/${campaignId}/copies`,
      jsonBody('PATCH', patch),
    );
    setSaving(null);
    onBusy(null);
    if (!r.ok) {
      if (key === 'mode') toast.error(r.message);
      else setErrors((e) => ({ ...e, [key]: r.message }));
      return;
    }
    setSaved(r.data.copies);
    if (key !== 'mode') {
      setText((t) => ({ ...t, [key]: formatCopyList(r.data.copies[key]) }));
    }
    onChange();
  };

  const commit = (key: 'cc' | 'bcc') => {
    const value = text[key];
    if (value.trim() === formatCopyList(saved[key])) return;
    const parsed = parseCopyAddresses(value);
    if (!parsed.ok) {
      setErrors((e) => ({ ...e, [key]: parsed.message }));
      return;
    }
    setErrors((e) => ({ ...e, [key]: undefined }));
    void save(key, { [key]: value });
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
          disabled={saving !== null && saving !== key}
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
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={saved.bccMode === mode}
                  disabled={saving !== null}
                  onClick={() => {
                    if (saved.bccMode !== mode) void save('mode', { bccMode: mode });
                  }}
                  className={cn(
                    'min-h-9 rounded px-3 text-sm',
                    saved.bccMode === mode
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
