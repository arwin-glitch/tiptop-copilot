'use client';

import * as React from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogFooter } from './dialog';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for an action that destroys or stops something. */
  tone?: 'primary' | 'danger';
}

/**
 * A yes/no question in the app's own dialog, awaited the way window.confirm
 * was: `if (await confirm({ title })) …`. Render the returned element once in
 * the component.
 *
 * window.confirm cannot be used. The desktop app's Mac window (WKWebView, which
 * the shell gives no handler for it) answers every confirm with Cancel and
 * shows nothing, so a guarded action — cancelling a campaign mid-send — would
 * silently never happen. Escape, the close button or a click outside answer
 * "no", and a newer question answers an unanswered older one "no".
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [question, setQuestion] = React.useState<ConfirmOptions | null>(null);
  const pending = React.useRef<((answer: boolean) => void) | null>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setQuestion(options);
      }),
    [],
  );

  // Unmounting with a question open (navigating away) is a "no".
  React.useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    [],
  );

  const settle = (answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setQuestion(null);
    resolve?.(answer);
  };

  const dialog = (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      {question ? (
        <DialogContent title={question.title} description={question.description}>
          <DialogFooter className="mt-0">
            <Button variant="ghost" onClick={() => settle(false)}>
              {question.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={question.tone === 'danger' ? 'danger' : 'primary'}
              onClick={() => settle(true)}
            >
              {question.confirmLabel ?? 'Continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );

  return [confirm, dialog];
}
