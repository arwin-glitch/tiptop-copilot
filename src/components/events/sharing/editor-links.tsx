'use client';

import * as React from 'react';
import { Ban, Copy, Mail, Pause, Play, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { GRANT_DEFAULT_EXPIRY_DAYS, GRANT_EXPIRY_DAYS } from '@/lib/events/contracts';
import { studioFetch } from '@/lib/events/editor/api';
import type { EventEditorRole, EventEditorScope } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';

/** A link as the server lists it (lib/services/event-editors.ts EditorLinkSummary). */
export interface LinkRow {
  id: string;
  label: string;
  email: string | null;
  role: EventEditorRole;
  scope: EventEditorScope;
  hint: string;
  status: 'active' | 'unused' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstClaimedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

type ExpiryValue = `${number}` | 'event';

const STATUS_TONE: Record<LinkRow['status'], 'ok' | 'neutral' | 'warn' | 'danger'> = {
  active: 'ok',
  unused: 'neutral',
  expired: 'warn',
  revoked: 'danger',
};

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

function scopeText(link: LinkRow, sections: { id: string; label: string }[]): string {
  if (link.role === 'viewer') return 'Preview only';
  if (link.role === 'checkin') return 'Door list';
  const what = [link.scope.design && 'design', link.scope.content && 'content']
    .filter(Boolean)
    .join(' + ');
  const where =
    link.scope.sections === 'all'
      ? 'all sections'
      : sections
          .filter((s) => (link.scope.sections as string[]).includes(s.id))
          .map((s) => s.label)
          .join(', ') || 'chosen sections';
  return `${what} · ${where}${link.scope.brand_locked ? ' · brand locked' : ''}`;
}

/**
 * Outside links for one event: editors and viewers ("editors" group) or
 * check-in staff ("staff"). Invite (the link is shown once), extend, edit
 * scope, regenerate, revoke, pause editing and revoke all. Nothing is sent
 * from here: "Draft an email" opens a draft in your own mail app.
 */
export function EditorLinks({
  group,
  eventId,
  eventTitle,
  initialLinks,
  sections,
  editingPaused,
  hasEventDate,
  canManage,
}: {
  group: 'editors' | 'staff';
  eventId: string;
  eventTitle: string;
  initialLinks: LinkRow[];
  sections: { id: string; label: string }[];
  editingPaused: boolean;
  hasEventDate: boolean;
  canManage: boolean;
}) {
  const [links, setLinks] = React.useState<LinkRow[]>(initialLinks);
  const [paused, setPaused] = React.useState(editingPaused);
  const [form, setForm] = React.useState<
    { mode: 'create' } | { mode: 'edit'; link: LinkRow } | null
  >(null);
  const [issued, setIssued] = React.useState<{ link: LinkRow; url: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const base = `/api/events/${eventId}/editors`;
  const roles: EventEditorRole[] = group === 'staff' ? ['checkin'] : ['editor', 'viewer'];
  const live = links.filter((l) => l.status === 'active' || l.status === 'unused');

  const upsert = (row: LinkRow) =>
    setLinks((list) =>
      list.some((l) => l.id === row.id)
        ? list.map((l) => (l.id === row.id ? row : l))
        : [row, ...list],
    );

  async function regenerate(link: LinkRow) {
    const yes = await confirm({
      title: `Regenerate ${link.label}'s link?`,
      description:
        'The old link stops working at once and any open session ends. You get a new link to send.',
      confirmLabel: 'Regenerate',
    });
    if (!yes) return;
    const r = await studioFetch<{ link: LinkRow; path: string }>(`${base}/${link.id}/regenerate`, {
      method: 'POST',
      json: {},
    });
    if (!r.ok) return toast.error(r.error.message);
    upsert(r.value.link);
    setIssued({ link: r.value.link, url: `${window.location.origin}${r.value.path}` });
  }

  async function revoke(link: LinkRow) {
    const yes = await confirm({
      title: `Revoke ${link.label}'s link?`,
      description: 'It stops working at once; an open editor sees that the link ended.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!yes) return;
    const r = await studioFetch<{ link: LinkRow }>(`${base}?link=${encodeURIComponent(link.id)}`, {
      method: 'DELETE',
    });
    if (!r.ok) return toast.error(r.error.message);
    upsert(r.value.link);
    toast.success('Link revoked.');
  }

  async function revokeAll() {
    const yes = await confirm({
      title:
        group === 'staff' ? 'Revoke every staff link?' : 'Revoke every editor and viewer link?',
      description: 'Every one stops working now. You can make new links afterwards.',
      confirmLabel: 'Revoke all',
      tone: 'danger',
    });
    if (!yes) return;
    const r = await studioFetch<{ revoked: number }>(`${base}/revoke-all`, {
      method: 'POST',
      json: { roles },
    });
    if (!r.ok) return toast.error(r.error.message);
    const now = new Date().toISOString();
    setLinks((list) =>
      list.map((l) =>
        roles.includes(l.role) && (l.status === 'active' || l.status === 'unused')
          ? { ...l, status: 'revoked', revokedAt: now }
          : l,
      ),
    );
    toast.success(`${r.value.revoked} link${r.value.revoked === 1 ? '' : 's'} revoked.`);
  }

  async function togglePause(next: boolean) {
    const r = await studioFetch<{ editingPaused: boolean }>(`${base}/pause`, {
      method: 'POST',
      json: { paused: next },
    });
    if (!r.ok) return toast.error(r.error.message);
    setPaused(r.value.editingPaused);
    toast.success(
      r.value.editingPaused
        ? 'Editing paused for outside editors.'
        : 'Outside editors can edit again.',
    );
  }

  return (
    <div className="space-y-3">
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'create' })}>
            <Plus aria-hidden="true" />
            {group === 'staff' ? 'Add a staff link' : 'Invite an editor'}
          </Button>
          {group === 'editors' ? (
            <Button variant="secondary" size="sm" onClick={() => void togglePause(!paused)}>
              {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {paused ? 'Resume editing' : 'Pause editing'}
            </Button>
          ) : null}
          {live.length ? (
            <Button variant="ghost" size="sm" onClick={() => void revokeAll()}>
              <Ban aria-hidden="true" />
              Revoke all
            </Button>
          ) : null}
        </div>
      ) : null}
      {group === 'editors' && paused ? (
        <p role="status" className="rounded-md bg-[var(--warn-soft)] px-3 py-2 text-sm">
          Editing is paused: outside editors can look but not change anything.
        </p>
      ) : null}
      {links.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">
          {group === 'staff'
            ? 'No staff links yet.'
            : 'No outside links yet. Each person gets their own.'}
        </p>
      ) : (
        <ul
          aria-label={group === 'staff' ? 'Staff links' : 'Editor links'}
          className="divide-y divide-[var(--border)]"
        >
          {links.map((link) => (
            <li
              key={link.id}
              className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5"
              data-link-id={link.id}
            >
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {link.label}
                  <Badge tone={STATUS_TONE[link.status]}>{link.status}</Badge>
                  <span className="text-xs font-normal text-[var(--fg-muted)]">
                    {link.role === 'editor'
                      ? 'Editor'
                      : link.role === 'viewer'
                        ? 'Viewer'
                        : 'Check-in'}{' '}
                    · ends …{link.hint}
                  </span>
                </p>
                <p className="text-xs text-[var(--fg-muted)]">{scopeText(link, sections)}</p>
                <p className="text-xs text-[var(--fg-muted)]">
                  First used {date(link.firstClaimedAt)} · last {date(link.lastUsedAt)} ·{' '}
                  {link.useCount} {link.useCount === 1 ? 'open' : 'opens'} ·{' '}
                  {link.status === 'expired' ? 'expired' : 'expires'} {date(link.expiresAt)}
                </p>
              </div>
              {canManage && link.status !== 'revoked' ? (
                <div className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setForm({ mode: 'edit', link })}>
                    {link.status === 'expired' ? 'Extend' : 'Edit'}
                  </Button>
                  {link.status !== 'expired' ? (
                    <Button size="sm" variant="ghost" onClick={() => void regenerate(link)}>
                      <RefreshCw aria-hidden="true" />
                      Regenerate
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void revoke(link)}>
                    Revoke
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {form ? (
        <LinkForm
          key={form.mode === 'edit' ? form.link.id : 'new'}
          group={group}
          base={base}
          sections={sections}
          hasEventDate={hasEventDate}
          editing={form.mode === 'edit' ? form.link : null}
          onClose={() => setForm(null)}
          onSaved={(row, path) => {
            upsert(row);
            setForm(null);
            if (path) setIssued({ link: row, url: `${window.location.origin}${path}` });
            else toast.success('Link updated.');
          }}
        />
      ) : null}
      {issued ? (
        <IssuedLink issued={issued} eventTitle={eventTitle} onClose={() => setIssued(null)} />
      ) : null}
      {confirmDialog}
    </div>
  );
}

function LinkForm({
  group,
  base,
  sections,
  hasEventDate,
  editing,
  onClose,
  onSaved,
}: {
  group: 'editors' | 'staff';
  base: string;
  sections: { id: string; label: string }[];
  hasEventDate: boolean;
  editing: LinkRow | null;
  onClose: () => void;
  onSaved: (row: LinkRow, path: string | null) => void;
}) {
  const [label, setLabel] = React.useState(editing?.label ?? '');
  const [email, setEmail] = React.useState(editing?.email ?? '');
  const [role, setRole] = React.useState<EventEditorRole>(
    editing?.role ?? (group === 'staff' ? 'checkin' : 'editor'),
  );
  const [design, setDesign] = React.useState(editing?.scope.design ?? false);
  const [content, setContent] = React.useState(editing?.scope.content ?? true);
  const [allSections, setAllSections] = React.useState(
    editing ? editing.scope.sections === 'all' : true,
  );
  const [chosen, setChosen] = React.useState<string[]>(
    editing && editing.scope.sections !== 'all' ? editing.scope.sections : [],
  );
  const [brandLocked, setBrandLocked] = React.useState(editing?.scope.brand_locked ?? true);
  const [expiry, setExpiry] = React.useState<ExpiryValue | ''>(
    editing ? '' : `${GRANT_DEFAULT_EXPIRY_DAYS}`,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const scope =
      role === 'editor'
        ? {
            design,
            content,
            sections: allSections ? ('all' as const) : chosen,
            brand_locked: brandLocked,
          }
        : undefined;
    const expiryBody =
      expiry === ''
        ? undefined
        : expiry === 'event'
          ? { eventEnd: true as const }
          : { days: Number(expiry) };
    const r = editing
      ? await studioFetch<{ link: LinkRow }>(base, {
          method: 'PATCH',
          json: { id: editing.id, label, email: email || null, scope, expiry: expiryBody },
        })
      : await studioFetch<{ link: LinkRow; path: string }>(base, {
          method: 'POST',
          json: { label, email: email || null, role, scope, expiry: expiryBody },
        });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    onSaved(r.value.link, 'path' in r.value ? (r.value as { path: string }).path : null);
  }

  const title = editing
    ? editing.status === 'expired'
      ? `Extend ${editing.label}'s link`
      : `Edit ${editing.label}'s link`
    : group === 'staff'
      ? 'Add a staff link'
      : 'Invite an editor';

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        title={title}
        description="One link per person. It is shown once, then only its last four characters."
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="Who it is for"
            htmlFor="link-label"
            hint='Like "Morgan – Example Partners".'
          >
            <Input
              id="link-label"
              value={label}
              maxLength={80}
              required
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label="Email (optional, kept as a note only)" htmlFor="link-email">
            <Input
              id="link-email"
              type="email"
              value={email}
              maxLength={320}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {group === 'editors' && !editing ? (
            <Field label="Role" htmlFor="link-role">
              <Select
                id="link-role"
                value={role}
                onChange={(e) => setRole(e.target.value as EventEditorRole)}
              >
                <option value="editor">Editor: changes the draft within a scope</option>
                <option value="viewer">Viewer: previews the draft only</option>
              </Select>
            </Field>
          ) : null}
          {role === 'editor' ? (
            <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-sm font-medium">What they may change</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={content}
                  onChange={(e) => setContent(e.target.checked)}
                />
                Content: words, photos and list items
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={design}
                  onChange={(e) => setDesign(e.target.checked)}
                />
                Design: layouts, theme and effects
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="link-sections"
                  checked={allSections}
                  onChange={() => setAllSections(true)}
                />
                Every section (and may add, reorder and remove sections)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="link-sections"
                  checked={!allSections}
                  onChange={() => setAllSections(false)}
                />
                Only these sections
              </label>
              {!allSections ? (
                <ul
                  className="grid gap-1 pl-6 sm:grid-cols-2"
                  aria-label="Sections they may change"
                >
                  {sections.map((s) => (
                    <li key={s.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={chosen.includes(s.id)}
                          onChange={(e) =>
                            setChosen((list) =>
                              e.target.checked ? [...list, s.id] : list.filter((id) => id !== s.id),
                            )
                          }
                        />
                        {s.label}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Brand lock: TipTop&apos;s logo, colours, fonts and intro stay locked</span>
                <Switch
                  checked={brandLocked}
                  onCheckedChange={setBrandLocked}
                  aria-label="Brand lock"
                />
              </label>
            </fieldset>
          ) : null}
          <Field label={editing ? 'New expiry (optional)' : 'Expires'} htmlFor="link-expiry">
            <Select
              id="link-expiry"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as ExpiryValue | '')}
            >
              {editing ? <option value="">Keep {date(editing.expiresAt)}</option> : null}
              {GRANT_EXPIRY_DAYS.map((d) => (
                <option key={d} value={`${d}`}>
                  In {d} days
                </option>
              ))}
              {hasEventDate ? <option value="event">Two days after the event ends</option> : null}
            </Select>
          </Field>
          {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!label.trim()}>
              {editing ? 'Save' : 'Make the link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IssuedLink({
  issued,
  eventTitle,
  onClose,
}: {
  issued: { link: LinkRow; url: string };
  eventTitle: string;
  onClose: () => void;
}) {
  const { link, url } = issued;
  const first = link.label.split(/[\s–—-]+/)[0] || 'there';
  const staff = link.role === 'checkin';
  const subject = staff
    ? `Check-in for ${eventTitle}`
    : `Your link to ${link.role === 'viewer' ? 'preview' : 'edit'} the ${eventTitle} page`;
  const body = [
    `Hi ${first},`,
    '',
    staff
      ? `Here is your personal check-in link for ${eventTitle}:`
      : `Here is your personal link to ${link.role === 'viewer' ? 'preview' : 'edit'} the ${eventTitle} event page:`,
    url,
    '',
    `It works until ${date(link.expiresAt)}.${staff ? '' : ' Changes go live only when TipTop publishes.'} Please don't forward it: it is just for you.`,
  ].join('\n');
  const mailto = `mailto:${link.email ? encodeURIComponent(link.email) : ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        title={`${link.label}'s link`}
        description="Shown once. Copy it now: afterwards only its last four characters are kept."
      >
        <label className="sr-only" htmlFor="issued-link">
          The link
        </label>
        <Input
          id="issued-link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <div className={cn('mt-3 flex flex-wrap gap-2')}>
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(
                () => toast.success('Link copied.'),
                () => toast.error('Copy did not work. Select the link and copy it.'),
              );
            }}
          >
            <Copy aria-hidden="true" />
            Copy link
          </Button>
          <Button variant="secondary" asChild>
            <a href={mailto}>
              <Mail aria-hidden="true" />
              Draft an email{link.email ? ` to ${first}` : ''}
            </a>
          </Button>
        </div>
        <p className="mt-3 text-xs text-[var(--fg-muted)]">
          “Draft an email” opens a draft in your own mail app. Nothing is sent from Copilot.
        </p>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
