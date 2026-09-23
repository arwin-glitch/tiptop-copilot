import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, FieldLabel } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import {
  ApplyStageButton,
  NotADealButton,
  RecordInvestButton,
} from '@/components/deals/deal-actions';
import { FIT_LABELS } from '@/lib/deals/pipeline-view';
import type { RoutineSidecar } from '@/lib/deals/routine-state';
import type { DealStage } from '@/lib/types/domain';
import { formatDate } from '@/lib/util/time';

/**
 * What the deal-sorter knows about this deal, and who owns its stage.
 *
 * Everything the routine posted is rendered as plain text. The only actions
 * are human ones that already exist — Apply is the ordinary stage change,
 * "Record invest decision" is the ordinary Invest dialog with the evidence as
 * its starting rationale, and "Not a deal" is the ordinary archive — so using
 * a suggestion is always a person's act, and counts as one.
 */
export function RoutineCard({
  dealId,
  dealStage,
  stages,
  sidecar,
  owned,
  timezone,
  archived,
}: {
  dealId: string;
  dealStage: string;
  stages: DealStage[];
  sidecar: RoutineSidecar;
  owned: boolean;
  timezone: string;
  archived: boolean;
}) {
  const view = sidecar.view;
  const label = (key: string) => stages.find((s) => s.key === key)?.label ?? key;
  const inThesis = view ? stages.some((s) => s.key === view.stage) : false;
  // An invested deal's stage is settled; an older routine view is not a suggestion.
  const differs = Boolean(view && view.stage !== dealStage && dealStage !== 'invested');
  const day = (value: string | null | undefined) =>
    value ? formatDate(`${value.slice(0, 10)}T12:00:00.000Z`, timezone) : null;

  const rows: [string, string | null][] = [
    ['Fit', sidecar.fit ? FIT_LABELS[sidecar.fit] : null],
    ['Source', sidecar.source],
    ['Next step', sidecar.next_step],
    ['Last activity', day(sidecar.last_activity)],
    ['First seen', day(sidecar.first_seen)],
  ];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle as="h2" id="deal-sorter-heading" className="flex items-center gap-2">
          <Bot className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
          Deal-sorter
        </CardTitle>
        <Badge tone={owned ? 'info' : 'outline'}>
          {owned ? 'Kept in sync automatically' : 'Stage set by a person, suggestions only'}
        </Badge>
      </CardHeader>
      <CardContent>
        {sidecar.retract && !archived ? (
          <Notice tone="warn" className="mb-4">
            <p>
              <span className="font-medium">The deal-sorter says this is not a deal:</span>{' '}
              {sidecar.retract}
            </p>
            <div className="mt-2">
              <NotADealButton dealId={dealId} defaultReason={sidecar.retract} />
            </div>
          </Notice>
        ) : null}

        {view ? (
          <div className="rounded-md bg-[var(--bg-sunken)] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="text-[var(--fg-muted)]">Stage view: </span>
                <span className="font-medium">{label(view.stage)}</span>
                {differs ? (
                  <Badge tone="warn" className="ml-2">
                    Differs from the current stage
                  </Badge>
                ) : null}
              </p>
              {differs && inThesis && !archived ? (
                view.stage === 'invested' ? (
                  <RecordInvestButton
                    dealId={dealId}
                    evidence={view.evidence ?? 'Wire evidence found by the deal-sorter.'}
                  />
                ) : (
                  <ApplyStageButton dealId={dealId} stage={view.stage} label={label(view.stage)} />
                )
              ) : null}
            </div>
            {view.evidence ? (
              <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{view.evidence}</p>
            ) : null}
            <p className="mt-1 text-xs text-[var(--fg-subtle)]">
              Evidence from {day(view.evidence_date)}
              {view.pass_reason ? ` · Pass reason: ${view.pass_reason}` : ''}
            </p>
          </div>
        ) : null}

        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {rows
            .filter((row): row is [string, string] => Boolean(row[1]))
            .map(([term, value]) => (
              <div key={term} className="min-w-0">
                <FieldLabel as="dt">{term}</FieldLabel>
                <dd className="mt-0.5 text-sm break-words">{value}</dd>
              </div>
            ))}
        </dl>
      </CardContent>
    </Card>
  );
}
