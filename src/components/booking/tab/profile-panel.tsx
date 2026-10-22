'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Label, Textarea } from '@/components/ui/form';
import type { BookingConfig, PhotoRef } from '@/lib/booking/config';
import { videoProviderLabel } from '@/lib/booking/public';
import { cn } from '@/lib/util/cn';
import { SaveBar } from './availability-panel';
import { Row, TextField } from './fields';
import { useSettingsSave } from './hooks';

type ProfileFields = Pick<BookingConfig, 'displayName' | 'title' | 'bio' | 'firmName' | 'callLink'>;

export interface ProfilePanelProps {
  profile: ProfileFields;
  photo: PhotoRef | null;
  canEdit: boolean;
}

/**
 * Profile: the card the public page shows (name, title, firm, a short bio
 * and the photo) and the video link for calls, moved from Settings >
 * Booking link unchanged. The photo saves on upload, checked by its own
 * bytes; the rest has a Save. The video link goes only into the invite:
 * the page says which kind of call it is, never the link.
 */
export function ProfilePanel(props: ProfilePanelProps) {
  const router = useRouter();
  const { save, saving, problem } = useSettingsSave();
  const [profile, setProfile] = React.useState<ProfileFields>(props.profile);
  const [photo, setPhoto] = React.useState<PhotoRef | null>(props.photo);
  const [dirty, setDirty] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const uid = React.useId();
  const disabled = !props.canEdit || saving;

  const set = <K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) => {
    setProfile((p) => ({ ...p, [key]: value }));
    setDirty(true);
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    const body = new FormData();
    body.append('photo', file);
    const res = await fetch('/api/booking/photo', { method: 'POST', body }).catch(() => null);
    setUploading(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      settings?: { config: BookingConfig };
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok || !json.settings) {
      toast.error(json?.error?.message ?? 'The photo did not upload.');
      return;
    }
    setPhoto(json.settings.config.photo);
    toast.success('Photo saved');
    router.refresh();
  };

  const removePhoto = async () => {
    const res = await fetch('/api/booking/photo', { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      toast.error('The photo was not removed.');
      return;
    }
    setPhoto(null);
    toast.success('Photo removed');
    router.refresh();
  };

  return (
    <div className="space-y-5" data-tour="booking-profile">
      {!props.canEdit ? (
        <Notice>Only an admin or the owner can change the booking link.</Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${uid}-name`}
          label="Name shown"
          value={profile.displayName}
          max={80}
          disabled={disabled}
          onChange={(v) => set('displayName', v)}
        />
        <TextField
          id={`${uid}-title`}
          label="Title"
          value={profile.title}
          max={120}
          disabled={disabled}
          onChange={(v) => set('title', v)}
        />
        <TextField
          id={`${uid}-firm`}
          label="Firm"
          value={profile.firmName}
          max={80}
          disabled={disabled}
          onChange={(v) => set('firmName', v)}
        />
      </div>
      <TextField
        id={`${uid}-call-link`}
        label="Video link for calls"
        hint={`Goes in every call invite instead of a Google Meet link. Only people who book see it. Calls show as: ${videoProviderLabel(profile.callLink)}.`}
        value={profile.callLink}
        max={500}
        type="url"
        placeholder="https://"
        disabled={disabled}
        onChange={(v) => set('callLink', v)}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-bio`}>Short bio</Label>
        <Textarea
          id={`${uid}-bio`}
          value={profile.bio}
          maxLength={600}
          disabled={disabled}
          onChange={(e) => set('bio', e.target.value)}
        />
        <p className="text-xs text-[var(--fg-muted)]">{profile.bio.length}/600</p>
      </div>
      <Row
        title="Photo"
        body={
          photo
            ? 'Shown on the page. JPG, PNG or WebP under 3 MB.'
            : 'None yet: the page shows initials. JPG, PNG or WebP under 3 MB.'
        }
        lead={
          photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by this app's own signed-in route
            <img
              src={`/api/booking/photo?v=${encodeURIComponent(photo.version)}`}
              alt="The photo on the booking page"
              width={48}
              height={48}
              className="size-12 shrink-0 rounded-full border-2 border-[var(--gold)] object-cover"
            />
          ) : null
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <label
              className={cn(
                'cursor-pointer',
                (!props.canEdit || uploading) && 'pointer-events-none opacity-50',
              )}
            >
              <Upload aria-hidden="true" />
              {uploading ? 'Uploading…' : photo ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={!props.canEdit || uploading}
                onChange={(e) => {
                  void upload(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </label>
          </Button>
          {photo ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!props.canEdit}
              onClick={() => void removePhoto()}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </Row>
      <SaveBar
        dirty={dirty}
        saving={saving}
        disabled={disabled}
        problem={problem}
        label="Save profile"
        onSave={async () => {
          const saved = await save({ config: profile }, 'Profile saved');
          if (saved) setDirty(false);
        }}
      />
    </div>
  );
}
