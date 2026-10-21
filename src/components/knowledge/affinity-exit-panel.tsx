'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { changeAffinityExitAction, runAffinityExitImportAction } from '@/app/actions/affinity-exit';
import { DownloadLink } from '@/components/lists/download-link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Input, Label, Switch } from '@/components/ui/form';
import {
  AFFINITY_EXIT_TOOL_LABEL_MAX,
  AFFINITY_EXIT_TOOLS_MAX,
  affinityExitCountdown,
  daysLeftLabel,
  noticeDateLabel,
  type AffinityDailySyncState,
  type AffinityExitChange,
  type AffinityExitSettings,
} from '@/lib/crm/affinity-exit';
import {
  UNLISTED_PER_RUN,
  REMINDERS_PER_RUN,
  estimateMegabytes,
} from '@/lib/crm/affinity-exit-import';
import { CRM_EXPORT_EVERYTHING_HREF } from '@/lib/crm/view';
import { cn } from '@/lib/util/cn';
import { relativeTime } from '@/lib/util/time';

/**
 * Knowledge → Affinity import → Exit checklist: everything leaving Affinity
 * needs, on one screen.
 *
 *   - the countdown to the day Affinity needs notice by (a date someone sets
 *     here; nothing is assumed), and "Cancelled", which ends it;
 *   - what Copilot already has, counted from its own records, and what the
 *     daily sync does not copy — each copy that can be made is one button;
 *   - the outside tools that still read from Affinity, as a checklist anyone
 *     in the workspace can add to and tick;
 *   - the final archive: the whole CRM as one ZIP.
 *
 * Changes go to the server one at a time (lib/services/affinity-exit.ts) and
 * the page shows the saved result.
 */

export interface AffinityExitImportView {
  state: 'never' | 'partial' | 'done';
  running: boolean;
  scanned: number;
  existing: number;
  copied: number;
  skipped: number;
  openTotal: number | null;
  finishedAt: string | null;
  lastError: { at: string; message: string } | null;
}

/** What the panel shows; serializable from the server (AffinityExitStatus). */
export interface AffinityExitPanelStatus {
  settings: AffinityExitSettings;
  crmReady: boolean;
  lists: number | null;
  companies: number | null;
  people: number | null;
  notes: number | null;
  introductions: { count: number | null; atLeast: boolean; lastImportAt: string | null };
  sync: {
    state: AffinityDailySyncState;
    demo: boolean;
    lastRunAt: string | null;
    stoppedAt: string | null;
  };
  imports: { contacts: AffinityExitImportView; reminders: AffinityExitImportView };
}

type CopyKind = 'contacts' | 'reminders';

const NUMBER = new Intl.NumberFormat('en-US');
const n = (value: number) => NUMBER.format(value);
/** Calls of the copy action one press may make before it stops and says so. */
const MAX_STEPS = 400;

