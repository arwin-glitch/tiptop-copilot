'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, Download, Pencil, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  addNoteAction,
  analyzeDealAction,
  correctFactAction,
  createDraftAction,
  overrideRecommendationAction,
  recordDecisionAction,
  resolveRedFlagAction,
  updateDealStageAction,
} from '@/app/actions';
import { Badge, RecommendationBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { PlainText } from '@/components/ui/feedback';
import {
  RECOMMENDATIONS,
  RECOMMENDATION_LABELS,
  type DealStage,
  type DecisionType,
  type Recommendation,
} from '@/lib/types/domain';

export function ReanalyzeButton({ dealId }: { dealId: string }) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  return (
    <Button
      variant="primary"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await analyzeDealAction(dealId, true);
          if (result.ok) {
            toast.success(
              `${result.data?.recommendation.replace(/_/g, ' ')} at ${result.data?.confidence}% confidence`,
            );
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Analysis failed', {
              description: result.error?.stillUsable,
            });
          }
        })
      }
    >
      <RefreshCw aria-hidden="true" />
      Reanalyse
    </Button>
  );
}

export function StageSelect({
  dealId,
  stage,
  stages,
}: {
  dealId: string;
  stage: string;
  stages: DealStage[];
}) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  return (
    <Select
      aria-label="Pipeline stage"
      value={stage}
      disabled={pending}
      className="w-auto"
      onChange={(e) =>
        startTransition(async () => {
          const result = await updateDealStageAction(dealId, e.target.value);
          if (result.ok) {
            toast.success('Stage updated');
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not change the stage');
          }
        })
      }
    >
      {stages.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label}
        </option>
      ))}
    </Select>
  );
}

const DECISION_COPY: Record<
  Exclude<DecisionType, 'reopen'>,
  { label: string; blurb: string; confirm: string }
> = {
  pass: {
    label: 'Pass',
    blurb: 'Records a pass and moves the deal to Passed.',
    confirm: 'Record pass',
  },
  monitor: {
    label: 'Monitor',
    blurb: 'Keeps the company on the radar without active work.',
    confirm: 'Record monitor',
  },
  dig_deeper: {
    label: 'Dig deeper',
    blurb: 'Moves the deal into diligence.',
    confirm: 'Record dig deeper',
  },
  advance: {
    label: 'Advance',
    blurb: 'Moves the deal to partner / IC review.',
    confirm: 'Record advance',
  },
  invest: {
    label: 'Invested',
    blurb:
      'Records that TipTop invested. This is a human-only decision — the assistant cannot set it, propose it, or take any financial action.',
    confirm: 'Confirm investment decision',
  },
};

export function DecisionButtons({ dealId }: { dealId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(DECISION_COPY) as (keyof typeof DECISION_COPY)[]).map((key) => (
        <DecisionDialog key={key} dealId={dealId} decision={key} />
      ))}
    </div>
  );
}

function DecisionDialog({
  dealId,
  decision,
}: {
  dealId: string;
  decision: keyof typeof DECISION_COPY;
}) {
  const [open, setOpen] = React.useState(false);
  const [rationale, setRationale] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  const copy = DECISION_COPY[decision];
  const consequential = decision === 'invest';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={consequential ? 'secondary' : 'secondary'} size="sm">
          {copy.label}
        </Button>
      </DialogTrigger>
      <DialogContent title={`Record: ${copy.label}`} description={copy.blurb}>
        {consequential ? (
          <p className="mb-4 rounded-md border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-3 py-2.5 text-sm">
            This is the only place an investment decision can be recorded, and only you can record
            it. Nothing in this product moves money or contacts anyone.
          </p>
        ) : null}
        <Field
          label="Why"
          htmlFor="decision-rationale"
          hint="This becomes part of your decision memory and is cited when a future deal looks similar."
        >
          <Textarea
            id="decision-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={5}
            autoFocus
            placeholder="Founder-market fit is the strongest we have seen in this category, but the data-rights question has to be answered first."
          />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={consequential ? 'danger' : 'primary'}
            loading={pending}
            disabled={!rationale.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await recordDecisionAction(dealId, decision, rationale);
                if (result.ok) {
                  toast.success(`Recorded: ${copy.label}`);
                  setOpen(false);
                  setRationale('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not record that decision');
                }
              })
            }
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DraftButtons({
  dealId,
  recommendation,
}: {
  dealId: string;
  recommendation: Recommendation | null;
}) {
  const [pending, startTransition] = React.useTransition();
  const [draft, setDraft] = React.useState<{ subject: string; body: string } | null>(null);
  const router = useRouter();

  const kinds: {
    kind: 'missing_information' | 'pass' | 'follow_up' | 'meeting_request';
    label: string;
  }[] = [
    { kind: 'missing_information', label: 'Ask for missing info' },
    { kind: 'pass', label: 'Pass note' },
    { kind: 'follow_up', label: 'Follow-up' },
    { kind: 'meeting_request', label: 'Meeting request' },
  ];

  // Lead with whatever the current recommendation implies.
  const ordered = [...kinds].sort((a, b) => {
    const priority = (k: string) =>
      recommendation === 'PASS' && k === 'pass'
        ? -1
        : recommendation === 'INSUFFICIENT_DATA' && k === 'missing_information'
          ? -1
          : recommendation === 'ADVANCE' && k === 'meeting_request'
            ? -1
            : 0;
    return priority(a.kind) - priority(b.kind);
  });

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {ordered.map(({ kind, label }) => (
          <Button
            key={kind}
            size="sm"
            variant="secondary"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await createDraftAction({ kind, dealId });
                if (result.ok && result.data) {
                  setDraft({ subject: result.data.subject, body: result.data.body });
                  toast.success('Draft created — nothing was sent');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not create the draft');
                }
              })
            }
          >
            {label}
          </Button>
        ))}
      </div>

      {draft ? (
        <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <Badge tone="outline">Draft · not sent</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
                toast.success('Copied. Paste into your mail client to send it yourself.');
              }}
            >
              <Copy aria-hidden="true" />
              Copy
            </Button>
          </div>
          <p className="mt-2 text-sm font-medium">{draft.subject}</p>
          <PlainText text={draft.body} className="mt-2 text-[var(--fg-muted)]" />
        </div>
      ) : null}
    </div>
  );
}

