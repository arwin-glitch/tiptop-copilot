'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { AtSign, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { formatCopyList, parseCopyAddresses } from '@/lib/campaigns/copies';
import type { CampaignPhotoView } from '@/lib/campaigns/photos';
import type { CampaignBccMode } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { campaignCall, jsonBody } from './campaign-api';
import { CampaignCopies } from './campaign-copies';
import { PhotoSet } from './photo-set';

/**
 * Photos and copies as the composer gets them from the page; null on the
 * page while their migration is not applied, which hides them entirely.
 */
export interface ComposerExtras {
  photos: CampaignPhotoView[];
  copies: { cc: string[]; bcc: string[]; bccMode: CampaignBccMode };
  /** Bytes the shared attachments put on every email. */
  sharedBytes: number;
}

/** A recipient row as the extras read it. */
interface ExtrasRecipient {
  id: string;
  email: string;
  name: string | null;
  photoId?: string | null;
  cc?: string[];
}

/** Under the recipient list: the photo set, then the campaign's CC and BCC. */
export function RecipientsExtrasPanel({
  campaignId,
  extras,
  recipients,
  onChange,
  onBusy,
}: {
  campaignId: string;
  extras: ComposerExtras;
  recipients: ExtrasRecipient[];
  onChange: () => void;
  onBusy: (what: string | null) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PhotoSet
        campaignId={campaignId}
        photos={extras.photos}
        recipients={recipients.map((r) => ({
          id: r.id,
          label: r.name ?? r.email,
          photoId: r.photoId ?? null,
        }))}
        sharedBytes={extras.sharedBytes}
        onChange={onChange}
        onBusy={onBusy}
      />
      <CampaignCopies
        campaignId={campaignId}
        copies={extras.copies}
        recipientCount={recipients.length}
        onChange={onChange}
        onBusy={onBusy}
      />
    </div>
  );
}

/**
 * One recipient row's photo and own CC: what their email carries besides the
 * campaign's, with a picker to set, change or clear each. Compact on the row;
 * the picker opens under it. Each change is saved at once (and makes any
 * earlier review stale).
 */
export function RecipientExtras({
  campaignId,
  recipient: row,
  photos,
  disabled,
  onChange,
  onBusy,
}: {
  campaignId: string;
  recipient: ExtrasRecipient;
  /** The campaign's photo set. */
  photos: CampaignPhotoView[];
  disabled: boolean;
  onChange: () => void;
  onBusy: (what: string | null) => void;
}) {
  const recipient = {
    id: row.id,
    email: row.email,
    label: row.name ?? row.email,
    photoId: row.photoId ?? null,
    cc: row.cc ?? [],
  };
  const [open, setOpen] = React.useState<'photo' | 'cc' | null>(null);
  const [ccText, setCcText] = React.useState(formatCopyList(recipient.cc));
  const [ccError, setCcError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const photo = recipient.photoId ? photos.find((p) => p.id === recipient.photoId) : null;
  const photoState = recipient.photoId ? (photo ? photo.name : 'Photo missing') : 'No photo';
  const missing = Boolean(recipient.photoId && !photo);

  const run = async (url: string, body: unknown): Promise<boolean> => {
    setSaving(true);
    onBusy('the recipient change');
    const r = await campaignCall(url, jsonBody('PATCH', body));
    setSaving(false);
    onBusy(null);
    if (!r.ok) {
      toast.error(r.message);
      return false;
    }
    onChange();
    return true;
  };

  const choosePhoto = async (photoId: string | null) => {
    if (photoId === (recipient.photoId ?? null)) return;
    if (await run(`/api/campaigns/${campaignId}/photos`, { recipientId: recipient.id, photoId })) {
      setOpen(null);
    }
  };

  const saveCc = async () => {
    const parsed = parseCopyAddresses(ccText);
    if (!parsed.ok) {
      setCcError(parsed.message);
      return;
    }
    if (parsed.emails.includes(recipient.email.toLowerCase())) {
      setCcError(`${recipient.email} already gets this email.`);
      return;
    }
    setCcError(null);
    if (
      await run(`/api/campaigns/${campaignId}/copies`, { recipientId: recipient.id, cc: ccText })
    ) {
      setCcText(formatCopyList(parsed.emails));
      setOpen(null);
    }
  };

  const toggle = (which: 'photo' | 'cc') => {
    setOpen((cur) => (cur === which ? null : which));
    if (which === 'cc') {
      setCcText(formatCopyList(recipient.cc));
      setCcError(null);
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Photo for ${recipient.label}: ${photoState}`}
          aria-expanded={open === 'photo'}
          disabled={disabled || saving}
          onClick={() => toggle('photo')}
          className={cn(
            'max-w-44 px-2 text-xs',
            missing ? 'text-[var(--warn)]' : photo ? 'text-[var(--fg)]' : 'text-[var(--fg-subtle)]',
          )}
        >
          <ImageIcon aria-hidden="true" />
          <span className="truncate">{photoState}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`CC for ${recipient.label}: ${recipient.cc.length ? recipient.cc.join(', ') : 'none'}`}
          aria-expanded={open === 'cc'}
          disabled={disabled || saving}
          onClick={() => toggle('cc')}
          className={cn(
            'max-w-44 px-2 text-xs',
            recipient.cc.length ? 'text-[var(--fg)]' : 'text-[var(--fg-subtle)]',
          )}
        >
          <AtSign aria-hidden="true" />
          <span className="truncate">
            {recipient.cc.length ? `CC ${recipient.cc.join(', ')}` : 'CC'}
          </span>
        </Button>
      </div>
      {open === 'photo' ? (
        <div className="order-last flex basis-full flex-wrap items-center gap-2 pb-1">
          <Select
            aria-label={`Choose the photo for ${recipient.label}`}
            value={photo ? photo.id : ''}
            disabled={saving}
            onChange={(e) => void choosePhoto(e.target.value || null)}
            className="h-8 w-auto max-w-72 text-xs"
          >
            <option value="">No photo</option>
            {photos.map((p) => {
              const others = p.recipients.filter((h) => h.id !== recipient.id).length;
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {others ? ` (also for ${others} other${others === 1 ? '' : 's'})` : ''}
                </option>
              );
            })}
          </Select>
          {!photos.length ? (
            <span className="text-xs text-[var(--fg-muted)]">
              Add photos below first, then pick one here.
            </span>
          ) : null}
        </div>
      ) : null}
      {open === 'cc' ? (
        <div className="order-last basis-full space-y-1 pb-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`CC addresses for ${recipient.label}`}
              value={ccText}
              placeholder="assistant@firm.example"
              aria-invalid={ccError ? true : undefined}
              disabled={saving}
              onChange={(e) => {
                setCcText(e.target.value);
                if (ccError) setCcError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveCc();
                }
                if (e.key === 'Escape') setOpen(null);
              }}
              className="h-8 max-w-80 min-w-0 flex-1 text-xs"
            />
            <Button size="sm" variant="secondary" loading={saving} onClick={() => void saveCc()}>
              Save CC
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
          <p
            className={cn('text-xs', ccError ? 'text-[var(--warn)]' : 'text-[var(--fg-muted)]')}
            aria-live="polite"
          >
            {ccError ?? 'Copied on this person’s email only, with the campaign’s own CC.'}
          </p>
        </div>
      ) : null}
    </>
  );
}
