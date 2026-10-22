'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { useConfirm } from '@/components/ui/confirm';
import { PRESET_TAGS, type GuestListItem } from '@/lib/events/guest-list';
import { answerText, type RegistrationQuestion } from '@/lib/events/questions';
import type { GuestDetail } from '@/lib/services/event-guests';
import { api, shortStamp, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE } from './guest-ui';

/**
 * The guest drawer (D-075): contact details (linked to the CRM record),
 * status per session with the decision note and actions, answers, plus-ones,
 * host-only note and tags, the timeline, and "Copy personal link" / rotate.
 */

interface SessionLite {
  id: string;
  name: string;
}

export function GuestDrawer({
  eventId,
  guestId,
  sessions,
  questions,
  timeZone,
  onClose,
  onChanged,
}: {
  eventId: string;
  guestId: string | null;
  sessions: SessionLite[];
  questions: RegistrationQuestion[];
  timeZone: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<GuestDetail | null>(null);
  const [form, setForm] = useState<Partial<GuestListItem>>({});
  const [note, setNote] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const apply = useCallback((res: Awaited<ReturnType<typeof api<{ detail: GuestDetail }>>>) => {
    if (res.ok && res.data) {
      setDetail(res.data.detail);
      setForm(res.data.detail.guest);
      setNote(res.data.detail.guest.note ?? '');
    } else {
      toast.error(res.error?.message ?? 'That guest could not be loaded.');
    }
  }, []);

  const load = useCallback(async () => {
    if (!guestId) return;
    apply(await api<{ detail: GuestDetail }>(`/api/events/${eventId}/guests/${guestId}`));
  }, [eventId, guestId, apply]);

  // The manager keys this component by guest, so a new guest starts empty.
  useEffect(() => {
    if (!guestId) return;
    let cancelled = false;
    api<{ detail: GuestDetail }>(`/api/events/${eventId}/guests/${guestId}`).then((res) => {
      if (!cancelled) apply(res);
    });
    return () => {
      cancelled = true;
    };
  }, [eventId, guestId, apply]);

  const guest = detail?.guest ?? null;

  async function save(patch: Record<string, unknown>, message = 'Saved') {
    if (!guest) return;
    setBusy(true);
    const res = await api(`/api/events/${eventId}/guests/${guest.id}`, {
      method: 'PATCH',
      body: patch,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error?.message ?? 'That could not be saved.');
      return;
    }
    toast.success(message);
    await load();
    onChanged();
  }

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    if (!guest) return;
    setBusy(true);
    const res = await api<{ changed: number; full: number; promoted: number }>(
      `/api/events/${eventId}/guests`,
      {
        method: 'PATCH',
        body: { action, guestIds: [guest.id], ...extra },
      },
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error?.message ?? 'That did not work.');
      return;
    }
    if (res.data?.full) toast.warning('No room left in that session. Nothing changed.');
    else toast.success('Updated');
    await load();
    onChanged();
  }

  async function checkin(sessionId: string, undo: boolean) {
    if (!guest) return;
    setBusy(true);
    const res = await api<{ result: { state: string } }>(`/api/events/${eventId}/checkin`, {
      method: 'POST',
      body: { action: undo ? 'undo' : 'checkin', guestId: guest.id, sessionId },
    });
    setBusy(false);
    if (!res.ok) toast.error(res.error?.message ?? 'That did not work.');
    else toast.success(undo ? 'Check-in undone' : 'Checked in');
    await load();
    onChanged();
  }

  async function copyLink() {
    if (!guest) return;
    const res = await api<{ invite: string | null }>(
      `/api/events/${eventId}/guests/${guest.id}/link`,
    );
    if (!res.ok || !res.data?.invite) {
      toast.error(res.error?.message ?? 'No personal link for this guest.');
      return;
    }
    try {
      await navigator.clipboard.writeText(res.data.invite);
      toast.success('Personal link copied. It is this guest’s key: share it only with them.');
    } catch {
      toast.error('Could not copy. Your browser blocked the clipboard.');
    }
  }

  const answered = questions.filter((q) => guest && guest.answers[q.id] !== undefined);

  return (
    <Dialog open={guestId !== null} onOpenChange={(open) => (open ? null : onClose())}>
      {guestId ? (
        <Drawer title={guest?.name ?? 'Guest'} description={guest?.email ?? undefined}>
          {confirmDialog}
          {!guest ? (
            <p className="text-sm text-[var(--fg-muted)]">Loading…</p>
          ) : (
            <div className="space-y-6" data-guest-drawer>
              <section className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={STATUS_TONE[guest.status]}>{STATUS_LABEL[guest.status]}</Badge>
                  <Badge tone="outline">{SOURCE_LABEL[guest.source]}</Badge>
                  {guest.parentName ? (
                    <Badge tone="outline">Guest of {guest.parentName}</Badge>
                  ) : null}
                  {guest.recordId ? (
                    <a
                      className="text-sm text-[var(--accent)] underline"
                      href={`/lists/records/${guest.recordId}`}
                    >
                      Open record
                    </a>
                  ) : null}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Status by session</h3>
                <ul className="space-y-2">
                  {sessions
                    .filter((s) => guest.sessions[s.id])
                    .map((s) => {
                      const st = guest.sessions[s.id]!;
                      return (
                        <li
                          key={s.id}
                          className="rounded-md border border-[var(--border)] p-3"
                          data-drawer-session={s.id}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">{s.name}</span>
                            <Badge tone={STATUS_TONE[st.status]}>{STATUS_LABEL[st.status]}</Badge>
                          </div>
                          {st.decisionNote ? (
                            <p className="mt-1 text-xs text-[var(--fg-muted)]">
                              Note: {st.decisionNote}
                            </p>
                          ) : null}
                          {st.checkedInAt ? (
                            <p className="mt-1 text-xs text-[var(--fg-muted)]">
                              Checked in {shortStamp(st.checkedInAt, timeZone)}
                            </p>
                          ) : null}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {st.status === 'pending' ? (
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => bulk('approve', { sessionId: s.id })}
                              >
                                Approve
                              </Button>
                            ) : null}
                            {st.status === 'waitlist' ? (
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => bulk('promote', { sessionId: s.id })}
                              >
                                Promote
                              </Button>
                            ) : null}
                            {st.status !== 'going' ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={async () => {
                                  const yes = await confirm({
                                    title: 'Add directly as Going?',
                                    description:
                                      'This skips approval and capacity. Use it for comps and VIPs.',
                                    confirmLabel: 'Add as Going',
                                  });
                                  if (yes) await bulk('going', { sessionId: s.id, force: true });
                                }}
                              >
                                Going
                              </Button>
                            ) : null}
                            {st.status !== 'waitlist' && st.status !== 'declined' ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => bulk('waitlist', { sessionId: s.id })}
                              >
                                Waitlist
                              </Button>
                            ) : null}
                            {st.status !== 'declined' ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => bulk('decline', { sessionId: s.id })}
                              >
                                Decline
                              </Button>
                            ) : null}
                            {st.status === 'going' ? (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => checkin(s.id, Boolean(st.checkedInAt))}
                              >
                                {st.checkedInAt ? 'Undo check-in' : 'Check in'}
                              </Button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  {sessions.filter((s) => !guest.sessions[s.id]).length ? (
                    <li className="flex flex-wrap gap-1.5">
                      {sessions
                        .filter((s) => !guest.sessions[s.id])
                        .map((s) => (
                          <Button
                            key={s.id}
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => bulk('add_session', { sessionId: s.id })}
                          >
                            + {s.name}
                          </Button>
                        ))}
                    </li>
                  ) : null}
                </ul>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Details</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="First name" htmlFor="g-first">
                    <Input
                      id="g-first"
                      value={form.firstName ?? ''}
                      onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    />
                  </Field>
                  <Field label="Last name" htmlFor="g-last">
                    <Input
                      id="g-last"
                      value={form.lastName ?? ''}
                      onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    />
                  </Field>
                  <Field label="Email" htmlFor="g-email">
                    <Input
                      id="g-email"
                      type="email"
                      value={form.email ?? ''}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                    />
                  </Field>
                  <Field label="Phone" htmlFor="g-phone">
                    <Input
                      id="g-phone"
                      value={form.phone ?? ''}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />
                  </Field>
                  <Field label="Company" htmlFor="g-company">
                    <Input
                      id="g-company"
                      value={form.company ?? ''}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                    />
                  </Field>
                  <Field label="Title" htmlFor="g-title">
                    <Input
                      id="g-title"
                      value={form.title ?? ''}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                    />
                  </Field>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    save({
                      first_name: form.firstName ?? null,
                      last_name: form.lastName ?? null,
                      email: form.email ?? null,
                      phone: form.phone ?? null,
                      company: form.company ?? null,
                      title: form.title ?? null,
                    })
                  }
                >
                  Save details
                </Button>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Tags</h3>
                <div className="flex flex-wrap gap-1.5">
                  {guest.tags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
                      onClick={() =>
                        save({ tags: guest.tags.filter((x) => x !== t) }, `Removed ${t}`)
                      }
                      aria-label={`Remove tag ${t}`}
                    >
                      {t} ×
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_TAGS.filter((t) => !guest.tags.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]"
                      onClick={() => save({ tags: [...guest.tags, t] }, `Tagged ${t}`)}
                    >
                      + {t}
                    </button>
                  ))}
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (tagDraft.trim())
                      void save(
                        { tags: [...guest.tags, tagDraft.trim()] },
                        `Tagged ${tagDraft.trim()}`,
                      );
                    setTagDraft('');
                  }}
                >
                  <Input
                    aria-label="Custom tag"
                    placeholder="Custom tag"
                    value={tagDraft}
                    maxLength={40}
                    onChange={(e) => setTagDraft(e.target.value)}
                  />
                  <Button size="sm" type="submit" disabled={busy}>
                    Add
                  </Button>
                </form>
              </section>

              <section className="space-y-2">
                <Field label="Host note (only TipTop sees it)" htmlFor="g-note">
                  <Textarea
                    id="g-note"
                    value={note}
                    maxLength={4000}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <Button
                  size="sm"
                  disabled={busy || note === (guest.note ?? '')}
                  onClick={() => save({ host_note: note || null }, 'Note saved')}
                >
                  Save note
                </Button>
              </section>

              {answered.length ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Answers</h3>
                  <dl className="space-y-2 text-sm">
                    {answered.map((q) => (
                      <div key={q.id}>
                        <dt className="text-[var(--fg-muted)]">
                          {q.removed_at ? `(removed) ${q.label}` : q.label}
                        </dt>
                        <dd className="whitespace-pre-wrap">{answerText(guest.answers[q.id])}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {detail?.plusOnes.length ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Plus-ones</h3>
                  <ul className="space-y-2">
                    {detail?.plusOnes.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] p-2 text-sm"
                      >
                        <span>
                          {p.name}{' '}
                          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={async () => {
                            const yes = await confirm({
                              title: `Remove ${p.name}?`,
                              confirmLabel: 'Remove',
                              tone: 'danger',
                            });
                            if (!yes) return;
                            setBusy(true);
                            const res = await api(`/api/events/${eventId}/guests/${p.id}`, {
                              method: 'DELETE',
                            });
                            setBusy(false);
                            if (!res.ok) toast.error(res.error?.message ?? 'That did not work.');
                            await load();
                            onChanged();
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Timeline</h3>
                <ol className="space-y-1.5 text-sm" data-guest-timeline>
                  {detail?.timeline.map((t, i) => (
                    <li key={`${t.at}-${i}`} className="flex justify-between gap-3">
                      <span>{t.text}</span>
                      <span className="shrink-0 text-xs text-[var(--fg-muted)]">
                        {shortStamp(t.at, timeZone)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
                {!guest.parentId ? (
                  <Button size="sm" onClick={copyLink}>
                    Copy personal link
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const yes = await confirm({
                      title: 'Rotate this guest’s links?',
                      description:
                        'Their invitation, ticket and QR links stop working. Send them the new one.',
                      confirmLabel: 'Rotate',
                    });
                    if (yes) await bulk('rotate_links');
                  }}
                >
                  Rotate link
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    const yes = await confirm({
                      title: `Remove ${guest.name}?`,
                      description:
                        'This deletes the guest, their answers and any plus-ones. It cannot be undone.',
                      confirmLabel: 'Remove guest',
                      tone: 'danger',
                    });
                    if (!yes) return;
                    await bulk('remove');
                    onClose();
                  }}
                >
                  Remove guest
                </Button>
              </section>
            </div>
          )}
        </Drawer>
      ) : null}
    </Dialog>
  );
}
