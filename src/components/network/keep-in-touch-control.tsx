'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setKeepInTouchAction } from '@/app/actions/keep-in-touch';
import {
  CADENCE_MAX_DAYS,
  CADENCE_MIN_DAYS,
  CADENCE_PRESETS,
  PRESET_LABELS,
  cadenceDays,
  cadenceLabel,
  choiceForDays,
  type CadenceChoice,
} from '@/lib/crm/cadence';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';

type Choice = CadenceChoice | 'off';

/**
 * The cadence picker on a profile. A preset saves as soon as it is picked;
 * a custom number of days saves with its button. Read-only for a role that
 * cannot write to the CRM. Keyed on the saved cadence by its parent, so a
 * refresh after saving starts it from what was stored.
 */
export function KeepInTouchControl({
  recordId,
  name,
  days,
  canEdit,
}: {
  recordId: string;
  name: string;
  /** The current cadence in days, or null when none is set. */
  days: number | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const initial: Choice = days === null ? 'off' : choiceForDays(days);
  const [choice, setChoice] = React.useState<Choice>(initial);
  const [custom, setCustom] = React.useState(days !== null ? String(days) : '30');
  const [saving, startSaving] = React.useTransition();
  const id = React.useId();

  const save = (next: Choice, customDays: number | null) =>
    startSaving(async () => {
      const result = await setKeepInTouchAction({ recordId, choice: next, customDays }).catch(
        () => null,
      );
      if (!result?.ok) {
        toast.error(result?.error?.message ?? 'The cadence could not be saved: no connection.', {
          description: result?.error?.stillUsable,
        });
        setChoice(initial);
        return;
      }
      const saved = result.data?.days ?? null;
      toast.success(
        saved === null
          ? `Stopped keep-in-touch reminders for ${name}.`
          : `Keep in touch with ${name}: ${cadenceLabel(saved).toLowerCase()}.`,
        result.data?.created.length
          ? { description: `Already due, so “${result.data.created[0]}” is on your Tasks.` }
          : undefined,
      );
      React.startTransition(() => router.refresh());
    });

  const customNumber = Number(custom);
  const customValid = cadenceDays('custom', customNumber) !== null;

  return (
    <div className="space-y-3">
      <Field label="Check in" htmlFor={`${id}-choice`}>
        <Select
          id={`${id}-choice`}
          value={choice}
          disabled={!canEdit || saving}
          onChange={(e) => {
            const next = e.target.value as Choice;
            setChoice(next);
            if (next === 'custom') return;
            if (next === 'off' && days === null) return;
            save(next, null);
          }}
        >
          <option value="off">Not set</option>
          {CADENCE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </Select>
      </Field>
      {choice === 'custom' ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (customValid) save('custom', customNumber);
          }}
        >
          <Field label="Every how many days" htmlFor={`${id}-days`} className="min-w-0 flex-1">
            <Input
              id={`${id}-days`}
              type="number"
              inputMode="numeric"
              min={CADENCE_MIN_DAYS}
              max={CADENCE_MAX_DAYS}
              step={1}
              value={custom}
              disabled={!canEdit || saving}
              aria-invalid={!customValid}
              onChange={(e) => setCustom(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!canEdit || !customValid}
            className="h-9"
          >
            Save
          </Button>
        </form>
      ) : null}
    </div>
  );
}
