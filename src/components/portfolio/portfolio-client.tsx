'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Plus, Upload, X } from 'lucide-react';
import {
  classifyPortfolioEmailAction,
  createDraftAction,
  createPortfolioAction,
  importPortfolioCsvAction,
  setPortfolioUpdateStatusAction,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { PlainText } from '@/components/ui/feedback';
import { Badge } from '@/components/ui/badge';

export function AddPortfolioButton() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [website, setWebsite] = React.useState('');
  const [stage, setStage] = React.useState('');
  const [metrics, setMetrics] = React.useState('');
  const [contactName, setContactName] = React.useState('');
  const [contactEmail, setContactEmail] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus aria-hidden="true" />
          Add company
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Add a portfolio company"
        description="Only what you enter is stored. Nothing is inferred or looked up."
      >
        <div className="space-y-4">
          <Field label="Company" htmlFor="pc-name">
            <Input id="pc-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Website"
            htmlFor="pc-site"
            hint="Used to link incoming email to this company."
          >
            <Input
              id="pc-site"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://"
            />
          </Field>
          <Field label="Current stage" htmlFor="pc-stage">
            <Input
              id="pc-stage"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              placeholder="Seed"
            />
          </Field>
          <Field label="Key metrics" htmlFor="pc-metrics">
            <Textarea
              id="pc-metrics"
              value={metrics}
              onChange={(e) => setMetrics(e.target.value)}
              rows={2}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Founder" htmlFor="pc-contact">
              <Input
                id="pc-contact"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </Field>
            <Field label="Founder email" htmlFor="pc-email">
              <Input
                id="pc-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!name.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await createPortfolioAction({
                  name,
                  website: website || undefined,
                  currentStage: stage || undefined,
                  keyMetrics: metrics || undefined,
                  contactName: contactName || undefined,
                  contactEmail: contactEmail || undefined,
                });
                if (result.ok) {
                  toast.success('Company added');
                  setOpen(false);
                  setName('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not add the company');
                }
              })
            }
          >
            Add company
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportPortfolioButton() {
  const [open, setOpen] = React.useState(false);
  const [csv, setCsv] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Upload aria-hidden="true" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Import portfolio companies"
        description="Paste a CSV with a header row. Columns are matched by name, so order does not matter."
      >
        <Field
          label="CSV"
          htmlFor="pc-csv"
          hint="Recognised columns: name, website, stage, latest_round, ownership, metrics, priorities, founder, email."
        >
          <Textarea
            id="pc-csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={10}
            className="font-mono text-xs"
            placeholder={
              'name,website,stage,founder,email\nAcme,https://acme.demo,Seed,Jane Doe,jane@acme.demo'
            }
          />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!csv.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await importPortfolioCsvAction(csv);
                if (result.ok && result.data) {
                  toast.success(
                    `Imported ${result.data.created}, skipped ${result.data.skipped} duplicate(s)`,
                    {
                      description:
                        result.data.errors.length > 0
                          ? `${result.data.errors.length} row(s) had problems: ${result.data.errors[0]}`
                          : undefined,
                    },
                  );
                  setOpen(false);
                  setCsv('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Import failed');
                }
              })
            }
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mark requests handled or dismissed; the first failure is the result. */
async function setStatuses(
  ids: readonly string[],
  status: 'handled' | 'ignored',
): Promise<{ ok: boolean; message?: string }> {
  for (const id of ids) {
    const result = await setPortfolioUpdateStatusAction(id, status);
    if (!result.ok) return { ok: false, message: result.error?.message };
  }
  return { ok: true };
}

/**
 * Draft reply, Handled and Dismiss for one request, or for every request
 * from one email at once (the asks of one update share a card): one reply to
 * the thread, and one click closes them all.
 */
export function RequestActions({
  updateId,
  updateIds,
  portfolioCompanyId,
  emailMessageId,
}: {
  updateId?: string;
  /** Every request on the card; takes the place of `updateId`. */
  updateIds?: readonly string[];
  portfolioCompanyId: string;
  emailMessageId: string | null;
}) {
  const [pending, startTransition] = React.useTransition();
  const [draft, setDraft] = React.useState<{ subject: string; body: string } | null>(null);
  const router = useRouter();
  const ids = updateIds ?? (updateId ? [updateId] : []);
  const all = ids.length > 1;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await createDraftAction({
                kind: 'portfolio_reply',
                portfolioCompanyId,
                emailMessageId: emailMessageId ?? undefined,
              });
              if (result.ok && result.data) {
                setDraft({ subject: result.data.subject, body: result.data.body });
                toast.success('Draft created — not sent');
              } else {
                toast.error(result.error?.message ?? 'Could not create the draft');
              }
            })
          }
        >
          Draft reply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await setStatuses(ids, 'handled');
              if (result.ok) {
                toast.success(all ? `Marked ${ids.length} handled` : 'Marked handled');
                router.refresh();
              } else {
                toast.error(result.message ?? 'Could not update');
              }
            })
          }
        >
          <Check aria-hidden="true" />
          {all ? 'All handled' : 'Handled'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await setStatuses(ids, 'ignored');
              if (result.ok) {
                toast.success(all ? `Dismissed ${ids.length}` : 'Dismissed');
                router.refresh();
              } else {
                toast.error(result.message ?? 'Could not update');
              }
            })
          }
        >
          <X aria-hidden="true" />
          {all ? 'Dismiss all' : 'Dismiss'}
        </Button>
      </div>

      {draft ? (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3">
          <Badge tone="outline">Draft · not sent</Badge>
          <p className="mt-2 text-sm font-medium">{draft.subject}</p>
          <PlainText text={draft.body} className="mt-1.5 text-[var(--fg-muted)]" />
        </div>
      ) : null}
    </div>
  );
}

/** Dismiss one ask of several on a card, leaving the others open. */
export function DismissAskButton({ updateId, label }: { updateId: string; label: string }) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={pending}
      aria-label={label}
      title="Dismiss this ask"
      onClick={() =>
        startTransition(async () => {
          const result = await setPortfolioUpdateStatusAction(updateId, 'ignored');
          if (result.ok) {
            toast.success('Dismissed');
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not update');
          }
        })
      }
    >
      <X aria-hidden="true" />
    </Button>
  );
}

export function ClassifyEmailButton({ messageId }: { messageId: string }) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await classifyPortfolioEmailAction(messageId);
          if (result.ok) {
            toast.success(
              result.data?.requestType
                ? `Classified as ${result.data.requestType.replace(/_/g, ' ')}`
                : 'Classified',
            );
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not classify that message');
          }
        })
      }
    >
      Classify request
    </Button>
  );
}
