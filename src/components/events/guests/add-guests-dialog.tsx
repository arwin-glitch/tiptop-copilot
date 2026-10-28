'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { PRESET_TAGS } from '@/lib/events/guest-list';
import { api, plural } from './guest-ui';

/**
 * "Add guests" (D-075): one person by hand, a pasted list of emails, a CRM
 * list (e.g. "Fund I LPs"), or people found in the CRM and Network.
 * Deduplicated on email (an existing guest is linked and tagged instead).
 * Choose the sessions, tags, and Invited or directly Going (comps and VIPs:
 * skips approval and capacity). Nothing is emailed: invitations are
 * campaign drafts from the Messages tab.
 */

type Mode = 'manual' | 'emails' | 'list' | 'search';

interface Person {
  kind: 'record' | 'network';
  id: string;
  name: string;
  email: string | null;
  company: string | null;
}

export function AddGuestsDialog({
  eventId,
  sessions,
  open,
  onOpenChange,
  onAdded,
}: {
  eventId: string;
  sessions: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<Mode>('manual');
  const [manual, setManual] = useState({
    firstName: '',
    lastName: '',
    email: '',
    company: '',
    title: '',
  });
  const [emails, setEmails] = useState('');
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [listId, setListId] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [sessionIds, setSessionIds] = useState<string[]>(sessions.map((s) => s.id));
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<'invited' | 'going'>('invited');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || mode !== 'list' || lists.length) return;
    void api<{ lists: { id: string; name: string }[] }>(
      `/api/events/${eventId}/guests/sources?kind=lists`,
    ).then((r) => {
      if (r.ok && r.data) setLists(r.data.lists);
    });
  }, [open, mode, eventId, lists.length]);

  useEffect(() => {
    if (mode !== 'search' || q.trim().length < 2) return;
    const timer = setTimeout(() => {
      void api<{ people: Person[] }>(
        `/api/events/${eventId}/guests/sources?kind=people&q=${encodeURIComponent(q.trim())}`,
      ).then((r) => {
        if (r.ok && r.data) setFound(r.data.people);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, mode, eventId]);

  async function submit() {
    const common = { sessionIds, tags, status };
    let body: Record<string, unknown>;
    if (mode === 'manual') {
      body = {
        kind: 'manual',
        people: [
          {
            email: manual.email.trim(),
            firstName: manual.firstName.trim() || undefined,
            lastName: manual.lastName.trim() || undefined,
            company: manual.company.trim() || undefined,
            title: manual.title.trim() || undefined,
          },
        ],
        ...common,
      };
    } else if (mode === 'emails') {
      body = { kind: 'emails', text: emails, ...common };
    } else if (mode === 'list') {
      body = { kind: 'list', listId, ...common };
    } else {
      const records = picked.filter((p) => p.kind === 'record').map((p) => p.id);
      const contacts = picked.filter((p) => p.kind === 'network').map((p) => p.id);
      if (records.length && contacts.length) {
        // Two sources: add one after the other.
        setBusy(true);
        const a = await api(`/api/events/${eventId}/guests`, {
          method: 'POST',
          body: { kind: 'records', recordIds: records, ...common },
        });
        const b = await api(`/api/events/${eventId}/guests`, {
          method: 'POST',
          body: { kind: 'network', contactIds: contacts, ...common },
        });
        setBusy(false);
        if (!a.ok || !b.ok)
          toast.error((a.error ?? b.error)?.message ?? 'Some people could not be added.');
        else toast.success(`Added ${plural(picked.length, 'person', 'people')}`);
        onAdded();
        onOpenChange(false);
        return;
      }
      body = records.length
        ? { kind: 'records', recordIds: records, ...common }
        : { kind: 'network', contactIds: contacts, ...common };
    }
    setBusy(true);
    const res = await api<{
      added: number;
      merged: number;
      overCapacity: number;
      skipped: number;
      invalid: string[];
    }>(`/api/events/${eventId}/guests`, { method: 'POST', body });
    setBusy(false);
    if (!res.ok || !res.data) {
      toast.error(res.error?.message ?? 'Those guests could not be added.');
      return;
    }
    const d = res.data;
    const parts = [`Added ${plural(d.added, 'guest')}`];
    if (d.merged) parts.push(`${d.merged} already on the list`);
    if (d.skipped) parts.push(`${d.skipped} without an email skipped`);
    if (d.invalid?.length) parts.push(`${d.invalid.length} not valid`);
    toast.success(parts.join(' · '));
    if (d.overCapacity) toast.warning(`${plural(d.overCapacity, 'seat')} over capacity.`);
    setManual({ firstName: '', lastName: '', email: '', company: '', title: '' });
    setEmails('');
    setPicked([]);
    onAdded();
    onOpenChange(false);
  }

  const canSubmit =
    (mode === 'manual' && /\S+@\S+\.\S+/.test(manual.email)) ||
    (mode === 'emails' && /\S+@\S+/.test(emails)) ||
    (mode === 'list' && Boolean(listId)) ||
    (mode === 'search' && picked.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add guests"
        description="Nothing is emailed. Invitations go out as campaign drafts you review."
      >
        <div className="space-y-4" data-add-guests>
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="How to add">
            {(
              [
                ['manual', 'One person'],
                ['emails', 'Paste emails'],
                ['list', 'A Kraken list'],
                ['search', 'Find people'],
              ] as [Mode, string][]
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={mode === value ? 'primary' : 'secondary'}
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          {mode === 'manual' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" htmlFor="add-email" className="sm:col-span-2">
                <Input
                  id="add-email"
                  type="email"
                  value={manual.email}
                  onChange={(e) => setManual({ ...manual, email: e.target.value })}
                />
              </Field>
              <Field label="First name" htmlFor="add-first">
                <Input
                  id="add-first"
                  value={manual.firstName}
                  onChange={(e) => setManual({ ...manual, firstName: e.target.value })}
                />
              </Field>
              <Field label="Last name" htmlFor="add-last">
                <Input
                  id="add-last"
                  value={manual.lastName}
                  onChange={(e) => setManual({ ...manual, lastName: e.target.value })}
                />
              </Field>
              <Field label="Company" htmlFor="add-company">
                <Input
                  id="add-company"
                  value={manual.company}
                  onChange={(e) => setManual({ ...manual, company: e.target.value })}
                />
              </Field>
              <Field label="Title" htmlFor="add-title">
                <Input
                  id="add-title"
                  value={manual.title}
                  onChange={(e) => setManual({ ...manual, title: e.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {mode === 'emails' ? (
            <Field
              label="Emails"
              htmlFor="add-emails"
              hint="Separated by commas, spaces or new lines. Names can be filled in by guests."
            >
              <Textarea
                id="add-emails"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                rows={6}
              />
            </Field>
          ) : null}

          {mode === 'list' ? (
            <Field
              label="List"
              htmlFor="add-list"
              hint="People on the list with an email are added and linked to their record."
            >
              <Select id="add-list" value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Choose a list…</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {mode === 'search' ? (
            <div className="space-y-2">
              <Field label="Search the CRM and Network" htmlFor="add-search">
                <Input
                  id="add-search"
                  value={q}
                  placeholder="Name, email or company"
                  onChange={(e) => setQ(e.target.value)}
                />
              </Field>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {found.map((p) => {
                  const on = picked.some((x) => x.id === p.id);
                  return (
                    <li key={`${p.kind}-${p.id}`}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setPicked(on ? picked.filter((x) => x.id !== p.id) : [...picked, p])
                          }
                        />
                        <span>
                          {p.name} <span className="text-[var(--fg-muted)]">{p.email}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {picked.length ? (
                <p className="text-xs text-[var(--fg-muted)]">
                  {plural(picked.length, 'person', 'people')} chosen
                </p>
              ) : null}
            </div>
          ) : null}

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Sessions</legend>
            <div className="flex flex-wrap gap-3">
              {sessions.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={sessionIds.includes(s.id)}
                    onChange={() =>
                      setSessionIds(
                        sessionIds.includes(s.id)
                          ? sessionIds.filter((x) => x !== s.id)
                          : [...sessionIds, s.id],
                      )
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Tags</legend>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_TAGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tags.includes(t)}
                  className={`rounded-full border px-2 py-0.5 text-xs ${tags.includes(t) ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)]'}`}
                  onClick={() =>
                    setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          </fieldset>

          <Field
            label="Add them as"
            htmlFor="add-status"
            hint={
              status === 'going' ? 'Skips approval and capacity: for comps and VIPs.' : undefined
            }
          >
            <Select
              id="add-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'invited' | 'going')}
            >
              <option value="invited">Invited (they RSVP from their link)</option>
              <option value="going">Going, directly</option>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSubmit || busy || !sessionIds.length}
            loading={busy}
            onClick={submit}
          >
            Add guests
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
