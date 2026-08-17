'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  EyeOff,
  ExternalLink,
  FileText,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import {
  analyzeAsDealAction,
  attachEmailToDealAction,
  createDraftAction,
  ignoreMessageAction,
  openMessageAction,
  setCategoryAction,
  syncMailboxAction,
} from '@/app/actions';
import { CreateFollowUpButton } from '@/components/today/today-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { EmptyState, Notice, PlainText } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { Input, Select } from '@/components/ui/form';
import {
  EMAIL_CATEGORIES,
  EMAIL_CATEGORY_LABELS,
  type Deal,
  type EmailAttachment,
  type EmailCategory,
  type EmailMessage,
} from '@/lib/types/domain';
import { relativeTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';

export interface InboxMessageView extends EmailMessage {
  attachments: EmailAttachment[];
}

export function InboxClient({
  messages,
  deals,
  selectedId,
  mailboxConnected,
  filters,
  aiAvailable,
}: {
  messages: InboxMessageView[];
  deals: Pick<Deal, 'id' | 'company_name'>[];
  selectedId: string | null;
  mailboxConnected: boolean;
  filters: { q: string; category: string; unread: boolean; days: string };
  /** Decided on the server. Gates the three actions here that call a model. */
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = React.useState(filters.q);
  const [pending, startTransition] = React.useTransition();

  const selected = messages.find((m) => m.id === selectedId) ?? null;

  const setParam = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      router.push(`/inbox?${next.toString()}`);
    },
    [params, router],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form
            className="relative min-w-[180px] flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setParam('q', query);
            }}
          >
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email"
              aria-label="Search email"
              className="pl-8"
            />
          </form>
          <Select
            aria-label="Category"
            value={filters.category}
            onChange={(e) => setParam('category', e.target.value)}
            className="w-auto"
          >
            <option value="">All categories</option>
            {EMAIL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EMAIL_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Date range"
            value={filters.days}
            onChange={(e) => setParam('days', e.target.value)}
            className="w-auto"
          >
            <option value="">Any date</option>
            <option value="1">Last 24 hours</option>
            <option value="3">Last 3 days</option>
            <option value="7">Last week</option>
            <option value="30">Last month</option>
          </Select>
          <Button
            variant={filters.unread ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setParam('unread', filters.unread ? null : '1')}
            aria-pressed={filters.unread}
          >
            Unread
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await syncMailboxAction();
                if (result.ok) {
                  toast.success(
                    `Sync complete — ${result.data?.seen ?? 0} seen, ${result.data?.created ?? 0} new`,
                  );
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Sync failed', {
                    description: result.error?.stillUsable,
                  });
                }
              })
            }
          >
            <RefreshCw aria-hidden="true" />
            Sync
          </Button>
        </div>

        {!mailboxConnected ? (
          <Notice tone="warn" className="mb-3">
            No mailbox is connected. Connect Google Workspace in{' '}
            <Link href="/settings" className="underline">
              Settings
            </Link>{' '}
            to sync real email.
          </Notice>
        ) : null}

        {messages.length === 0 ? (
          <EmptyState
            title="No messages match"
            description="Try widening the date range, clearing the category filter, or running a sync to pull in recent mail."
            action={{ label: 'Clear filters', href: '/inbox' }}
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {messages.map((message) => (
              <li key={message.id}>
                <button
                  type="button"
                  onClick={() => setParam('message', message.id)}
                  aria-current={message.id === selectedId ? 'true' : undefined}
                  className={cn(
                    'w-full px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]',
                    message.id === selectedId && 'bg-[var(--bg-hover)]',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={cn(
                        'truncate text-sm',
                        message.is_unread ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {message.from_name ?? message.from_address}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--fg-subtle)]">
                      {relativeTime(message.sent_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm">{message.subject ?? '(no subject)'}</p>
                  <p className="mt-1 line-clamp-2 text-[13px] text-[var(--fg-muted)]">
                    {message.snippet}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge tone={message.category === 'unknown' ? 'neutral' : 'info'}>
                      {EMAIL_CATEGORY_LABELS[message.category]}
                    </Badge>
                    {message.importance !== null && message.importance >= 75 ? (
                      <Badge tone="warn">High priority</Badge>
                    ) : null}
                    {message.has_attachments ? (
                      <Badge tone="outline">
                        <Paperclip className="size-2.5" aria-hidden="true" />
                        Attachment
                      </Badge>
                    ) : null}
                    {message.injection_flagged ? (
                      <Badge tone="danger">
                        <ShieldAlert className="size-2.5" aria-hidden="true" />
                        Flagged
                      </Badge>
                    ) : null}
                    {message.linked_deal_id ? <Badge tone="ok">Linked to deal</Badge> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-w-0">
        {selected ? (
          <MessageDetail message={selected} deals={deals} aiAvailable={aiAvailable} />
        ) : (
          <Card>
            <CardContent className="pt-5">
              <p className="text-sm text-[var(--fg-muted)]">
                Select a message to read it, analyse it as a deal, or draft a reply.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function MessageDetail({
  message,
  deals,
  aiAvailable,
}: {
  message: InboxMessageView;
  deals: Pick<Deal, 'id' | 'company_name'>[];
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [draft, setDraft] = React.useState<{ subject: string; body: string } | null>(null);

  // Opening a message is what authorises fetching its full body — a routine
  // sync only ever stores metadata.
  React.useEffect(() => {
    if (message.body_text) return;
    startTransition(async () => {
      const result = await openMessageAction(message.id);
      if (result.ok) router.refresh();
    });
  }, [message.id, message.body_text, router]);

  const run = (
    fn: () => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>,
    onSuccess: (data: unknown) => void,
  ) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        onSuccess(result.data);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? 'That did not work');
      }
    });

  return (
    <Card className="lg:sticky lg:top-4">
      <CardContent className="pt-5">
        <h2 className="font-serif text-lg leading-tight font-semibold">
          {message.subject ?? '(no subject)'}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          {message.from_name ? `${message.from_name} · ` : ''}
          {message.from_address}
        </p>
        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
          {new Date(message.sent_at).toLocaleString()} · to {message.to_addresses.join(', ')}
        </p>

        {message.injection_flagged ? (
          <Notice tone="warn" className="mt-3">
            <p className="font-medium">This message contains text aimed at an AI assistant.</p>
            <p className="mt-1 text-[var(--fg-muted)]">
              It was treated as data, not instructions. Nothing in it was acted on. The full text is
              shown below so you can see exactly what was attempted.
            </p>
          </Notice>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {/* "Analyse as deal" and "Draft reply" are both model calls. Attaching
              to an existing deal, categorising, creating a task and ignoring are
              not, so they stay available with the provider switched off — the
              Inbox remains fully usable, it just stops offering to think. */}
          {aiAvailable ? (
            <Button
              size="sm"
              variant="primary"
              loading={pending}
              onClick={() =>
                run(
                  () => analyzeAsDealAction(message.id),
                  (data) => {
                    const d = data as { dealId: string; created: boolean; duplicates: number };
                    toast.success(
                      d.created ? 'Deal created and analysed' : 'Attached to existing deal',
                      {
                        description:
                          d.duplicates > 0
                            ? `${d.duplicates} possible duplicate(s) flagged for review.`
                            : undefined,
                        action: { label: 'Open', onClick: () => router.push(`/deals/${d.dealId}`) },
                      },
                    );
                  },
                )
              }
            >
              <Sparkles aria-hidden="true" />
              Analyse as deal
            </Button>
          ) : null}

          <AttachToDealButton messageId={message.id} deals={deals} />

          {aiAvailable ? (
            <Button
              size="sm"
              variant="secondary"
              loading={pending}
              onClick={() =>
                run(
                  () =>
                    createDraftAction({
                      kind: 'generic_reply',
                      emailMessageId: message.id,
                      dealId: message.linked_deal_id ?? undefined,
                    }),
                  (data) => {
                    const d = data as { subject: string; body: string };
                    setDraft(d);
                    toast.success('Draft created — not sent');
                  },
                )
              }
            >
              Draft reply
            </Button>
          ) : null}

          <CreateFollowUpButton
            emailMessageId={message.id}
            dealId={message.linked_deal_id ?? undefined}
            defaultTitle={`Reply to ${message.from_name ?? message.from_address}`}
            label="Create task"
          />

          <Button
            size="sm"
            variant="ghost"
            loading={pending}
            onClick={() =>
              run(
                () => ignoreMessageAction(message.id, !message.is_ignored),
                () => toast.success(message.is_ignored ? 'Restored' : 'Ignored'),
              )
            }
          >
            <EyeOff aria-hidden="true" />
            {message.is_ignored ? 'Un-ignore' : 'Ignore'}
          </Button>
        </div>

        {!aiAvailable ? (
          // Says why two buttons are missing. A silently shorter toolbar reads
          // as a product that never had the feature, rather than one where a
          // capability is switched off.
          <NotConfigured
            variant="inline"
            className="mt-3"
            title="Analysing and drafting are unavailable."
            description="No AI provider is connected. You can still attach this message to a deal, set its category, create a task or ignore it."
            action={{ label: 'See what is configured', href: '/diagnostics' }}
          />
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="text-xs text-[var(--fg-subtle)]" htmlFor="recategorize">
            Category
          </label>
          <Select
            id="recategorize"
            value={message.category}
            className="w-auto"
            onChange={(e) =>
              run(
                () => setCategoryAction(message.id, e.target.value as EmailCategory),
                () => toast.success('Category updated'),
              )
            }
          >
            {EMAIL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EMAIL_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          {message.category_source === 'human' ? (
            <Badge tone="outline">Set by you</Badge>
          ) : message.category_confidence !== null ? (
            <Badge tone="neutral">Model · {Math.round(message.category_confidence * 100)}%</Badge>
          ) : null}
        </div>

        {draft ? (
          <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3">
            <FieldLabel as="p">Draft — not sent</FieldLabel>
            <p className="mt-1.5 text-sm font-medium">{draft.subject}</p>
            <PlainText text={draft.body} className="mt-2 text-[var(--fg-muted)]" />
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => {
                void navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
                toast.success('Copied. Paste into your mail client to send.');
              }}
            >
              Copy draft
            </Button>
          </div>
        ) : null}

        {message.attachments.length > 0 ? (
          <div className="mt-5">
            <FieldLabel as="h3">Attachments</FieldLabel>
            <ul className="mt-2 space-y-2">
              {message.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 rounded-md border border-[var(--border)] p-2.5"
                >
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.filename}</p>
                    <p className="text-xs text-[var(--fg-subtle)]">
                      {(a.size_bytes / 1024).toFixed(0)} KB
                      {a.page_count ? ` · ${a.page_count} pages` : ''}
                      {a.extraction_confidence ? ` · ${a.extraction_confidence} confidence` : ''}
                    </p>
                    {a.needs_review ? (
                      <p className="mt-1 text-xs text-[var(--warn)]">
                        {a.extraction_error ?? 'Extraction was incomplete. Review manually.'}
                      </p>
                    ) : null}
                  </div>
                  {a.storage_path ? (
                    <Button asChild size="sm" variant="ghost">
                      <a href={`/api/files/attachment/${a.id}`} target="_blank" rel="noreferrer">
                        <ExternalLink aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <FieldLabel as="h3" className="mb-2">
            Message
          </FieldLabel>
          {message.body_text ? (
            <PlainText text={message.body_text} className="max-h-[420px] overflow-y-auto" />
          ) : (
            <p className="text-sm text-[var(--fg-subtle)] italic">
              {pending ? 'Fetching the full message…' : 'Only metadata is stored for this message.'}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AttachToDealButton({
  messageId,
  deals,
}: {
  messageId: string;
  deals: Pick<Deal, 'id' | 'company_name'>[];
}) {
  const [open, setOpen] = React.useState(false);
  const [dealId, setDealId] = React.useState(deals[0]?.id ?? '');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  if (deals.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          Attach to deal
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Attach to an existing deal"
        description="The message and any attachments become sources for that deal."
      >
        <Select aria-label="Deal" value={dealId} onChange={(e) => setDealId(e.target.value)}>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.company_name}
            </option>
          ))}
        </Select>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await attachEmailToDealAction(messageId, dealId);
                if (result.ok) {
                  toast.success('Attached to deal');
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not attach');
                }
              })
            }
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
