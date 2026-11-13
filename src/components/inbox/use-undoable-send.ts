'use client';

import * as React from 'react';
import { toast } from 'sonner';

/**
 * Gmail's Send: the compose box goes away at once and a "Sending…" toast with
 * Undo stays for the undo window; only then does the email go. Undo brings the
 * box back with every word. The caller hides its box while `pending`.
 *
 * If the box is unmounted mid-wait (the page changes), the email still goes,
 * as in Gmail: Undo is the only way to stop it.
 */
export function useUndoableSend(send: () => Promise<void> | void, seconds: number) {
  const [pending, setPending] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const toastId = React.useRef<string | number | null>(null);
  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (toastId.current !== null) toast.dismiss(toastId.current);
    toastId.current = null;
  };

  const undo = React.useCallback(() => {
    clear();
    setPending(false);
  }, []);

  const start = React.useCallback(() => {
    clear();
    setPending(true);
    toastId.current = toast('Sending…', {
      duration: seconds * 1000,
      action: { label: 'Undo', onClick: () => undo() },
    });
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (toastId.current !== null) toast.dismiss(toastId.current);
      toastId.current = null;
      setPending(false);
      void sendRef.current();
    }, seconds * 1000);
  }, [seconds, undo]);

  // Leaving the page mid-wait sends now rather than dropping the email.
  React.useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        if (toastId.current !== null) toast.dismiss(toastId.current);
        void sendRef.current();
      }
    },
    [],
  );

  return { pending, start, undo };
}
