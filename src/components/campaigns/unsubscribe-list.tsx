'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Notice } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { SectionHeading } from '@/components/shell/page-header';
import { RECENT_UNSUBSCRIBE_DAYS as RECENT_DAYS } from '@/lib/campaigns/status';

export interface UnsubscribeRow {
  email: string;
  at: string;
  source: 'link' | 'manual';
  campaignName: string | null;
}

async function post(body: { action: 'resubscribe' | 'unsubscribe'; email: string }) {
  try {
    const res = await fetch('/api/campaigns/unsubscribes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      already?: boolean;
    } | null;
    return res.ok
      ? { ok: true as const, already: Boolean(json?.already) }
      : { ok: false as const, message: json?.error?.message ?? 'That did not work. Try again.' };
  } catch {
    return { ok: false as const, message: 'Could not reach Kraken. Try again.' };
  }
}

/**
 * Who unsubscribed from campaigns, newest first. Every campaign leaves them
 * out; here a person can put one back (they asked to get these again) or take
 * an address off by hand (they replied asking to stop).
 */
export function UnsubscribeList({
  rows,
  recent,
  timezone,
}: {
  rows: UnsubscribeRow[];
  /** How many unsubscribed in the last RECENT_DAYS, counted on the server. */
  recent: number;
  timezone: string;
}) {
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [email, setEmail] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? rows : rows.slice(0, 10);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  const resubscribe = async (address: string) => {
    const yes = await confirm({
      title: `Put ${address} back on?`,
      description: 'Only do this if they asked to get these emails again.',
      confirmLabel: 'Put back on',
    });
    if (!yes) return;
    setBusy(address);
    const r = await post({ action: 'resubscribe', email: address });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(`${address} will get campaigns again.`);
    router.refresh();
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy('add');
    const r = await post({ action: 'unsubscribe', email: address });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(
      r.already ? `${address} was already unsubscribed.` : `${address} will be left out.`,
    );
    setEmail('');
    router.refresh();
  };

  return (
    <section aria-labelledby="unsubscribed-heading" className="space-y-3">
      <SectionHeading count={rows.length}>
        <span id="unsubscribed-heading">Unsubscribed</span>
      </SectionHeading>
      {recent ? (
        <Notice>
          {recent} {recent === 1 ? 'person' : 'people'} unsubscribed in the last {RECENT_DAYS} days.
          Every campaign leaves them out.
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">Nobody has unsubscribed.</p>
      ) : (
        <ul
          aria-label="Unsubscribed addresses"
          className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
        >
          {shown.map((r) => (
            <li key={r.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-all">{r.email}</p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {fmt(r.at)} ·{' '}
                  {r.source === 'manual'
                    ? 'taken off by hand'
                    : `from ${r.campaignName ?? 'a campaign'}`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={busy === r.email}
                disabled={busy !== null}
                onClick={() => void resubscribe(r.email)}
              >
                Resubscribe
              </Button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown.length ? (
        <Button variant="link" size="sm" className="px-0" onClick={() => setShowAll(true)}>
          Show all {rows.length}
        </Button>
      ) : null}
      <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2">
        <Field
          label="Take an address off by hand"
          htmlFor="unsubscribe-email"
          hint="For someone who replied asking to stop."
          className="min-w-0 flex-1"
        >
          <Input
            id="unsubscribe-email"
            aria-describedby="unsubscribe-email-hint"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          loading={busy === 'add'}
          disabled={!email.trim() || busy !== null}
        >
          Leave out
        </Button>
      </form>
      {confirmDialog}
    </section>
  );
}