export function AddNoteButton({ dealId }: { dealId: string }) {
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Add note
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Add a note"
        description="Your notes are labelled distinctly from founder claims and model inferences, and are cited when they inform an answer."
      >
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!body.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await addNoteAction(dealId, body);
                if (result.ok) {
                  toast.success('Note saved');
                  setOpen(false);
                  setBody('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not save the note');
                }
              })
            }
          >
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CorrectFieldButton({
  dealId,
  field,
  label,
  currentValue,
}: {
  dealId: string;
  field: string;
  label: string;
  currentValue: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState(currentValue ?? '');
  const [note, setNote] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-[var(--fg-subtle)] transition-colors hover:text-[var(--fg)]"
          aria-label={`Correct ${label}`}
          title={`Correct ${label}`}
        >
          <Pencil className="size-3" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent
        title={`Correct: ${label}`}
        description="The extracted value is kept alongside your correction. Both stay visible in the audit history forever."
      >
        <div className="space-y-4">
          <div>
            <FieldLabel as="p">Extracted value</FieldLabel>
            <p className="mt-1 text-sm">
              {currentValue ?? <span className="text-[var(--fg-subtle)] italic">Not stated</span>}
            </p>
          </div>
          <Field
            label="Corrected value"
            htmlFor="correct-value"
            hint="Leave empty to mark this as genuinely unknown."
          >
            <Input
              id="correct-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Why" htmlFor="correct-note" hint="Optional but useful later.">
            <Input id="correct-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await correctFactAction(dealId, field, value, note || undefined);
                if (result.ok) {
                  toast.success('Correction saved');
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not save the correction');
                }
              })
            }
          >
            Save correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OverrideRecommendationButton({
  analysisId,
  dealId,
  current,
}: {
  analysisId: string;
  dealId: string;
  current: Recommendation;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState<Recommendation>(current);
  const [note, setNote] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Disagree
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Override the recommendation"
        description="The original recommendation and your override are both kept. The override is what the rest of the product uses."
      >
        <div className="space-y-4">
          <Field label="Your call" htmlFor="override-value">
            <Select
              id="override-value"
              value={value}
              onChange={(e) => setValue(e.target.value as Recommendation)}
            >
              {RECOMMENDATIONS.map((r) => (
                <option key={r} value={r}>
                  {RECOMMENDATION_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Why the analysis is wrong" htmlFor="override-note">
            <Textarea
              id="override-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!note.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await overrideRecommendationAction(analysisId, dealId, value, note);
                if (result.ok) {
                  toast.success('Override recorded');
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not record the override');
                }
              })
            }
          >
            Record override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResolveFlagButton({
  analysisId,
  dealId,
  label,
}: {
  analysisId: string;
  dealId: string;
  label: string;
}) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await resolveRedFlagAction(analysisId, dealId, label);
          if (result.ok) {
            toast.success('Flag marked resolved — the recommendation cap has lifted');
            router.refresh();
          } else {
            toast.error(result.error?.message ?? 'Could not resolve the flag');
          }
        })
      }
    >
      <ShieldCheck aria-hidden="true" />
      Mark resolved
    </Button>
  );
}

export function ExportMemoButton({ dealId, companyName }: { dealId: string; companyName: string }) {
  return (
    <Button asChild variant="secondary" size="sm">
      <a href={`/api/deals/${dealId}/memo`} download={`${companyName}-memo.md`}>
        <Download aria-hidden="true" />
        Export memo
      </a>
    </Button>
  );
}

export function RecommendationHeadline({
  recommendation,
  overridden,
}: {
  recommendation: Recommendation;
  overridden: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <RecommendationBadge recommendation={recommendation} size="lg" />
      {overridden ? <Badge tone="outline">Your override</Badge> : null}
    </span>
  );
}
