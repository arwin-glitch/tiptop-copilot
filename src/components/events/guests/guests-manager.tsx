'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Eye, MailOpen, MessageSquareReply, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/form';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@/components/ui/table';
import { FilterChip, FilterChipRow } from '@/components/ui/toolbar';
import type { GuestCounts } from '@/lib/events/contracts';
import {
  EMPTY_FILTER,
  GUEST_TAB_LABELS,
  GUEST_TABS,
  PRESET_TAGS,
  filterGuests,
  sortGuests,
  tabCounts,
  tagsInUse,
  type GuestFilter,
  type GuestListItem,
  type GuestSort,
} from '@/lib/events/guest-list';
import { answerText, type RegistrationQuestion } from '@/lib/events/questions';
import type { EventGuestSource } from '@/lib/types/domain';
import { AddGuestsDialog } from './add-guests-dialog';
import { GuestDrawer } from './guest-drawer';
import { api, plural, shortStamp, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE } from './guest-ui';
import { ImportDialog } from './import-dialog';

/**
 * The guest table (D-075): status tabs with counts, filters (session, tag,
 * source), search (name, email, company, domain), sort, the expanded view
 * with every answer, shift-click range selection, the bulk bar (each action
 * confirmed with counts), the drawer, adding guests, CSV import and export,
 * and the caterer's headcount. Owners only (the panel is signed in).
 */

interface SessionLite {
  id: string;
  name: string;
  capacity: number | null;
}

type BulkAction =
  | 'approve'
  | 'decline'
  | 'going'
  | 'waitlist'
  | 'promote'
  | 'add_session'
  | 'remove_session'
  | 'add_tag'
  | 'remove_tag'
  | 'rotate_links'
  | 'remove';

const BULK_LABEL: Record<BulkAction, string> = {
  approve: 'Approve',
  decline: 'Decline',
  going: 'Move to Going',
  waitlist: 'Move to Waitlist',
  promote: 'Promote from waitlist',
  add_session: 'Add a session',
  remove_session: 'Remove a session',
  add_tag: 'Add a tag',
  remove_tag: 'Remove a tag',
  rotate_links: 'Rotate personal links',
  remove: 'Remove guests',
};

function FunnelIcons({ item, timeZone }: { item: GuestListItem; timeZone: string }) {
  const steps: [boolean, string, React.ReactNode][] = [
    [
      Boolean(item.funnel.invitedAt),
      `Invited ${shortStamp(item.funnel.invitedAt, timeZone)}`,
      <Send key="i" />,
    ],
    [
      Boolean(item.funnel.openedAt),
      `Opened ${shortStamp(item.funnel.openedAt, timeZone)}`,
      <MailOpen key="o" />,
    ],
    [
      Boolean(item.funnel.viewedAt),
      `Viewed page ${shortStamp(item.funnel.viewedAt, timeZone)}`,
      <Eye key="v" />,
    ],
    [
      Boolean(item.funnel.respondedAt),
      `Responded ${shortStamp(item.funnel.respondedAt, timeZone)}`,
      <MessageSquareReply key="r" />,
    ],
  ];
  return (
    <span className="inline-flex gap-1" aria-label="Invite funnel">
      {steps.map(([on, label, icon], i) => (
        <span
          key={i}
          title={on ? label : label.split(' ')[0] + ': not yet'}
          aria-label={on ? label : `${label.split(' ')[0]}: not yet`}
          className={`[&_svg]:size-3.5 ${on ? 'text-[var(--accent)]' : 'text-[var(--fg-subtle)] opacity-40'}`}
        >
          {icon}
        </span>
      ))}
    </span>
  );
}

