'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Copy, Link2, ShieldOff } from 'lucide-react';
import { NOTES_API } from '@/lib/notes/api';
import {
  NOTES_LIMITS,
  SHARE_EXPIRY_DAYS,
  type CreateShareLinkResponse,
  type ShareExpiryDays,
  type ShareLinkView,
} from '@/lib/types/notes';
import { formatDate, formatWeekdayTime } from '@/lib/util/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input, Switch } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import { notesCall } from './api-client';

/**
 * Sharing a meeting's notes outside Kraken (D-076). The summary only by
 * default; the transcript only when switched on. Links expire (7, 30 or 90
 * days) and revoke at once; the full link is shown once, because Kraken keeps
 * only a fingerprint (hash) of it. The page it opens carries no email address.
 */
export function SharePanel({
  meetingId,
  links,
  notesReady,
  timeZone,
  onLinks,
}: {
  meetingId: string;
  links: readonly ShareLinkView[];
  notesReady: boolean;
  timeZone: string;
  onLinks: (links: ShareLinkView[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<string | null>(null);

  const revoke = async (linkId: string) => {
    setRevoking(linkId);
    const res = await notesCall<{ link: ShareLinkView }>(
      'DELETE',
      NOTES_API.shareLink(meetingId, linkId),
    );
    setRevoking(null);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    onLinks(links.map((l) => (l.id === linkId ? res.link : l)));
    toast.success('Link revoked. It opens nothing from now on.');
  };

  return (
    <section aria-label="Share" className="space-y-4" data-share="">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-[var(--fg-muted)]">
          A read-only page for someone outside Kraken: the summary and action items, and the
          transcript only if you switch it on. Links expire and can be revoked at any time.
        </p>
        <Button variant="primary" onClick={() => setOpen(true)} disabled={!notesReady}>
          <Link2 aria-hidden /> Create share link
        </Button>
      </div>
      {!notesReady ? (
        <p className="text-sm text-[var(--fg-muted)]">
          Notes have to be written before they can be shared. Stop the recording, or press
          Regenerate on the Notes tab.
        </p>
      ) : null}

      {links.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border-strong)] px-3 py-4 text-sm text-[var(--fg-muted)]">
          No share links yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {links.map((link) => {
            const state = link.revokedAt ? 'Revoked' : link.active ? 'Active' : 'Expired';
            return (
              <li
                key={link.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
                data-share-link={state.toLowerCase()}
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={link.active ? 'ok' : 'neutral'}>{state}</Badge>
                    <span className="font-medium">
                      {link.includeTranscript ? 'Summary and transcript' : 'Summary only'}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                    {link.active
                      ? `Expires ${formatDate(link.expiresAt, timeZone)}`
                      : link.revokedAt
                        ? `Revoked ${formatDate(link.revokedAt, timeZone)}`
                        : `Expired ${formatDate(link.expiresAt, timeZone)}`}
                    {' · '}
                    {link.viewCount === 0
                      ? 'Not viewed yet'
                      : `Viewed ${link.viewCount} ${link.viewCount === 1 ? 'time' : 'times'}${
                          link.lastViewedAt
                            ? `, last ${formatWeekdayTime(link.lastViewedAt, timeZone)}`
                            : ''
                        }`}
                  </p>
                </div>
                {link.active ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={revoking === link.id}
                    onClick={() => void revoke(link.id)}
                  >
                    <ShieldOff aria-hidden /> Revoke
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        meetingId={meetingId}
        onCreated={(link) => onLinks([link, ...links])}
      />
    </section>
  );
}

function ShareDialog({
  open,
  onOpenChange,
  meetingId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  onCreated: (link: ShareLinkView) => void;
}) {
  const [includeTranscript, setIncludeTranscript] = React.useState(false);
  const [days, setDays] = React.useState<ShareExpiryDays>(NOTES_LIMITS.shareDefaultDays);
  const [creating, setCreating] = React.useState(false);
  const [url, setUrl] = React.useState<string | null>(null);
  const switchId = React.useId();
  const urlId = React.useId();

  const reset = (next: boolean) => {
    if (!next) {
      setUrl(null);
      setIncludeTranscript(false);
      setDays(NOTES_LIMITS.shareDefaultDays);
    }
    onOpenChange(next);
  };

  const create = async () => {
    setCreating(true);
    const res = await notesCall<Omit<CreateShareLinkResponse, 'ok'>>(
      'POST',
      NOTES_API.share(meetingId),
      { includeTranscript, expiresInDays: days },
    );
    setCreating(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setUrl(res.url);
    onCreated(res.link);
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy. Select the link and copy it.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        title="Share these notes"
        description="Anyone with the link can read it until it expires or you revoke it."
      >
        {url ? (
          <div className="space-y-3">
            <label htmlFor={urlId} className="text-sm font-medium">
              The link
            </label>
            <div className="flex gap-2">
              <Input
                id={urlId}
                value={url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                data-share-url=""
                className="font-mono text-xs"
              />
              <Button variant="primary" onClick={() => void copy()}>
                <Copy aria-hidden /> Copy link
              </Button>
            </div>
            <p className="text-xs text-[var(--fg-muted)]">
              Shown once: Kraken keeps only a fingerprint of the link, so copy it now. You can
              revoke it from the Share tab.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-md border border-[var(--border)] p-3">
              <label htmlFor={switchId} className="text-sm">
                <span className="font-medium">Include transcript</span>
                <span className="block text-xs text-[var(--fg-muted)]">
                  Off: the summary and action items only. Names only, never email addresses.
                </span>
              </label>
              <Switch
                id={switchId}
                checked={includeTranscript}
                onCheckedChange={setIncludeTranscript}
              />
            </div>
            <fieldset>
              <legend className="text-sm font-medium">Expires after</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {SHARE_EXPIRY_DAYS.map((d) => (
                  <label
                    key={d}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                      days === d
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border)]',
                    )}
                  >
                    <input
                      type="radio"
                      name="share-expiry"
                      value={d}
                      checked={days === d}
                      onChange={() => setDays(d)}
                      className="size-4 accent-[var(--accent)]"
                    />
                    {d} days
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => reset(false)}>
            {url ? 'Done' : 'Cancel'}
          </Button>
          {url ? null : (
            <Button variant="primary" loading={creating} onClick={() => void create()}>
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
