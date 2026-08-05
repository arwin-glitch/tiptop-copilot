'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { updateThesisAction, updateTimezoneAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Notice } from '@/components/ui/feedback';
import {
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_THRESHOLDS,
  type DealStage,
  type RecommendationThresholds,
  type ScoringWeight,
  type ThesisVersion,
} from '@/lib/types/domain';
import { SUPPORTED_TIMEZONES } from '@/lib/util/time';

export function TimezoneSetting({ current }: { current: string }) {
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Field
      label="Timezone"
      htmlFor="tz"
      hint="Controls what “today” means: the daily outlook, due dates and every timestamp in the interface."
    >
      <Select
        id="tz"
        defaultValue={current}
        disabled={pending}
        onChange={(e) =>
          startTransition(async () => {
            const result = await updateTimezoneAction(e.target.value);
            if (result.ok) {
              toast.success('Timezone updated');
              router.refresh();
            } else {
              toast.error(result.error?.message ?? 'Could not update the timezone');
            }
          })
        }
      >
        {SUPPORTED_TIMEZONES.map((tz) => (
          <option key={tz} value={tz}>
            {tz.replace(/_/g, ' ')}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const LIST_FIELDS = [
  { key: 'preferred_stages', label: 'Preferred stages', placeholder: 'Pre-seed, Seed' },
  {
    key: 'preferred_industries',
    label: 'Preferred industries',
    placeholder: 'Vertical AI, AI-native vertical software',
  },
  { key: 'excluded_industries', label: 'Excluded industries', placeholder: 'Leave empty if none' },
  {
    key: 'geographic_preferences',
    label: 'Geographic preferences',
    placeholder: 'Leave empty for no restriction',
  },
  { key: 'hard_disqualifiers', label: 'Hard disqualifiers', placeholder: 'One per line' },
] as const;

const TEXT_FIELDS = [
  { key: 'typical_check_range', label: 'Typical check range', placeholder: 'Not configured' },
  { key: 'target_ownership', label: 'Target ownership', placeholder: 'Not configured' },
  { key: 'follow_on_strategy', label: 'Follow-on strategy', placeholder: 'Not configured' },
  { key: 'required_traction', label: 'Required traction', placeholder: 'Not configured' },
] as const;

export function ThesisEditor({ thesis }: { thesis: ThesisVersion }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [lists, setLists] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(LIST_FIELDS.map((f) => [f.key, (thesis[f.key] as string[]).join('\n')])),
  );
  const [texts, setTexts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(TEXT_FIELDS.map((f) => [f.key, (thesis[f.key] as string | null) ?? ''])),
  );
  const [notes, setNotes] = React.useState(thesis.thesis_notes);
  const [weights, setWeights] = React.useState<ScoringWeight[]>(thesis.scoring_weights);
  const [thresholds, setThresholds] = React.useState<RecommendationThresholds>(thesis.thresholds);
  const [stages, setStages] = React.useState<DealStage[]>(thesis.deal_stages);

  const totalWeight = weights.filter((w) => w.enabled).reduce((sum, w) => sum + w.weight, 0);

  const save = () =>
    startTransition(async () => {
      const result = await updateThesisAction({
        preferred_stages: splitLines(lists.preferred_stages),
        preferred_industries: splitLines(lists.preferred_industries),
        excluded_industries: splitLines(lists.excluded_industries),
        geographic_preferences: splitLines(lists.geographic_preferences),
        hard_disqualifiers: splitLines(lists.hard_disqualifiers),
        typical_check_range: texts.typical_check_range?.trim() || null,
        target_ownership: texts.target_ownership?.trim() || null,
        follow_on_strategy: texts.follow_on_strategy?.trim() || null,
        required_traction: texts.required_traction?.trim() || null,
        thesis_notes: notes,
        scoring_weights: weights,
        thresholds,
        deal_stages: stages,
      });
      if (result.ok) {
        toast.success(`Thesis saved as version ${result.data?.version}`);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? 'Could not save the thesis');
      }
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">Investment thesis</CardTitle>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              Version {thesis.version}. Saving creates a new version; earlier analyses keep the
              version they were scored against.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Notice>
            Fields left empty are treated as <strong>not configured</strong> and are excluded from
            scoring — never as a requirement the company failed. Nothing invents a check size,
            ownership target or geography for you.
          </Notice>

          <Field label="Thesis notes" htmlFor="thesis-notes">
            <Textarea
              id="thesis-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={9}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            {LIST_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`thesis-${f.key}`} hint="One per line.">
                <Textarea
                  id={`thesis-${f.key}`}
                  value={lists[f.key] ?? ''}
                  onChange={(e) => setLists((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  rows={3}
                  placeholder={f.placeholder}
                />
              </Field>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {TEXT_FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                htmlFor={`thesis-${f.key}`}
                hint={texts[f.key] ? undefined : 'Not configured — excluded from scoring.'}
              >
                <Input
                  id={`thesis-${f.key}`}
                  value={texts[f.key] ?? ''}
                  onChange={(e) => setTexts((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                />
              </Field>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">Scorecard weights</CardTitle>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              Total enabled weight: <strong className="tabular">{totalWeight}</strong>. Scores are
              normalised over the categories that had evidence, so the total does not have to be
              100.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWeights(DEFAULT_SCORING_WEIGHTS)}
            aria-label="Reset weights to defaults"
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--border)]">
            {weights.map((w, index) => (
              <li key={w.key} className="flex items-center gap-3 py-2.5">
                <Switch
                  checked={w.enabled}
                  aria-label={`Enable ${w.label}`}
                  onCheckedChange={(checked) =>
                    setWeights((prev) =>
                      prev.map((x, i) => (i === index ? { ...x, enabled: checked } : x)),
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{w.label}</p>
                  <p className="text-xs text-[var(--fg-subtle)]">{w.description}</p>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={w.weight}
                  aria-label={`Weight for ${w.label}`}
                  className="tabular w-16 text-right"
                  onChange={(e) =>
                    setWeights((prev) =>
                      prev.map((x, i) =>
                        i === index ? { ...x, weight: Number(e.target.value) || 0 } : x,
                      ),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">Recommendation thresholds</CardTitle>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              Applied to the normalised score. These, not the model, decide the label.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setThresholds(DEFAULT_THRESHOLDS)}>
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <ThresholdField
              label="Minimum data completeness"
              hint="Below this, the answer is INSUFFICIENT DATA regardless of score."
              value={thresholds.minimum_completeness}
              onChange={(v) => setThresholds((p) => ({ ...p, minimum_completeness: v }))}
            />
            <ThresholdField
              label="PASS below"
              hint="Scores under this are a pass."
              value={thresholds.pass_below}
              onChange={(v) => setThresholds((p) => ({ ...p, pass_below: v }))}
            />
            <ThresholdField
              label="MONITOR below"
              hint="Between PASS and this, monitor."
              value={thresholds.monitor_below}
              onChange={(v) => setThresholds((p) => ({ ...p, monitor_below: v }))}
            />
            <ThresholdField
              label="ADVANCE at"
              hint="At or above this, advance. Between MONITOR and this, dig deeper."
              value={thresholds.advance_at}
              onChange={(v) => setThresholds((p) => ({ ...p, advance_at: v, dig_deeper_below: v }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle as="h2">Pipeline stages</CardTitle>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              Rename stages to match how you actually work. Keys are fixed so existing deals keep
              their stage.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {stages.map((stage, index) => (
              <li key={stage.key} className="flex items-center gap-3">
                <span className="tabular w-6 text-xs text-[var(--fg-subtle)]">{index + 1}</span>
                <Input
                  value={stage.label}
                  aria-label={`Label for stage ${stage.key}`}
                  onChange={(e) =>
                    setStages((prev) =>
                      prev.map((s, i) => (i === index ? { ...s, label: e.target.value } : s)),
                    )
                  }
                />
                <Badge tone="outline" className="shrink-0 font-mono">
                  {stage.key}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="sticky bottom-16 flex justify-end lg:bottom-4">
        <Button variant="primary" loading={pending} onClick={save}>
          Save thesis
        </Button>
      </div>
    </div>
  );
}

function ThresholdField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = React.useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        min={0}
        max={100}
        value={value}
        className="tabular"
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </Field>
  );
}

function splitLines(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