export function GuestsManager({
  eventId,
  slug,
  timeZone,
  guests,
  sessions,
  questions,
  counts,
}: {
  eventId: string;
  slug: string;
  timeZone: string;
  guests: GuestListItem[];
  sessions: SessionLite[];
  questions: RegistrationQuestion[];
  counts: GuestCounts;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<GuestFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<GuestSort>('name');
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<number | null>(null);
  const shiftHeld = useRef(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<{
    action: BulkAction;
    sessionId: string;
    tag: string;
    note: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const visible = useMemo(
    () => sortGuests(filterGuests(guests, filter), sort),
    [guests, filter, sort],
  );
  const countsByTab = useMemo(
    () => tabCounts(guests, filter.sessionId),
    [guests, filter.sessionId],
  );
  const tags = useMemo(() => tagsInUse(guests), [guests]);
  const sources = useMemo(() => [...new Set(guests.map((g) => g.source))], [guests]);
  const liveQuestions = questions.filter(
    (q) => !q.removed_at || guests.some((g) => g.answers[q.id] !== undefined),
  );
  const selectedIds = [...selected].filter((id) => guests.some((g) => g.id === id));

  function refresh() {
    router.refresh();
  }

  function toggleRow(index: number, id: string, shift: boolean) {
    const next = new Set(selected);
    if (shift && lastClicked.current !== null) {
      const a = Math.min(lastClicked.current, index);
      const b = Math.max(lastClicked.current, index);
      const turnOn = !selected.has(id);
      for (const row of visible.slice(a, b + 1)) {
        if (turnOn) next.add(row.id);
        else next.delete(row.id);
      }
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    lastClicked.current = index;
    setSelected(next);
  }

  async function runBulk(
    action: BulkAction,
    extra: { sessionId?: string; tag?: string; note?: string; force?: boolean } = {},
  ) {
    setBusy(true);
    const res = await api<{ changed: number; full: number; promoted: number; removed?: number }>(
      `/api/events/${eventId}/guests`,
      {
        method: 'PATCH',
        body: {
          action,
          guestIds: selectedIds,
          sessionId: extra.sessionId || null,
          tag: extra.tag || null,
          note: extra.note || null,
          force: extra.force,
        },
      },
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      toast.error(res.error?.message ?? 'That did not work.');
      return;
    }
    const d = res.data;
    const parts = [`${BULK_LABEL[action]}: ${plural(d.changed, 'guest')}`];
    if (d.full) parts.push(`${d.full} left as they were – no room`);
    if (d.promoted) parts.push(`${d.promoted} promoted from the waitlist`);
    if (d.full) toast.warning(parts.join(' · '));
    else toast.success(parts.join(' · '));
    if (action === 'remove') setSelected(new Set());
    setPending(null);
    refresh();
  }

  async function startBulk(action: BulkAction) {
    const n = selectedIds.length;
    if (
      action === 'add_session' ||
      action === 'remove_session' ||
      action === 'add_tag' ||
      action === 'remove_tag' ||
      action === 'decline'
    ) {
      setPending({
        action,
        sessionId: filter.sessionId ?? sessions[0]?.id ?? '',
        tag: '',
        note: '',
      });
      return;
    }
    const descriptions: Partial<Record<BulkAction, string>> = {
      approve:
        'Pending requests become Going while there is room. Each decision joins the “Needs notifying” queue; nothing is emailed.',
      going: 'They become Going in every session they have a status in, while there is room.',
      waitlist: 'They move to the back of each waitlist.',
      promote: 'Waitlisted guests are seated first-in-first-out while there is room.',
      rotate_links: 'Their invitation, ticket and QR links stop working. Send them new ones.',
      remove: 'This deletes them, their answers and plus-ones. It cannot be undone.',
    };
    const yes = await confirm({
      title: `${BULK_LABEL[action]} – ${plural(n, 'guest')}?`,
      description: descriptions[action],
      confirmLabel: BULK_LABEL[action],
      tone: action === 'remove' ? 'danger' : 'primary',
    });
    if (yes) await runBulk(action);
  }

  async function draftMessage() {
    setBusy(true);
    const res = await api<{ campaignId?: string }>(`/api/events/${eventId}/campaign`, {
      method: 'POST',
      body: { kind: 'blast', audience: { kind: 'guests', guestIds: selectedIds } },
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(
        res.error?.code === 'not_found'
          ? 'Drafting messages arrives with the Messages tab.'
          : (res.error?.message ?? 'The draft could not be made.'),
      );
      return;
    }
    toast.success('Draft ready to review in Messages. Nothing has been sent.');
    router.push(`/events/${eventId}?tab=messages`);
  }

  function exportUrl(kind: 'guests' | 'headcount', filtered: boolean): string {
    const params = new URLSearchParams({ confirm: '1' });
    if (kind === 'headcount') params.set('kind', 'headcount');
    if (filtered) {
      if (filter.tab !== 'all') params.set('tab', filter.tab);
      if (filter.sessionId) params.set('session', filter.sessionId);
      if (filter.tag) params.set('tag', filter.tag);
      if (filter.source) params.set('source', filter.source);
      if (filter.q) params.set('q', filter.q);
    }
    return `/api/events/${eventId}/guests/export.csv?${params.toString()}`;
  }

  const sessionCol = sessions.length > 1 || expanded;
  const filteredActive =
    filter.tab !== 'all' ||
    Boolean(filter.sessionId || filter.tag || filter.source || filter.q.trim());

  return (
    <div className="space-y-4" data-guests-manager>
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-[var(--fg-muted)]">
          {counts.going} going
          {counts.plusOnes ? ` (incl. ${plural(counts.plusOnes, 'plus-one')})` : ''} ·{' '}
          {counts.pending} pending · {counts.waitlist} waitlist · {counts.checkedIn} checked in
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            Add guests
          </Button>
          <Button size="sm" onClick={() => setImporting(true)}>
            Import CSV
          </Button>
          <Button size="sm" onClick={() => setExporting(true)}>
            Export
          </Button>
        </div>
      </div>

      <FilterChipRow aria-label="Guest status">
        {GUEST_TABS.map((tab) => (
          <FilterChip
            key={tab}
            label={GUEST_TAB_LABELS[tab]}
            count={countsByTab[tab]}
            pressed={filter.tab === tab}
            onToggle={() => setFilter({ ...filter, tab })}
          />
        ))}
      </FilterChipRow>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          aria-label="Search guests"
          placeholder="Search name, email, company, domain"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          className="lg:col-span-2"
        />
        <Select
          aria-label="Session"
          value={filter.sessionId ?? ''}
          onChange={(e) => setFilter({ ...filter, sessionId: e.target.value || null })}
        >
          <option value="">All sessions</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Tag"
          value={filter.tag ?? ''}
          onChange={(e) => setFilter({ ...filter, tag: e.target.value || null })}
        >
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Select
            aria-label="Source"
            value={filter.source ?? ''}
            onChange={(e) =>
              setFilter({ ...filter, source: (e.target.value || null) as EventGuestSource | null })
            }
          >
            <option value="">Any source</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as GuestSort)}
          >
            <option value="name">Name</option>
            <option value="registered">Registered</option>
            <option value="changed">Last change</option>
            <option value="checkin">Check-in</option>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={expanded}
            onChange={(e) => setExpanded(e.target.checked)}
          />
          Show every answer
        </label>
        <span className="text-xs text-[var(--fg-muted)]">Shift-click to select a range.</span>
      </div>

      {selectedIds.length ? (
        <div
          className="sticky top-[var(--titlebar-h)] z-[var(--z-sticky)] flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-overlay)] p-2"
          role="toolbar"
          aria-label="Bulk actions"
          data-bulk-bar
        >
          <span className="px-1 text-sm font-medium">
            {plural(selectedIds.length, 'selected', 'selected')}
          </span>
          {(
            [
              'approve',
              'decline',
              'going',
              'waitlist',
              'promote',
              'add_session',
              'remove_session',
              'add_tag',
              'remove_tag',
              'rotate_links',
            ] as BulkAction[]
          ).map((a) => (
            <Button key={a} size="sm" disabled={busy} onClick={() => startBulk(a)}>
              {BULK_LABEL[a]}
            </Button>
          ))}
          <Button size="sm" disabled={busy} onClick={draftMessage}>
            Draft message to selection
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => startBulk('remove')}>
            Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <Table caption="Guests" stickyHeader>
        <TableHead>
          <TableRow>
            <TableHeaderCell className="w-8">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={visible.length > 0 && visible.every((g) => selected.has(g.id))}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(visible.map((g) => g.id)) : new Set())
                }
              />
            </TableHeaderCell>
            <TableHeaderCell>Guest</TableHeaderCell>
            {sessionCol ? (
              <TableHeaderCell>Sessions</TableHeaderCell>
            ) : (
              <TableHeaderCell>Status</TableHeaderCell>
            )}
            <TableHeaderCell>Tags</TableHeaderCell>
            <TableHeaderCell>Source</TableHeaderCell>
            <TableHeaderCell>Funnel</TableHeaderCell>
            <TableHeaderCell>Check-in</TableHeaderCell>
            {expanded
              ? liveQuestions.map((q) => (
                  <TableHeaderCell key={q.id}>
                    {q.removed_at ? `(removed) ${q.label}` : q.label}
                  </TableHeaderCell>
                ))
              : null}
          </TableRow>
        </TableHead>
        <TableBody>
          {visible.map((g, index) => (
            <TableRow key={g.id} data-guest-row={g.id}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Select ${g.name}`}
                  checked={selected.has(g.id)}
                  onClick={(e) => {
                    shiftHeld.current = e.shiftKey;
                  }}
                  onChange={() => toggleRow(index, g.id, shiftHeld.current)}
                />
              </TableCell>
              <TableCell>
                <button type="button" className="text-left" onClick={() => setDrawer(g.id)}>
                  <span className={`font-medium hover:underline ${g.parentId ? 'pl-4' : ''}`}>
                    {g.parentId ? '↳ ' : ''}
                    {g.name}
                  </span>
                  <span className="block text-xs text-[var(--fg-muted)]">
                    {[g.parentId ? `Guest of ${g.parentName ?? '—'}` : g.email, g.company, g.title]
                      .filter(Boolean)
                      .join(' · ')}
                    {g.plusOneIds.length ? ` · +${g.plusOneIds.length}` : ''}
                  </span>
                </button>
              </TableCell>
              <TableCell>
                {sessionCol ? (
                  <div className="flex flex-wrap gap-1">
                    {sessions
                      .filter((s) => g.sessions[s.id])
                      .map((s) => (
                        <Badge
                          key={s.id}
                          tone={STATUS_TONE[g.sessions[s.id]!.status]}
                          title={s.name}
                        >
                          {s.name}: {STATUS_LABEL[g.sessions[s.id]!.status]}
                        </Badge>
                      ))}
                  </div>
                ) : (
                  <Badge tone={STATUS_TONE[g.status]}>{STATUS_LABEL[g.status]}</Badge>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {g.tags.map((t) => (
                    <Badge key={t} tone="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                {SOURCE_LABEL[g.source]}
                {g.referral ? ` · ${g.referral}` : ''}
              </TableCell>
              <TableCell>
                <FunnelIcons item={g} timeZone={timeZone} />
              </TableCell>
              <TableCell className="text-xs">
                {sessions
                  .filter((s) => g.sessions[s.id]?.checkedInAt)
                  .map(
                    (s) =>
                      `${sessions.length > 1 ? `${s.name} ` : ''}${shortStamp(g.sessions[s.id]!.checkedInAt, timeZone)}`,
                  )
                  .join(', ')}
              </TableCell>
              {expanded
                ? liveQuestions.map((q) => (
                    <TableCell key={q.id} className="max-w-[16rem] text-xs whitespace-pre-wrap">
                      {answerText(g.answers[q.id])}
                    </TableCell>
                  ))
                : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!visible.length ? (
        <p className="text-sm text-[var(--fg-muted)]">
          {guests.length
            ? 'No guests match these filters.'
            : 'No guests yet. Add guests, import a CSV, or share the page.'}
        </p>
      ) : null}

      <GuestDrawer
        key={drawer ?? 'closed'}
        eventId={eventId}
        guestId={drawer}
        sessions={sessions}
        questions={questions}
        timeZone={timeZone}
        onClose={() => setDrawer(null)}
        onChanged={refresh}
      />
      <AddGuestsDialog
        eventId={eventId}
        sessions={sessions}
        open={adding}
        onOpenChange={setAdding}
        onAdded={refresh}
      />
      <ImportDialog
        eventId={eventId}
        sessions={sessions}
        questions={questions}
        open={importing}
        onOpenChange={setImporting}
        onImported={refresh}
      />

      <Dialog open={exporting} onOpenChange={setExporting}>
        <DialogContent
          title="Export guests"
          description="The file holds names, emails and answers. Keep it private. Every export is recorded."
        >
          <div className="space-y-2" data-export-dialog>
            <a
              className="block text-sm text-[var(--accent)] underline"
              href={exportUrl('guests', false)}
              download
              onClick={() => setExporting(false)}
            >
              Everyone ({plural(guests.length, 'row')}, one per guest and plus-one)
            </a>
            {filteredActive ? (
              <a
                className="block text-sm text-[var(--accent)] underline"
                href={exportUrl('guests', true)}
                download
                onClick={() => setExporting(false)}
              >
                Only the filtered rows ({plural(visible.length, 'row')})
              </a>
            ) : null}
            <a
              className="block text-sm text-[var(--accent)] underline"
              href={exportUrl('headcount', false)}
              download
              onClick={() => setExporting(false)}
            >
              Headcount per session for the caterer
            </a>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pending !== null} onOpenChange={(open) => (open ? null : setPending(null))}>
        {pending ? (
          <DialogContent
            title={`${BULK_LABEL[pending.action]} – ${plural(selectedIds.length, 'guest')}`}
          >
            <div className="space-y-3">
              {pending.action === 'add_session' ||
              pending.action === 'remove_session' ||
              pending.action === 'decline' ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Session</span>
                  <Select
                    value={pending.sessionId}
                    onChange={(e) => setPending({ ...pending, sessionId: e.target.value })}
                  >
                    {pending.action === 'decline' ? <option value="">Every session</option> : null}
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              {pending.action === 'add_tag' || pending.action === 'remove_tag' ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Tag</span>
                  <Input
                    list="guest-tag-options"
                    value={pending.tag}
                    maxLength={40}
                    onChange={(e) => setPending({ ...pending, tag: e.target.value })}
                  />
                  <datalist id="guest-tag-options">
                    {[...new Set([...PRESET_TAGS, ...tags])].map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </label>
              ) : null}
              {pending.action === 'decline' ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Note (optional, for your records)</span>
                  <Textarea
                    value={pending.note}
                    maxLength={1000}
                    onChange={(e) => setPending({ ...pending, note: e.target.value })}
                  />
                </label>
              ) : null}
              {pending.action === 'remove_session' ? (
                <p className="text-sm text-[var(--fg-muted)]">
                  Their RSVP for that session is removed. Plus-ones leave it too.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button
                variant={pending.action === 'decline' ? 'danger' : 'primary'}
                loading={busy}
                disabled={
                  busy ||
                  ((pending.action === 'add_tag' || pending.action === 'remove_tag') &&
                    !pending.tag.trim()) ||
                  ((pending.action === 'add_session' || pending.action === 'remove_session') &&
                    !pending.sessionId)
                }
                onClick={() =>
                  runBulk(pending.action, {
                    sessionId: pending.sessionId || undefined,
                    tag: pending.tag.trim() || undefined,
                    note: pending.note.trim() || undefined,
                  })
                }
              >
                {BULK_LABEL[pending.action]}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <p className="text-xs text-[var(--fg-muted)]">
        Public page:{' '}
        <a className="underline" href={`/e/${slug}`} target="_blank" rel="noopener noreferrer">
          /e/{slug}
        </a>
      </p>
    </div>
  );
}
