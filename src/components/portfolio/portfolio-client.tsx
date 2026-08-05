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

export function RequestActions({
  updateId,
  portfolioCompanyId,
  emailMessageId,
}: {
  updateId: string;
  portfolioCompanyId: string;
  emailMessageId: string | null;
}) {
  const [pending, startTransition] = React.useTransition();
  const [draft, setDraft] = React.useState<{ subject: string; body: string } | null>(null);
  const router = useRouter();

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
              const result = await setPortfolioUpdateStatusAction(updateId, 'handled');
              if (result.ok) {
                toast.success('Marked handled');
                router.refresh();
              } else {
                toast.error(result.error?.message ?? 'Could not update');
              }
            })
          }
        >
          <Check aria-hidden="true" />
          Handled
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
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
          Dismiss
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