export function AffinityExitPanel({
  status,
  timeZone,
  nowIso,
  canEdit,
  canImport,
  canArchive,
}: {
  status: AffinityExitPanelStatus;
  timeZone: string;
  /** The server's clock at render, so the countdown reads the same on both sides. */
  nowIso: string;
  canEdit: boolean;
  canImport: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  // What a change just saved, shown until the server's next render carries it:
  // a fresh `status.settings` from the server always wins over it.
  const [saved, setSaved] = React.useState<{
    over: AffinityExitSettings;
    settings: AffinityExitSettings;
  } | null>(null);
  const settings = saved && saved.over === status.settings ? saved.settings : status.settings;
  const [saving, setSaving] = React.useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function change(change: AffinityExitChange, busyKey: string): Promise<boolean> {
    setSaving(busyKey);
    try {
      const result = await changeAffinityExitAction(change);
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'The change could not be saved.');
        return false;
      }
      setSaved({ over: status.settings, settings: result.data });
      router.refresh();
      return true;
    } catch {
      toast.error('The change could not be saved: no connection.');
      return false;
    } finally {
      setSaving(null);
    }
  }

  return (
    <section aria-labelledby="affinity-exit-heading" data-affinity-exit="">
      <h2 id="affinity-exit-heading" className="mb-3 font-serif text-lg font-semibold">
        Affinity exit
      </h2>
      <CountdownCard
        settings={settings}
        now={new Date(nowIso)}
        timeZone={timeZone}
        canEdit={canEdit}
        saving={saving}
        onChange={change}
      />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <StatusCard
          status={status}
          canImport={canImport}
          confirm={confirm}
          onCopied={() => router.refresh()}
        />
        <div className="space-y-4">
          <ToolsCard settings={settings} canEdit={canEdit} saving={saving} onChange={change} />
          <ArchiveCard canArchive={canArchive} />
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

/* -------------------------------------------------------------- countdown */

function CountdownCard({
  settings,
  now,
  timeZone,
  canEdit,
  saving,
  onChange,
}: {
  settings: AffinityExitSettings;
  now: Date;
  timeZone: string;
  canEdit: boolean;
  saving: string | null;
  onChange: (change: AffinityExitChange, busyKey: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(settings.noticeDate ?? '');
  // The switch's new position while it saves; null once the saved state shows.
  const [flipping, setFlipping] = React.useState<boolean | null>(null);
  const countdown = affinityExitCountdown(settings, now, timeZone);
  const showEditor = canEdit && !settings.cancelled && (editing || !settings.noticeDate);

  async function saveDate(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (await onChange({ op: 'date', date: draft }, 'date')) setEditing(false);
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 pt-4">
        <div className="min-w-0 flex-1">
          {settings.cancelled ? (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <Badge tone="ok">Cancelled</Badge>
                {settings.cancelledAt ? (
                  <span className="font-normal text-[var(--fg-muted)]" suppressHydrationWarning>
                    Marked {relativeTime(settings.cancelledAt)}
                  </span>
                ) : null}
              </p>
              <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
                The countdown and the reminder on Today are off.
              </p>
            </>
          ) : countdown ? (
            <>
              <p className="flex items-baseline gap-2" data-testid="affinity-exit-countdown">
                <span className="tabular font-serif text-3xl font-semibold">
                  {Math.abs(countdown.daysLeft)}
                </span>
                <span className="text-sm text-[var(--fg-muted)]">
                  {countdown.daysLeft >= 0
                    ? `${countdown.daysLeft === 1 ? 'day' : 'days'} left to give Affinity notice`
                    : `${countdown.daysLeft === -1 ? 'day' : 'days'} past the notice date`}
                </span>
              </p>
              <p className="mt-1 text-sm">
                Notice date: {noticeDateLabel(countdown.dateKey, true)} (
                {daysLeftLabel(countdown.daysLeft)})
                {canEdit && !editing ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="text-[var(--accent)] underline-offset-2 hover:underline"
                      onClick={() => {
                        setDraft(settings.noticeDate ?? '');
                        setEditing(true);
                      }}
                    >
                      Change
                    </button>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold">When does Affinity need notice by?</p>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">
                {canEdit
                  ? 'Set the last day to tell Affinity you are leaving. The page counts down to it, and Today shows one line in the last two weeks.'
                  : 'No notice date is set yet. A member of the workspace can set it here.'}
              </p>
            </>
          )}

          {showEditor ? (
            <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={saveDate}>
              <div>
                <Label htmlFor="affinity-notice-date" className="mb-1 text-xs">
                  Notice date
                </Label>
                <Input
                  id="affinity-notice-date"
                  type="date"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-44"
                  required
                />
              </div>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={saving === 'date'}
                disabled={!draft || saving !== null}
              >
                Save date
              </Button>
              {settings.noticeDate ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft(settings.noticeDate ?? '');
                      setEditing(false);
                    }}
                  >
                    Keep {noticeDateLabel(settings.noticeDate)}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving !== null}
                    onClick={async () => {
                      if (await onChange({ op: 'date', date: null }, 'date')) {
                        setDraft('');
                        setEditing(false);
                      }
                    }}
                  >
                    Clear date
                  </Button>
                </>
              ) : null}
            </form>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5">
          <Switch
            id="affinity-cancelled"
            checked={flipping ?? settings.cancelled}
            disabled={!canEdit || saving !== null}
            onCheckedChange={async (checked) => {
              setFlipping(checked);
              await onChange({ op: 'cancelled', cancelled: checked }, 'cancelled');
              setFlipping(null);
            }}
          />
          <Label htmlFor="affinity-cancelled" className="cursor-pointer">
            Cancelled
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------- status */

type Tone = 'ok' | 'no' | 'unknown' | 'warn';

const TONE_ICON: Record<Tone, { icon: LucideIcon; className: string; label: string }> = {
  ok: { icon: CheckCircle2, className: 'text-[var(--ok)]', label: 'In Copilot' },
  no: { icon: CircleDashed, className: 'text-[var(--fg-subtle)]', label: 'Not copied' },
  unknown: { icon: CircleHelp, className: 'text-[var(--fg-subtle)]', label: 'Unknown' },
  warn: { icon: AlertTriangle, className: 'text-[var(--warn)]', label: 'Needs a look' },
};

function StatusRow({
  tone,
  label,
  children,
  action,
}: {
  tone: Tone;
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const { icon: Icon, className, label: toneLabel } = TONE_ICON[tone];
  return (
    <li className="flex items-start gap-2.5 border-b border-[var(--border)] py-2.5 last:border-b-0">
      <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-label={toneLabel} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="mt-0.5 text-sm text-[var(--fg-muted)]">{children}</div>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </li>
  );
}

const unknown = <span>Unknown: it could not be counted just now.</span>;

function StatusCard({
  status,
  canImport,
  confirm,
  onCopied,
}: {
  status: AffinityExitPanelStatus;
  canImport: boolean;
  confirm: ReturnType<typeof useConfirm>[0];
  onCopied: () => void;
}) {
  const sync = status.sync;
  const intro = status.introductions;
  return (
    <Card>
      <CardContent className="pt-4">
        <h3 className="text-sm font-semibold">What Copilot has</h3>
        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
          Counted from Copilot&apos;s own records.
        </p>
        <ul className="mt-2" aria-label="What Copilot has from Affinity">
          <StatusRow
            tone={sync.state === 'stopped' ? 'warn' : sync.state === 'key_missing' ? 'no' : 'ok'}
            label="Daily sync"
          >
            {sync.state === 'stopped' ? (
              <span suppressHydrationWarning>
                Stopped
                {sync.stoppedAt ? ` ${relativeTime(sync.stoppedAt)}` : ''}: Affinity refused the API
                key. Nothing more is copied, and nothing fails.
              </span>
            ) : sync.state === 'key_missing' ? (
              'Stopped: no Affinity API key is set, so nothing is copied.'
            ) : sync.state === 'syncing' ? (
              'Running now.'
            ) : (
              <span suppressHydrationWarning>
                Running every morning
                {sync.lastRunAt ? `; last finished ${relativeTime(sync.lastRunAt)}` : ''}.
                {sync.demo ? ' (Demo example.)' : ''}
              </span>
            )}
          </StatusRow>
          <StatusRow
            tone={status.lists === null ? 'unknown' : status.lists > 0 ? 'ok' : 'no'}
            label="Lists synced"
          >
            {status.lists === null
              ? unknown
              : status.lists > 0
                ? `${n(status.lists)} ${status.lists === 1 ? 'list' : 'lists'}, with every row.`
                : 'None yet.'}
          </StatusRow>
          <StatusRow
            tone={
              status.companies === null || status.people === null
                ? 'unknown'
                : status.companies + status.people > 0
                  ? 'ok'
                  : 'no'
            }
            label="Records synced"
          >
            {status.companies === null || status.people === null
              ? unknown
              : `${n(status.companies)} companies and ${n(status.people)} people, keyed by their Affinity id.`}
          </StatusRow>
          <StatusRow
            tone={status.notes === null ? 'unknown' : status.notes > 0 ? 'ok' : 'no'}
            label="Notes synced"
          >
            {status.notes === null ? unknown : `${n(status.notes)} notes.`}
          </StatusRow>
          <StatusRow
            tone={intro.count === null ? 'unknown' : intro.count > 0 ? 'ok' : 'no'}
            label="Introductions imported"
          >
            {intro.count === null ? (
              unknown
            ) : intro.count > 0 ? (
              <span suppressHydrationWarning>
                {intro.atLeast ? 'At least ' : ''}
                {n(intro.count)} {intro.count === 1 ? 'introduction' : 'introductions'}
                {intro.lastImportAt ? `, last imported ${relativeTime(intro.lastImportAt)}` : ''}.
              </span>
            ) : (
              'Not copied: the daily sync does not read them. Export them from Affinity (Export all introductions in view) and drop the file on Sync & import.'
            )}
          </StatusRow>
          <CopyRow
            kind="contacts"
            label="Contacts on no list"
            view={status.imports.contacts}
            canImport={canImport && status.crmReady}
            confirm={confirm}
            onCopied={onCopied}
          />
          <CopyRow
            kind="reminders"
            label="Open reminders"
            view={status.imports.reminders}
            canImport={canImport}
            confirm={confirm}
            onCopied={onCopied}
          />
          <StatusRow tone="unknown" label="Files">
            Not copied, count unknown: the Affinity API Copilot reads cannot list files. Download
            any you need from Affinity by hand before it is cancelled.
          </StatusRow>
        </ul>
      </CardContent>
    </Card>
  );
}

const COPY_TEXT: Record<
  CopyKind,
  {
    button: string;
    again: string;
    never: string;
    confirm: () => { title: string; description: string };
  }
> = {
  contacts: {
    button: 'Copy contacts on no list',
    again: 'Copy again',
    never:
      'Not copied, count unknown: the daily sync reads lists, not every contact Affinity ever made from the mailbox, and the API gives no total.',
    confirm: () => ({
      title: 'Copy the contacts on no list?',
      description: `Every company and person in Affinity that Copilot does not have yet: name, domain and email addresses only. One press copies up to ${n(UNLISTED_PER_RUN)} (about ${estimateMegabytes(UNLISTED_PER_RUN)} MB); press again to carry on. Anything already in Copilot is left as it is.`,
    }),
  },
  reminders: {
    button: 'Copy open reminders as tasks',
    again: 'Copy new ones',
    never: 'Not copied: the daily sync does not read reminders.',
    confirm: () => ({
      title: 'Copy open reminders as tasks?',
      description: `Each open Affinity reminder becomes a task on Tasks, due when the reminder is (up to ${n(REMINDERS_PER_RUN)} a press). Copying again adds only new ones, and never brings back a task you finished.`,
    }),
  },
};

function copySummary(kind: CopyKind, view: AffinityExitImportView): string {
  if (view.state === 'never') return COPY_TEXT[kind].never;
  if (kind === 'contacts') {
    const base = `${n(view.copied)} copied; ${n(view.existing)} were already in Copilot`;
    return view.state === 'done'
      ? `${base}. Every company and person was read.`
      : `${base}, so far. Press again to carry on.`;
  }
  const open = view.openTotal !== null ? ` of ${n(view.openTotal)} open` : '';
  return view.state === 'done'
    ? `${n(view.copied)}${open} copied as tasks; ${n(view.existing)} were tasks already.`
    : `${n(view.copied)}${open} copied as tasks so far. Press again to carry on.`;
}

function CopyRow({
  kind,
  label,
  view,
  canImport,
  confirm,
  onCopied,
}: {
  kind: CopyKind;
  label: string;
  view: AffinityExitImportView;
  canImport: boolean;
  confirm: ReturnType<typeof useConfirm>[0];
  onCopied: () => void;
}) {
  const [progress, setProgress] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const text = COPY_TEXT[kind];

  async function run() {
    if (!(await confirm({ ...text.confirm(), confirmLabel: 'Copy' }))) return;
    setMessage(null);
    setProgress('Starting…');
    let fresh = true;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const result = await runAffinityExitImportAction({ kind, fresh });
        if (!result.ok || !result.data) {
          setMessage({
            tone: 'warn',
            text: result.error?.message ?? 'The copy stopped. Try again.',
          });
          onCopied();
          return;
        }
        const d = result.data;
        if (d.busy) {
          // Another press holds it: wait, and start this press once it is free.
          setProgress('Waiting for the copy already under way…');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        fresh = false;
        if (d.done || d.capped) {
          setMessage({
            tone: 'ok',
            text: d.done
              ? `Done: ${n(d.runCopied)} copied${d.existing ? `, ${n(d.existing)} already in Copilot` : ''}.`
              : `${n(d.runCopied)} copied, the most one press copies. Press again to carry on.`,
          });
          onCopied();
          return;
        }
        setProgress(`Read ${n(d.scanned)} so far, ${n(d.runCopied)} copied…`);
        if (d.rateLimited) await new Promise((r) => setTimeout(r, 5000));
      }
      setMessage({ tone: 'warn', text: 'Still going: press again to carry on.' });
    } catch {
      setMessage({ tone: 'warn', text: 'The copy stopped. Press again to carry on.' });
    } finally {
      setProgress(null);
    }
  }

  const tone: Tone =
    view.state === 'done'
      ? 'ok'
      : view.lastError
        ? 'warn'
        : view.state === 'never'
          ? 'no'
          : 'unknown';
  return (
    <StatusRow
      tone={tone}
      label={label}
      action={
        canImport ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={run}
            loading={progress !== null}
            disabled={progress !== null || view.running}
          >
            {progress !== null
              ? 'Copying'
              : view.state === 'partial'
                ? 'Carry on'
                : view.state === 'done'
                  ? text.again
                  : text.button}
          </Button>
        ) : null
      }
    >
      <p aria-live="polite">{progress ?? copySummary(kind, view)}</p>
      {message ? (
        <p
          role="status"
          className={cn(
            'mt-1',
            message.tone === 'warn' ? 'text-[var(--warn)]' : 'text-[var(--ok)]',
          )}
        >
          {message.text}
        </p>
      ) : view.lastError && !progress ? (
        <p className="mt-1 text-[var(--warn)]" suppressHydrationWarning>
          Last try {relativeTime(view.lastError.at)}: {view.lastError.message}
        </p>
      ) : null}
    </StatusRow>
  );
}

/* ------------------------------------------------------------------ tools */

function ToolsCard({
  settings,
  canEdit,
  saving,
  onChange,
}: {
  settings: AffinityExitSettings;
  canEdit: boolean;
  saving: string | null;
  onChange: (change: AffinityExitChange, busyKey: string) => Promise<boolean>;
}) {
  const [label, setLabel] = React.useState('');
  // A tick shows at once, while it saves; the saved state takes over after
  // (and a tick that failed to save springs back).
  const [ticking, setTicking] = React.useState<Readonly<Record<string, boolean>>>({});
  const tools = settings.tools.map((t) =>
    t.id in ticking ? { ...t, done: ticking[t.id] as boolean } : t,
  );
  const done = tools.filter((t) => t.done).length;
  const full = tools.length >= AFFINITY_EXIT_TOOLS_MAX;

  async function tick(id: string, value: boolean) {
    setTicking((current) => ({ ...current, [id]: value }));
    await onChange({ op: 'tick-tool', id, done: value }, `tick:${id}`);
    setTicking((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== id)));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!label.trim()) return;
    if (await onChange({ op: 'add-tool', label }, 'add-tool')) setLabel('');
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold" id="affinity-exit-tools-heading">
            Outside tools that still use Affinity
          </h3>
          {tools.length ? (
            <span className="tabular text-xs text-[var(--fg-subtle)]">
              {done} of {tools.length} done
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
          Anything with an Affinity key or connection: tick each once it no longer needs Affinity.
        </p>
        {tools.length ? (
          <ul className="mt-2" aria-labelledby="affinity-exit-tools-heading">
            {tools.map((tool) => (
              <li
                key={tool.id}
                className="flex items-center gap-2 border-b border-[var(--border)] py-1.5 last:border-b-0"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--accent)]"
                    checked={tool.done}
                    disabled={!canEdit || saving !== null}
                    onChange={(e) => void tick(tool.id, e.target.checked)}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 break-words',
                      tool.done && 'text-[var(--fg-subtle)] line-through',
                    )}
                  >
                    {tool.label}
                  </span>
                </label>
                {canEdit ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={`Remove ${tool.label}`}
                    disabled={saving !== null}
                    onClick={() =>
                      void onChange({ op: 'remove-tool', id: tool.id }, `remove:${tool.id}`)
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            Nothing listed yet.{canEdit ? ' Add each tool or person that reads from Affinity.' : ''}
          </p>
        )}
        {canEdit ? (
          <form className="mt-3 flex gap-2" onSubmit={add}>
            <Label htmlFor="affinity-exit-tool" className="sr-only">
              Tool that uses Affinity
            </Label>
            <Input
              id="affinity-exit-tool"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={full ? 'The list is full' : 'Add a tool'}
              maxLength={AFFINITY_EXIT_TOOL_LABEL_MAX}
              disabled={full}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              size="md"
              variant="secondary"
              loading={saving === 'add-tool'}
              disabled={!label.trim() || full || saving !== null}
            >
              <Plus aria-hidden="true" />
              Add
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------------- archive */

function ArchiveCard({ canArchive }: { canArchive: boolean }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <h3 className="text-sm font-semibold">Final archive</h3>
        <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
          Every list, row, company, person and note in Copilot as one ZIP of CSVs, to keep before
          Affinity is gone.
        </p>
        {canArchive ? (
          <DownloadLink
            href={CRM_EXPORT_EVERYTHING_HREF}
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-3')}
          >
            <Archive aria-hidden="true" />
            Download final archive
          </DownloadLink>
        ) : (
          <p className="mt-2 text-xs text-[var(--fg-subtle)]">
            Only the workspace owner can download the whole CRM.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
