'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, ChevronRight, Paperclip, Send, Trash2, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Card, CardContent } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { FilterChip, FilterChipRow } from '@/components/ui/toolbar';
import { SectionHeading } from '@/components/shell/page-header';
import {
  DAILY_CAP,
  MAX_ATTACHMENT_BYTES,
  UPLOAD_CHUNK_BYTES,
  describeMinutes,
  estimatedMinutes,
  formatBytes,
} from '@/lib/campaigns/limits';
import {
  MAX_MERGE_VALUE,
  cleanMergeValue,
  contactReplacements,
  missingByField,
  type MergeValues,
  type MissingPerson,
} from '@/lib/campaigns/missing-fields';
import { parsePastedRecipients } from '@/lib/campaigns/recipients';
import {
  firstNameOf,
  parseTemplate,
  renderSubject,
  subjectIssues,
  type MergeField,
} from '@/lib/campaigns/template';
import type {
  CampaignAttachment,
  CampaignFromIdentity,
  CampaignMerge,
  CrmEntityType,
} from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { WouldCopyNote } from './campaign-copies';
import { CampaignProgress } from './campaign-progress';
import { EmailBody } from './email-preview';
import { RecipientExtras, RecipientsExtrasPanel, type ComposerExtras } from './recipient-extras';
import { WhoGetsWhat } from './who-gets-what';

export interface ListOption {
  id: string;
  name: string;
  entityType: CrmEntityType;
  entryCount: number;
  statusOptions: string[];
}

export interface ComposerRecipient {
  id: string;
  email: string;
  name: string | null;
  merge: CampaignMerge;
  /** Their photo and own CC (photos and copies; absent while those are not set up). */
  photoId?: string | null;
  photoName?: string | null;
  cc?: string[];
}

export interface ComposerCampaign {
  id: string;
  name: string;
  subject: string;
  body_template: string;
  from_identity: CampaignFromIdentity;
  attachments: CampaignAttachment[];
  track_activity: boolean;
  unsubscribe_link: boolean;
}

type Step = 'recipients' | 'message' | 'review';

const STEPS: { key: Step; label: string }[] = [
  { key: 'recipients', label: 'Recipients' },
  { key: 'message', label: 'Message' },
  { key: 'review', label: 'Review & send' },
];

const ENTITY_LABEL: Record<CrmEntityType, string> = {
  person: 'People lists',
  company: 'Company lists (their people)',
  deal: 'Deal lists (their people)',
};

interface SenderInfo {
  canSend: boolean;
  demo: boolean;
  fromAddress: string | null;
  reason: string | null;
  signatures: { nick: string | null; arwin: string | null };
}

interface AddSummary {
  added: number;
  alreadyIn: number;
  duplicates: number;
  unsubscribed: number;
  unsubscribedEmails?: string[];
  noEmail: number;
  invalid: string[];
  overLimit: number;
  total: number;
}

