'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { matchNeverRecord } from '@/lib/notes/never-record';
import { NOTES_API } from '@/lib/notes/api';
import {
  NEVER_RECORD_MESSAGE,
  type AttendeeInput,
  type CreateMeetingRequest,
  type CreateMeetingResponse,
  type MeetingKind,
  type TemplateView,
} from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { notesCall } from './api-client';
import { TemplatePicker } from './template-picker';

export interface NewNotePrefill {
  source: 'calendar' | 'adhoc';
  providerEventId: string | null;
  recurringEventId: string | null;
  calendarId: string | null;
  title: string;
  kind: MeetingKind;
  platform: CreateMeetingRequest['platform'];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  attendees: AttendeeInput[];
}

/**
 * "+ New note" for an unscheduled call, and the landing of "Start notes" from
 * a meeting alert (prefilled from the calendar event). Making the note opens
 * the meeting page with the consent step; nothing records from here.
 */
export function NewNoteForm({
  prefill,
  templates,
}: {
  prefill: NewNotePrefill;
  templates: readonly TemplateView[];
}) {
  const router = useRouter();
  const [title, setTitle] = React.useState(prefill.title);
  const [kind, setKind] = React.useState<MeetingKind>(prefill.kind);
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const [guests, setGuests] = React.useState<AttendeeInput[]>(prefill.attendees);
  const [guestName, setGuestName] = React.useState('');
  const [guestEmail, setGuestEmail] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const titleId = React.useId();
  const kindId = React.useId();
  const nameId = React.useId();
  const emailId = React.useId();

  // The defaults (legal, family) shown before anyone presses anything; the
  // server checks again with the team's own rules.
  const blocked = matchNeverRecord(
    { title, calendarId: prefill.calendarId, attendeeEmails: guests.map((g) => g.email) },
    [],
  );

  const addGuest = () => {
    const name = guestName.trim();
    const email = guestEmail.trim().toLowerCase();
    if (!name && !email) return;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('That address does not look right.');
      return;
    }
    setGuests((g) => [...g, { name: name || null, email: email || null }]);
    setGuestName('');
    setGuestEmail('');
  };

  const create = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const body: CreateMeetingRequest = {
      source: prefill.source,
      providerEventId: prefill.providerEventId,
      recurringEventId: prefill.recurringEventId,
      calendarId: prefill.calendarId,
      title: title.trim(),
      kind,
      platform: prefill.platform,
      scheduledStart: prefill.scheduledStart,
      scheduledEnd: prefill.scheduledEnd,
      attendees: guests,
      templateId,
    };
    const res = await notesCall<Omit<CreateMeetingResponse, 'ok'>>(
      'POST',
      NOTES_API.meetings,
      body,
    );
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    router.push(`/meetings/${encodeURIComponent(res.meeting.id)}?start=1`);
  };

  return (
    <form
      className="max-w-xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div>
        <label htmlFor={titleId} className="text-sm font-medium">
          What is the meeting?
        </label>
        <Input
          id={titleId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Call with Dana from Acme Robotics"
          className="mt-1"
          required
          maxLength={300}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={kindId} className="text-sm font-medium">
            Where
          </label>
          <Select
            id={kindId}
            value={kind}
            onChange={(e) => setKind(e.target.value as MeetingKind)}
            className="mt-1"
          >
            <option value="video">A video call</option>
            <option value="phone">A phone call</option>
            <option value="in_person">In person</option>
            <option value="adhoc">Something else</option>
          </Select>
        </div>
        <TemplatePicker
          templates={templates}
          value={templateId}
          onChange={setTemplateId}
          className="flex-col items-start gap-1 [&_label]:text-sm [&_label]:text-[var(--fg)] [&_select]:h-9 [&_select]:w-full"
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Who is in it</legend>
        <p className="text-xs text-[var(--fg-muted)]">
          Guests are offered first when you name a voice. You are added automatically.
        </p>
        {guests.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {guests.map((g, i) => (
              <li
                key={`${g.email ?? ''}-${g.name ?? ''}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-soft)] py-0.5 pr-1 pl-2.5 text-xs"
              >
                {g.name ?? g.email}
                <button
                  type="button"
                  onClick={() => setGuests((all) => all.filter((_, j) => j !== i))}
                  aria-label={`Remove ${g.name ?? g.email}`}
                  className="rounded-full p-0.5 hover:bg-[var(--bg-hover)]"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={nameId} className="text-xs text-[var(--fg-muted)]">
              Name
            </label>
            <Input id={nameId} value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor={emailId} className="text-xs text-[var(--fg-muted)]">
              Email (optional)
            </label>
            <Input
              id={emailId}
              type="email"
              value={guestEmail}
              onChange={(e) => setGuestEmail(e.target.value)}
            />
          </div>
          <Button type="button" variant="secondary" onClick={addGuest}>
            <Plus aria-hidden /> Add
          </Button>
        </div>
      </fieldset>

      {blocked ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {NEVER_RECORD_MESSAGE} ({blocked.label}: {blocked.reason})
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!title.trim()}>
          Open notes
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
