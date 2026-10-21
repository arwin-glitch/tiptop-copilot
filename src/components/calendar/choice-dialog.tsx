'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';

export interface Choice<T extends string> {
  value: T;
  label: string;
  tone?: 'primary' | 'secondary' | 'danger';
}

export interface ChoiceQuestion<T extends string> {
  title: string;
  description?: string;
  choices: Choice<T>[];
  /** The way back out; answers null. */
  cancelLabel?: string;
  /** Shown as a short list under the description (the guests a prompt is about). */
  details?: string[];
}

/**
 * A question with a few answers, awaited like useConfirm: the guests prompt
 * (Send / Don't send / Cancel) and the recurring-event prompt (This event /
 * All events / Cancel). Escape, the close button or a click outside answer
 * null, which every caller treats as Cancel: nothing is changed.
 */
export function useChoice(): [
  <T extends string>(question: ChoiceQuestion<T>) => Promise<T | null>,
  React.ReactNode,
] {
  const [question, setQuestion] = React.useState<ChoiceQuestion<string> | null>(null);
  const pending = React.useRef<((answer: string | null) => void) | null>(null);

  const ask = React.useCallback(
    <T extends string>(q: ChoiceQuestion<T>) =>
      new Promise<T | null>((resolve) => {
        pending.current?.(null);
        pending.current = resolve as (answer: string | null) => void;
        setQuestion(q as ChoiceQuestion<string>);
      }),
    [],
  );

  React.useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [],
  );

  const settle = (answer: string | null) => {
    const resolve = pending.current;
    pending.current = null;
    setQuestion(null);
    resolve?.(answer);
  };

  const dialog = (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      {question ? (
        <DialogContent title={question.title} description={question.description}>
          {question.details?.length ? (
            <ul className="mb-1 max-h-32 space-y-0.5 overflow-y-auto text-sm text-[var(--fg-muted)]">
              {question.details.map((d) => (
                <li key={d} className="truncate">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter className="mt-3">
            <Button variant="ghost" onClick={() => settle(null)}>
              {question.cancelLabel ?? 'Cancel'}
            </Button>
            {question.choices.map((c) => (
              <Button key={c.value} variant={c.tone ?? 'secondary'} onClick={() => settle(c.value)}>
                {c.label}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );

  return [ask, dialog];
}