async function call<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, init);
    const json = (await res.json().catch(() => null)) as
      (T & { error?: { message?: string } }) | null;
    if (!res.ok || !json) {
      return { ok: false, message: json?.error?.message ?? 'That did not work. Try again.' };
    }
    return { ok: true, data: json };
  } catch {
    return { ok: false, message: 'Could not reach Copilot. Check the connection and try again.' };
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function describeAdd(s: AddSummary): string {
  const parts = [`Added ${s.added} ${s.added === 1 ? 'person' : 'people'}.`];
  const notes: string[] = [];
  if (s.alreadyIn) notes.push(`${s.alreadyIn} already on it`);
  if (s.duplicates) notes.push(`${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'}`);
  if (s.unsubscribed) notes.push(`${s.unsubscribed} unsubscribed`);
  if (s.noEmail) notes.push(`${s.noEmail} without an email`);
  if (s.invalid.length) notes.push(`${s.invalid.length} not an address`);
  if (s.overLimit) notes.push(`${s.overLimit} over the limit`);
  if (notes.length) parts.push(`Left out: ${notes.join(', ')}.`);
  const who = s.unsubscribedEmails ?? [];
  if (who.length) {
    parts.push(
      `Unsubscribed: ${who.slice(0, 3).join(', ')}${who.length > 3 ? ' and more' : ''}. To put one back, see Unsubscribed on Fund II, Campaigns.`,
    );
  }
  return parts.join(' ');
}

/**
 * Write a campaign: who it goes to, what it says, then one review screen
 * that shows exactly what will be sent and one tap to send it.
 */
export function CampaignComposer({
  campaign,
  recipients,
  lists,
  listsNote,
  me,
  timezone,
  extras = null,
}: {
  campaign: ComposerCampaign;
  recipients: ComposerRecipient[];
  lists: ListOption[];
  listsNote: string | null;
  me: string;
  /** The reader's profile timezone, passed on to the progress card. */
  timezone: string;
  /** Photos and copies; null hides them (their migration is not applied). */
  extras?: ComposerExtras | null;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>(recipients.length ? 'message' : 'recipients');
  const [started, setStarted] = React.useState(false);
  const [name, setName] = React.useState(campaign.name);
  const [subject, setSubject] = React.useState(campaign.subject);
  const [body, setBody] = React.useState(campaign.body_template);
  const [from, setFrom] = React.useState<CampaignFromIdentity>(campaign.from_identity);
  const [track, setTrack] = React.useState(campaign.track_activity);
  const [unsubscribeLink, setUnsubscribeLink] = React.useState(campaign.unsubscribe_link);
  const [saveState, setSaveState] = React.useState<'saved' | 'saving' | 'unsaved' | 'error'>(
    'saved',
  );
  const [sender, setSender] = React.useState<SenderInfo | null>(null);
  /**
   * An upload, or a recipients change, still on its way. Moving on (above all
   * to the review) waits for it: the review reads the saved campaign, and a
   * file that lands after the tap on Send is refused by the server anyway.
   */
  const [busy, setBusy] = React.useState<string | null>(null);
  const dirty = React.useRef<
    Partial<
      Record<
        | 'name'
        | 'subject'
        | 'body_template'
        | 'from_identity'
        | 'track_activity'
        | 'unsubscribe_link',
        string | boolean
      >
    >
  >({});
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => {
    let live = true;
    void call<SenderInfo>('/api/campaigns/sender').then((r) => {
      if (live && r.ok) setSender(r.data);
    });
    return () => {
      live = false;
    };
  }, []);

  const inflight = React.useRef<Promise<boolean> | null>(null);

  /** Save what changed, after any save already on its way, so the review reads the latest. */
  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    while (inflight.current) await inflight.current;
    const patch = dirty.current;
    if (!Object.keys(patch).length) return true;
    dirty.current = {};
    setSaveState('saving');
    const saving = (async () => {
      const r = await call(`/api/campaigns/${campaign.id}`, jsonInit('PATCH', patch));
      if (!r.ok) {
        dirty.current = { ...patch, ...dirty.current };
        setSaveState('error');
        toast.error(r.message);
        return false;
      }
      setSaveState(Object.keys(dirty.current).length ? 'unsaved' : 'saved');
      return true;
    })();
    inflight.current = saving;
    try {
      return await saving;
    } finally {
      inflight.current = null;
    }
  }, [campaign.id]);

  const edit = (field: keyof typeof dirty.current, value: string | boolean) => {
    dirty.current[field] = value;
    setSaveState('unsaved');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 800);
  };

  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.keys(dirty.current).length) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const go = async (next: Step) => {
    if (busy) {
      toast.error(`Wait for ${busy} to finish first.`);
      return;
    }
    if (!(await flush())) return;
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  if (started) {
    return (
      <CampaignProgress
        campaignId={campaign.id}
        initialStatus="sending"
        initialCounts={{
          total: recipients.length,
          sent: 0,
          failed: 0,
          unconfirmed: 0,
          skipped: 0,
          pending: recipients.length,
        }}
        autoStart
        timezone={timezone}
      />
    );
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Campaign steps">
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((s, i) => {
            const current = s.key === step;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  aria-current={current ? 'step' : undefined}
                  aria-disabled={busy !== null && !current ? true : undefined}
                  onClick={() => void go(s.key)}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm sm:min-h-10',
                    current
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--fg)]'
                      : 'border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span aria-hidden="true" className="tabular text-xs text-[var(--fg-subtle)]">
                    {i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === 'recipients' ? (
        <RecipientsStep
          campaignId={campaign.id}
          recipients={recipients}
          lists={lists}
          listsNote={listsNote}
          onDone={() => void go('message')}
          refresh={() => router.refresh()}
          onBusy={setBusy}
          extras={extras}
        />
      ) : step === 'message' ? (
        <MessageStep
          campaign={campaign}
          recipients={recipients}
          name={name}
          subject={subject}
          body={body}
          from={from}
          track={track}
          unsubscribeLink={unsubscribeLink}
          sender={sender}
          saveState={saveState}
          busy={busy}
          me={me}
          extras={extras}
          onBusy={setBusy}
          onTrack={(v) => {
            setTrack(v);
            edit('track_activity', v);
          }}
          onUnsubscribeLink={(v) => {
            setUnsubscribeLink(v);
            edit('unsubscribe_link', v);
          }}
          onName={(v) => {
            setName(v);
            edit('name', v);
          }}
          onSubject={(v) => {
            setSubject(v);
            edit('subject', v);
          }}
          onBody={(v) => {
            setBody(v);
            edit('body_template', v);
          }}
          onFrom={(v) => {
            setFrom(v);
            edit('from_identity', v);
          }}
          flush={flush}
          refresh={() => router.refresh()}
          onBack={() => void go('recipients')}
          onDone={() => void go('review')}
        />
      ) : (
        <ReviewStep
          campaignId={campaign.id}
          sender={sender}
          onEdit={(s) => void go(s)}
          onStarted={() => setStarted(true)}
          onRecipientsChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- recipients */

function RecipientsStep({
  campaignId,
  recipients,
  lists,
  listsNote,
  onDone,
  refresh,
  onBusy,
  extras,
}: {
  campaignId: string;
  recipients: ComposerRecipient[];
  lists: ListOption[];
  listsNote: string | null;
  onDone: () => void;
  refresh: () => void;
  onBusy: (what: string | null) => void;
  extras: ComposerExtras | null;
}) {
  const [listId, setListId] = React.useState(lists[0]?.id ?? '');
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [paste, setPaste] = React.useState('');
  const [busy, setBusyHere] = React.useState<'list' | 'paste' | 'remove' | null>(null);
  const setBusy = (what: 'list' | 'paste' | 'remove' | null) => {
    setBusyHere(what);
    onBusy(what ? 'the recipients change' : null);
  };
  const [showAll, setShowAll] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const list = lists.find((l) => l.id === listId) ?? null;
  const pasted = React.useMemo(() => parsePastedRecipients(paste), [paste]);

  const add = async (source: 'list' | 'paste') => {
    setBusy(source);
    const r = await call<{ summary: AddSummary }>(
      `/api/campaigns/${campaignId}/recipients`,
      jsonInit('POST', source === 'list' ? { source, listId, statuses } : { source, text: paste }),
    );
    setBusy(null);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success(describeAdd(r.data.summary));
    if (source === 'paste') setPaste('');
    refresh();
  };

  const remove = async (body: { ids: string[] } | { all: true }) => {
    setBusy('remove');
    const r = await call(`/api/campaigns/${campaignId}/recipients`, jsonInit('DELETE', body));
    setBusy(null);
    if (!r.ok) toast.error(r.message);
    refresh();
  };

  const groups = (['person', 'company', 'deal'] as const)
    .map((type) => ({ type, lists: lists.filter((l) => l.entityType === type) }))
    .filter((g) => g.lists.length);
  const shown = showAll ? recipients : recipients.slice(0, 50);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 pt-4">
            <h2 className="font-serif text-base font-semibold">From a list</h2>
            {listsNote ? (
              <p className="text-sm text-[var(--fg-muted)]">{listsNote}</p>
            ) : lists.length === 0 ? (
              <p className="text-sm text-[var(--fg-muted)]">
                No lists yet. Import them from Affinity on Lists, or paste addresses.
              </p>
            ) : (
              <>
                <Field label="List" htmlFor="campaign-list">
                  <Select
                    id="campaign-list"
                    value={listId}
                    onChange={(e) => {
                      setListId(e.target.value);
                      setStatuses([]);
                    }}
                  >
                    {groups.map((g) => (
                      <optgroup key={g.type} label={ENTITY_LABEL[g.type]}>
                        {g.lists.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name} ({l.entryCount})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                {list?.statusOptions.length ? (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">
                      Status{' '}
                      <span className="font-normal text-[var(--fg-muted)]">
                        (none picked = everyone)
                      </span>
                    </p>
                    <FilterChipRow aria-label="Only these statuses" className="flex-wrap">
                      {list.statusOptions.map((s) => (
                        <FilterChip
                          key={s}
                          label={s}
                          pressed={statuses.includes(s)}
                          onToggle={() =>
                            setStatuses((cur) =>
                              cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
                            )
                          }
                        />
                      ))}
                    </FilterChipRow>
                  </div>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={() => void add('list')}
                  loading={busy === 'list'}
                  disabled={!listId || busy !== null}
                >
                  <Users aria-hidden="true" />
                  Add people from this list
                </Button>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 pt-4">
            <h2 className="font-serif text-base font-semibold">Paste addresses</h2>
            <Field
              label="Email addresses"
              htmlFor="campaign-paste"
              hint="One per line, or separated by commas. Jane Doe <jane@example.com> keeps the name."
            >
              <Textarea
                id="campaign-paste"
                aria-describedby="campaign-paste-hint"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={5}
                placeholder={'jane@example.com\nSam Lee <sam@example.com>'}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                onClick={() => void add('paste')}
                loading={busy === 'paste'}
                disabled={!pasted.recipients.length || busy !== null}
              >
                Add {pasted.recipients.length || ''} pasted
              </Button>
              {pasted.invalid.length ? (
                <span className="text-xs text-[var(--warn)]">
                  Not an address: {pasted.invalid.slice(0, 2).join(', ')}
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="recipients-heading">
        <SectionHeading
          count={recipients.length}
          action={
            recipients.length ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={async () => {
                  const yes = await confirm({
                    title: `Remove all ${recipients.length} recipients?`,
                    confirmLabel: 'Remove all',
                    tone: 'danger',
                  });
                  if (yes) void remove({ all: true });
                }}
              >
                Remove all
              </Button>
            ) : null
          }
        >
          <span id="recipients-heading">Recipients</span>
        </SectionHeading>
        {recipients.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">
            Nobody yet. Add people from a list or paste addresses.
          </p>
        ) : (
          <>
            <ul
              aria-label="Recipients"
              className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]"
            >
              {shown.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.name ?? r.email}</p>
                    <p className="truncate text-xs text-[var(--fg-muted)]">
                      {r.name ? r.email : null}
                      {r.merge.company ? `${r.name ? ' · ' : ''}${r.merge.company}` : null}
                    </p>
                  </div>
                  {extras ? (
                    <RecipientExtras
                      campaignId={campaignId}
                      recipient={r}
                      photos={extras.photos}
                      disabled={busy !== null}
                      onChange={refresh}
                      onBusy={onBusy}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${r.email}`}
                    disabled={busy !== null}
                    onClick={() => void remove({ ids: [r.id] })}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
            {recipients.length > shown.length ? (
              <Button
                variant="link"
                size="sm"
                className="mt-2 px-0"
                onClick={() => setShowAll(true)}
              >
                Show all {recipients.length}
              </Button>
            ) : null}
          </>
        )}
      </section>

      {extras && recipients.length ? (
        <RecipientsExtrasPanel
          campaignId={campaignId}
          extras={extras}
          recipients={recipients}
          onChange={refresh}
          onBusy={onBusy}
        />
      ) : null}

      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone} disabled={!recipients.length || busy !== null}>
          Next: the message
        </Button>
      </div>
      {confirmDialog}
    </div>
  );
}

/* ----------------------------------------------------------------- message */

const MERGE_BUTTONS: { field: MergeField; label: string }[] = [
  { field: 'first_name', label: 'First name' },
  { field: 'name', label: 'Full name' },
  { field: 'company', label: 'Company' },
];

function MessageStep({
  campaign,
  recipients,
  name,
  subject,
  body,
  from,
  track,
  unsubscribeLink,
  sender,
  saveState,
  busy,
  me,
  extras,
  onBusy,
  onTrack,
  onUnsubscribeLink,
  onName,
  onSubject,
  onBody,
  onFrom,
  flush,
  refresh,
  onBack,
  onDone,
}: {
  campaign: ComposerCampaign;
  recipients: ComposerRecipient[];
  name: string;
  subject: string;
  body: string;
  from: CampaignFromIdentity;
  track: boolean;
  unsubscribeLink: boolean;
  sender: SenderInfo | null;
  saveState: 'saved' | 'saving' | 'unsaved' | 'error';
  busy: string | null;
  me: string;
  extras: ComposerExtras | null;
  onBusy: (what: string | null) => void;
  onTrack: (v: boolean) => void;
  onUnsubscribeLink: (v: boolean) => void;
  onName: (v: string) => void;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  onFrom: (v: CampaignFromIdentity) => void;
  flush: () => Promise<boolean>;
  refresh: () => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const [previewId, setPreviewId] = React.useState(recipients[0]?.id ?? '');
  const [testing, setTesting] = React.useState(false);
  const parsed = React.useMemo(() => parseTemplate(body), [body]);
  const issues = [...subjectIssues(subject), ...parsed.issues];
  const sample = recipients.find((r) => r.id === previewId) ?? recipients[0] ?? null;
  const merge = sample ? { ...(sample.name ? { name: sample.name } : {}), ...sample.merge } : null;
  const signature = sender?.signatures[from] ?? null;

  const insert = (field: MergeField) => {
    const el = bodyRef.current;
    const tag = `{{${field}}}`;
    if (!el) {
      onBody(body + tag);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + tag + body.slice(end);
    onBody(next);
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  const sendTest = async () => {
    if (!(await flush())) return;
    setTesting(true);
    const r = await call<{ to: string; demo: boolean; photo?: string | null }>(
      `/api/campaigns/${campaign.id}/test`,
      jsonInit('POST', { recipientId: sample?.id ?? null }),
    );
    setTesting(false);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    const photo = r.data.photo ? ` It carries ${r.data.photo}.` : '';
    toast.success(
      r.data.demo
        ? `Demo: a test to ${r.data.to} was made, but nothing leaves the demo.${photo}`
        : `Test sent to ${r.data.to}.${photo}`,
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Field label="Campaign name" htmlFor="campaign-name" hint="Only you see this.">
          <Input
            id="campaign-name"
            aria-describedby="campaign-name-hint"
            value={name}
            maxLength={300}
            onChange={(e) => onName(e.target.value)}
          />
        </Field>
        <Field label="Subject" htmlFor="campaign-subject">
          <Input
            id="campaign-subject"
            value={subject}
            maxLength={300}
            onChange={(e) => onSubject(e.target.value)}
            placeholder="TipTop Q3 update"
          />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Signature</legend>
          <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
            {(['nick', 'arwin'] as CampaignFromIdentity[]).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={from === s}
                onClick={() => onFrom(s)}
                className={cn(
                  'min-h-9 rounded px-3 text-sm',
                  from === s
                    ? 'bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                    : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {s === 'nick' ? 'Nick' : 'Arwin'}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--fg-muted)]">
            Sent from {sender?.fromAddress ?? 'the connected mailbox'} either way, signed{' '}
            {from === 'nick' ? "with Nick's Gmail signature" : 'as Arwin'}.
          </p>
        </fieldset>
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <label htmlFor="campaign-body" className="text-sm font-medium">
              Email
            </label>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Insert a merge field">
              {MERGE_BUTTONS.map((b) => (
                <Button
                  key={b.field}
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => insert(b.field)}
                >
                  + {b.label}
                </Button>
              ))}
            </div>
          </div>
          <Textarea
            id="campaign-body"
            ref={bodyRef}
            aria-describedby="campaign-body-hint"
            value={body}
            onChange={(e) => onBody(e.target.value)}
            rows={14}
            placeholder={'Hi {{first_name|there}},\n\nHere is our Q3 update...'}
          />
          <p id="campaign-body-hint" className="text-xs text-[var(--fg-muted)]">
            A blank line between paragraphs. **bold**, *italic*, [link text](https://…), and lines
            starting “- ” for a list. A fallback for an empty field: {'{{first_name|there}}'}. A
            link written out as an address always goes straight there, untracked.
          </p>
        </div>
        <fieldset className="space-y-3 rounded-md border border-[var(--border)] p-3">
          <legend className="px-1 text-sm font-medium">Tracking and unsubscribe</legend>
          <div className="flex items-start gap-3">
            <Switch
              id="campaign-track"
              checked={track}
              onCheckedChange={(v) => onTrack(v === true)}
              aria-describedby="campaign-track-hint"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <label htmlFor="campaign-track" className="text-sm font-medium">
                Track opens and clicks
              </label>
              <p id="campaign-track-hint" className="text-xs text-[var(--fg-muted)]">
                Adds an invisible image, and sends links with their own text through Copilot to
                count clicks (so they depend on Copilot being up). Off: a plain email; replies are
                still tracked.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch
              id="campaign-unsubscribe"
              checked={unsubscribeLink}
              onCheckedChange={(v) => onUnsubscribeLink(v === true)}
              aria-describedby="campaign-unsubscribe-hint"
              className="mt-0.5"
            />
            <div className="min-w-0">
              <label htmlFor="campaign-unsubscribe" className="text-sm font-medium">
                Add an unsubscribe link
              </label>
              <p id="campaign-unsubscribe-hint" className="text-xs text-[var(--fg-muted)]">
                A small line at the bottom, and the header mail apps turn into their own Unsubscribe
                button. For offerings or news sent to people who did not ask for them; leave it off
                for LP updates, which then read as a personal email.
              </p>
            </div>
          </div>
        </fieldset>
        {issues.length ? (
          <Notice tone="warn">
            <ul className="space-y-0.5">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <Attachments
          campaignId={campaign.id}
          initial={campaign.attachments}
          onChange={refresh}
          onBusy={onBusy}
        />
        <p className="text-xs text-[var(--fg-subtle)]" aria-live="polite">
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'unsaved'
              ? 'Unsaved changes'
              : saveState === 'error'
                ? 'Not saved — check the connection'
                : 'Saved'}
        </p>
      </div>

      <section aria-labelledby="preview-heading" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="preview-heading" className="font-serif text-base font-semibold">
            Preview
          </h2>
          {recipients.length ? (
            <Select
              aria-label="Preview as"
              value={sample?.id ?? ''}
              onChange={(e) => setPreviewId(e.target.value)}
              className="w-auto max-w-60"
            >
              {recipients.slice(0, 200).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name ?? r.email}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <Card>
          <CardContent className="space-y-3 pt-4">
            <p className="text-xs text-[var(--fg-subtle)]">
              To{' '}
              {sample
                ? sample.name
                  ? `${sample.name} <${sample.email}>`
                  : sample.email
                : '(no recipients yet)'}
            </p>
            <p className="font-medium break-words">
              {renderSubject(subject, merge) || (
                <span className="text-[var(--fg-subtle)] italic">No subject</span>
              )}
            </p>
            {parsed.blocks.length ? (
              <EmailBody blocks={parsed.blocks} merge={merge} />
            ) : (
              <p className="text-sm text-[var(--fg-subtle)] italic">Nothing written yet.</p>
            )}
            <SignaturePreview text={signature} from={from} unsubscribe={unsubscribeLink} />
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void sendTest()}
            loading={testing}
            disabled={!body.trim() || busy !== null}
          >
            <Send aria-hidden="true" />
            Send test to me
          </Button>
          <span className="text-xs text-[var(--fg-muted)]">
            Goes to {me} only, marked [Test], with the same links as the real one (they count
            nothing).
          </span>
        </div>
        {extras && sample ? <WouldCopyNote copies={extras.copies} recipient={sample} /> : null}
      </section>

      <div className="flex justify-between gap-2 lg:col-span-2">
        <Button variant="ghost" onClick={onBack} disabled={busy !== null}>
          Back
        </Button>
        <Button variant="primary" onClick={onDone} disabled={busy !== null}>
          {busy ? 'Uploading…' : 'Next: review'}
        </Button>
      </div>
    </div>
  );
}

function SignaturePreview({
  text,
  from,
  unsubscribe,
}: {
  text: string | null;
  from: CampaignFromIdentity;
  unsubscribe: boolean;
}) {
  return (
    <div className="border-t border-[var(--border)] pt-2 text-xs whitespace-pre-line text-[var(--fg-muted)]">
      {text ??
        (from === 'nick'
          ? "Nick's Gmail signature (read from Gmail when sending)"
          : 'Arwin’s signature')}
      {unsubscribe ? (
        <p className="mt-2 text-[var(--fg-subtle)]">
          If you would rather not get these emails, unsubscribe.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- attachments */

function Attachments({
  campaignId,
  initial,
  onChange,
  onBusy,
}: {
  campaignId: string;
  initial: CampaignAttachment[];
  onChange: () => void;
  /** Tells the composer an upload is under way, so it holds the review until it lands. */
  onBusy: (what: string | null) => void;
}) {
  // Local from here on: every upload and removal answers with the full list.
  const [items, setItems] = React.useState(initial);
  const [uploading, setUploading] = React.useState<{ name: string; done: number } | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Aborted if this step goes away mid-upload: no piece is sent after that. */
  const abort = React.useRef<AbortController | null>(null);
  const used = items.reduce((sum, a) => sum + a.size, 0);

  React.useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
      onBusy(null);
    },
    [onBusy],
  );

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const controller = new AbortController();
    abort.current = controller;
    onBusy('the upload');
    let total = used;
    for (const file of Array.from(files)) {
      if (controller.signal.aborted) break;
      if (total + file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(
          `${file.name} would take attachments over ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        );
        continue;
      }
      const uploadId = crypto.randomUUID();
      const count = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
      let failed: string | null = null;
      for (let index = 0; index < count && !failed; index++) {
        if (controller.signal.aborted) break;
        setUploading({ name: file.name, done: Math.round((index / count) * 100) });
        const piece = file.slice(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
        const r = await call<{ complete: boolean; attachments: CampaignAttachment[] }>(
          `/api/campaigns/${campaignId}/attachments`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-upload-id': uploadId,
              'x-chunk-index': String(index),
              'x-chunk-count': String(count),
              'x-file-name': encodeURIComponent(file.name),
              'x-file-type': file.type || 'application/octet-stream',
              'x-file-size': String(file.size),
            },
            body: piece,
          },
        );
        if (controller.signal.aborted) break;
        if (!r.ok) failed = r.message;
        else if (r.data.complete) setItems(r.data.attachments);
      }
      if (failed) toast.error(failed);
      else total += file.size;
    }
    if (controller.signal.aborted) return;
    abort.current = null;
    setUploading(null);
    onBusy(null);
    if (inputRef.current) inputRef.current.value = '';
    onChange();
  };

  const remove = async (id: string) => {
    setRemoving(id);
    onBusy('the attachment removal');
    const r = await call<{ attachments: CampaignAttachment[] }>(
      `/api/campaigns/${campaignId}/attachments?attachment=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    setRemoving(null);
    onBusy(null);
    if (!r.ok) toast.error(r.message);
    else setItems(r.data.attachments);
    onChange();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Attachments</p>
        <span className="text-xs text-[var(--fg-muted)]">
          {formatBytes(used)} of {formatBytes(MAX_ATTACHMENT_BYTES)}
        </span>
      </div>
      {items.length ? (
        <ul className="space-y-1" aria-label="Attachments">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm">
              <Paperclip className="size-3.5 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span className="text-xs text-[var(--fg-subtle)]">{formatBytes(a.size)}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${a.name}`}
                loading={removing === a.id}
                disabled={uploading !== null || removing !== null}
                onClick={() => void remove(a.id)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        id="campaign-files"
        aria-label="Attach files"
        tabIndex={-1}
        onChange={(e) => void upload(e.target.files)}
      />
      <Button
        variant="secondary"
        size="sm"
        loading={uploading !== null}
        disabled={removing !== null}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? null : <Paperclip aria-hidden="true" />}
        {uploading ? `Uploading ${uploading.name} (${uploading.done}%)` : 'Attach a file'}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ review */

interface ReviewData {
  version: string;
  recipientCount: number;
  issues: string[];
  fallbacks: { field: MergeField; count: number }[];
  /** Who has no value for a field the email uses: listed under each fallback line. */
  missing: MissingPerson[];
  attachmentBytes: number;
  subject: string;
  body_template: string;
  from_identity: CampaignFromIdentity;
  track_activity: boolean;
  unsubscribe_link: boolean;
  /** The host the email's Copilot links go through, when it has any. */
  linkHost: string | null;
  attachments: { id: string; name: string; size: number; type: string }[];
  status: string;
  sample: { email: string; name: string | null; merge: CampaignMerge } | null;
}

const FIELD_LABEL: Record<MergeField, string> = {
  first_name: 'a first name',
  name: 'a name',
  company: 'a company',
};

interface FillResponse {
  filled: MergeField[];
  contact:
    | { status: 'skipped' | 'not_linked' | 'unchanged' }
    | { status: 'saved'; fields: string[] }
    | { status: 'failed'; message: string };
}

function ReviewStep({
  campaignId,
  sender,
  onEdit,
  onStarted,
  onRecipientsChanged,
}: {
  campaignId: string;
  sender: SenderInfo | null;
  onEdit: (step: Step) => void;
  onStarted: () => void;
  /** A recipient's merge values changed here, so the composer's own copy is stale. */
  onRecipientsChanged: () => void;
}) {
  const [review, setReview] = React.useState<ReviewData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [readCount, setReadCount] = React.useState(0);
  /** Fills on their way: Send waits, since each one moves the version the review must echo. */
  const [filling, setFilling] = React.useState(0);

  const read = React.useCallback(
    () => call<{ review: ReviewData }>(`/api/campaigns/${campaignId}/review`),
    [campaignId],
  );

  // Always read from the server: the review shows the saved campaign, not this page's copy.
  React.useEffect(() => {
    let live = true;
    void read().then((r) => {
      if (!live) return;
      if (r.ok) {
        setReview(r.data.review);
        setError(null);
      } else {
        setError(r.message);
      }
    });
    return () => {
      live = false;
    };
  }, [read, readCount]);

  const load = () => {
    setError(null);
    setReadCount((n) => n + 1);
  };

  /**
   * Fills go one at a time: each reads the person's merge as the last one
   * left it, so a second save for the same person (from another line) never
   * writes over the first.
   */
  const fillQueue = React.useRef<Promise<unknown>>(Promise.resolve());

  /** Rows with something typed and not saved: Send waits, so nothing typed is left out unseen. */
  const [unsaved, setUnsaved] = React.useState<ReadonlySet<string>>(() => new Set());
  const onTyped = React.useCallback((row: string, typed: boolean) => {
    setUnsaved((cur) => {
      if (cur.has(row) === typed) return cur;
      const next = new Set(cur);
      if (typed) next.add(row);
      else next.delete(row);
      return next;
    });
  }, []);

  /** Save what someone typed for one person, then read the review again: new counts and version. */
  const fill = (
    person: MissingPerson,
    values: MergeValues,
    saveToContact: boolean,
  ): Promise<boolean> => {
    setFilling((n) => n + 1);
    const run = fillQueue.current.then(() => fillNow(person, values, saveToContact));
    fillQueue.current = run.catch(() => undefined);
    return run.finally(() => setFilling((n) => n - 1));
  };

  const fillNow = async (
    person: MissingPerson,
    values: MergeValues,
    saveToContact: boolean,
  ): Promise<boolean> => {
    const r = await call<FillResponse>(
      `/api/campaigns/${campaignId}/recipients`,
      jsonInit('PATCH', { recipientId: person.id, values, saveToContact }),
    );
    if (r.ok) {
      const who = person.name ?? person.email;
      const { contact, filled } = r.data;
      if (contact.status === 'failed') {
        toast.warning(`Saved for this campaign, but not on their contact: ${contact.message}`);
      } else {
        toast.success(
          !filled.length
            ? `${who} already had that filled in.`
            : contact.status === 'saved'
              ? `Saved for ${who}, and on their contact.`
              : contact.status === 'unchanged'
                ? `Saved for ${who}. Their contact already had it.`
                : `Saved for ${who}.`,
        );
      }
      onRecipientsChanged();
    } else {
      toast.error(r.message);
    }
    const fresh = await read();
    if (fresh.ok) setReview(fresh.data.review);
    else setError(fresh.message);
    return r.ok;
  };

  if (error) {
    return (
      <Notice tone="warn">
        <p>{error}</p>
        <Button variant="secondary" size="sm" className="mt-2" onClick={load}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (!review) return <p className="text-sm text-[var(--fg-muted)]">Reading the campaign…</p>;

  const parsed = parseTemplate(review.body_template);
  const merge = review.sample
    ? { ...(review.sample.name ? { name: review.sample.name } : {}), ...review.sample.merge }
    : null;
  const minutes = estimatedMinutes(review.recipientCount);
  const people = `${review.recipientCount} ${review.recipientCount === 1 ? 'person' : 'people'}`;
  const blocked = review.issues.length > 0 || !sender?.canSend || filling > 0 || unsaved.size > 0;
  const missingGroups = missingByField(
    review.fallbacks.map((f) => f.field),
    review.missing ?? [],
  );

  const confirm = async () => {
    setSending(true);
    const r = await call(
      `/api/campaigns/${campaignId}/confirm`,
      jsonInit('POST', {
        version: review.version,
        recipients: review.recipientCount,
        subject: review.subject,
        from: review.from_identity,
        track: review.track_activity,
        unsubscribe: review.unsubscribe_link,
      }),
    );
    if (!r.ok) {
      setSending(false);
      toast.error(r.message);
      load();
      return;
    }
    onStarted();
  };

  return (
    <section aria-labelledby="review-heading" className="space-y-5">
      <h2 id="review-heading" className="font-serif text-xl font-semibold">
        Send to {people}?
      </h2>
      <Card>
        <CardContent className="pt-4">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-[var(--fg-muted)]">Recipients</dt>
            <dd>
              <span className="font-semibold">{people}</span>, one email each{' '}
              <Button
                variant="link"
                size="sm"
                className="h-auto px-1"
                onClick={() => onEdit('recipients')}
              >
                Change
              </Button>
            </dd>
            <dt className="text-[var(--fg-muted)]">From</dt>
            <dd className="break-words">
              {sender?.fromAddress ?? '…'} · signed{' '}
              {review.from_identity === 'nick' ? "with Nick's Gmail signature" : 'as Arwin'}
            </dd>
            <dt className="text-[var(--fg-muted)]">Subject</dt>
            <dd className="font-medium break-words">{review.subject || '(none)'}</dd>
            <dt className="text-[var(--fg-muted)]">Attachments</dt>
            <dd>
              {review.attachments.length
                ? review.attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(', ')
                : 'None'}
            </dd>
            <dt className="text-[var(--fg-muted)]">Tracking</dt>
            <dd>
              {review.track_activity
                ? `Opens and clicks${review.linkHost ? `, through ${review.linkHost}` : ''}`
                : 'Off: replies only'}
            </dd>
            <dt className="text-[var(--fg-muted)]">Unsubscribe</dt>
            <dd>{review.unsubscribe_link ? 'Link and header included' : 'None'}</dd>
          </dl>
        </CardContent>
      </Card>

      <WhoGetsWhat campaignId={campaignId} version={review.version} />

      {review.sample ? (
        <section aria-labelledby="sample-heading" className="space-y-2">
          <h3 id="sample-heading" className="text-sm font-medium">
            Sample: the email {review.sample.name ?? review.sample.email} gets
          </h3>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <p className="text-xs text-[var(--fg-subtle)]">To {review.sample.email}</p>
              <p className="font-medium break-words">{renderSubject(review.subject, merge)}</p>
              <EmailBody blocks={parsed.blocks} merge={merge} />
              <SignaturePreview
                text={sender?.signatures[review.from_identity] ?? null}
                from={review.from_identity}
                unsubscribe={review.unsubscribe_link}
              />
            </CardContent>
          </Card>
        </section>
      ) : null}

      {missingGroups.length ? (
        <Notice>
          <div className="space-y-1">
            {missingGroups.map((g) => (
              <MissingFieldLine
                key={g.field}
                field={g.field}
                people={g.people}
                onSave={fill}
                onTyped={onTyped}
              />
            ))}
          </div>
        </Notice>
      ) : null}

      {review.issues.length ? (
        <Notice tone="warn">
          <p className="font-medium">Fix these before sending:</p>
          <ul className="mt-1 list-disc pl-5">
            {review.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {sender && !sender.canSend ? (
        <Notice tone="warn">
          <p>{sender.reason ?? 'Sending is not turned on for this mailbox.'}</p>
        </Notice>
      ) : null}

      <p className="text-sm text-[var(--fg-muted)]">
        Sends about one email every 2 seconds, so this takes {describeMinutes(minutes)}. Keep this
        page open while it sends: leaving it pauses the campaign. You can pause or cancel at any
        time.
        {review.recipientCount > DAILY_CAP
          ? ` At most ${DAILY_CAP} go out in 24 hours; the rest wait until the next day.`
          : ''}
        {sender?.demo ? ' Demo: nothing actually leaves the app.' : ''}
      </p>
      {unsaved.size ? (
        <p className="text-sm text-[var(--warn)]">
          Save or clear what you typed for the people above before sending.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => onEdit('message')}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => void confirm()}
          loading={sending}
          disabled={blocked}
        >
          {sending ? null : <Check aria-hidden="true" />}
          Send to {people}
        </Button>
      </div>
      {review.status !== 'draft' ? <Badge tone="warn">This campaign already started.</Badge> : null}
    </section>
  );
}

/* ---------------------------------------------------- missing merge fields */

const INPUT_LABEL: Record<MergeField, string> = {
  first_name: 'First name',
  name: 'Full name',
  company: 'Company',
};

/** People listed open at once under a line; the rest behind "Show all". */
const MISSING_SHOWN = 25;

type SaveFill = (
  person: MissingPerson,
  values: MergeValues,
  saveToContact: boolean,
) => Promise<boolean>;

/** A row reporting whether it holds typed values not saved yet. */
type OnTyped = (row: string, typed: boolean) => void;

/**
 * One "N people have no …" line, opening to who they are, each with inputs
 * for what they lack. A person drops off once the line's field is filled;
 * anyone left empty still sees the fallback.
 */
function MissingFieldLine({
  field,
  people,
  onSave,
  onTyped,
}: {
  field: MergeField;
  people: MissingPerson[];
  onSave: SaveFill;
  onTyped: OnTyped;
}) {
  const [open, setOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const panelId = React.useId();
  const noun = FIELD_LABEL[field].replace(/^an? /, '');
  const shown = showAll ? people : people.slice(0, MISSING_SHOWN);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 flex min-h-8 w-full items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-[var(--bg-hover)]"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)] transition-transform',
            open && 'rotate-90',
          )}
        />
        <span>
          {people.length} {people.length === 1 ? 'person has' : 'people have'} no {noun} on file and
          will see the fallback for {`{{${field}}}`}.
        </span>
      </button>
      <div id={panelId} hidden={!open}>
        <ul
          aria-label={`People with no ${noun}`}
          className="mt-1.5 mb-1 divide-y divide-[var(--border)] rounded-md border border-[var(--border)] bg-[var(--bg-raised)]"
        >
          {shown.map((p) => (
            <MissingPersonRow key={p.id} person={p} onSave={onSave} onTyped={onTyped} />
          ))}
        </ul>
        {people.length > shown.length ? (
          <Button variant="link" size="sm" className="px-0" onClick={() => setShowAll(true)}>
            Show all {people.length}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** One person's missing values: Save (or Enter) fills them in for this campaign. */
function MissingPersonRow({
  person,
  onSave,
  onTyped,
}: {
  person: MissingPerson;
  onSave: SaveFill;
  onTyped: OnTyped;
}) {
  const [values, setValues] = React.useState<MergeValues>({});
  const [toContact, setToContact] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const id = React.useId();
  const who = person.name ?? person.email;
  // A contact holds a full name and a company; a first name stays with the campaign.
  const linkable =
    person.contact !== null && person.lacks.some((f) => f === 'name' || f === 'company');
  const typed = person.lacks.some((f) => cleanMergeValue(values[f]));
  const replaces = linkable && toContact ? contactReplacements(person.contact, values) : [];

  React.useEffect(() => {
    onTyped(id, typed);
  }, [id, typed, onTyped]);
  // A row that goes (its person filled, or the line gone) holds nothing unsaved.
  React.useEffect(() => () => onTyped(id, false), [id, onTyped]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!typed || saving) return;
    setSaving(true);
    const picked: MergeValues = {};
    for (const f of person.lacks) if (cleanMergeValue(values[f])) picked[f] = values[f];
    const saved = await onSave(person, picked, linkable && toContact);
    setSaving(false);
    if (saved) setValues({});
  };

  return (
    <li className="space-y-2 px-3 py-2.5">
      <p className="text-sm break-words">
        <span className="font-medium">{who}</span>
        {person.name ? <span className="text-[var(--fg-muted)]"> · {person.email}</span> : null}
      </p>
      <form onSubmit={(e) => void submit(e)} aria-label={`Fill in ${who}`} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          {person.lacks.map((f) => (
            <div key={f} className="min-w-36 flex-1 space-y-1">
              <label htmlFor={`${id}-${f}`} className="block text-xs text-[var(--fg-muted)]">
                {INPUT_LABEL[f]}
              </label>
              <Input
                id={`${id}-${f}`}
                value={values[f] ?? ''}
                maxLength={MAX_MERGE_VALUE}
                autoComplete="off"
                // A full name typed already fills the first name, unless one is typed here.
                placeholder={f === 'first_name' ? firstNameOf(values.name) || undefined : undefined}
                onChange={(e) => setValues((cur) => ({ ...cur, [f]: e.target.value }))}
              />
            </div>
          ))}
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={saving}
            disabled={!typed || saving}
          >
            Save
          </Button>
        </div>
        {linkable ? (
          <div className="space-y-0.5">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--accent)]"
                checked={toContact}
                onChange={(e) => setToContact(e.target.checked)}
              />
              Also save to their contact
            </label>
            {replaces.length ? (
              <p className="text-xs text-[var(--warn)]">
                Replaces{' '}
                {replaces
                  .map((r) => `${r.field === 'name' ? 'the name' : 'the company'} “${r.from}”`)
                  .join(' and ')}{' '}
                on their contact.
              </p>
            ) : null}
          </div>
        ) : null}
      </form>
    </li>
  );
}
