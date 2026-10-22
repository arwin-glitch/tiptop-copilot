/**
 * Saves made from one form, sent one at a time in the order they were made.
 *
 * The alternative, disabling the form's controls while a save is on its way,
 * loses clicks: leaving a text field by clicking a button saves the field on
 * the button's mousedown, so the button is disabled before its mouseup and
 * the click never happens. Queued instead, nothing waits disabled and nothing
 * is dropped.
 *
 * A save works out what to send when its turn comes, from the state then, so
 * a choice changed twice while waiting sends only the last one (or nothing,
 * when it is back where it started). `onBusy` hears `true` when the first
 * save is queued and `false` once the last has finished, once each.
 */
export interface SaveQueue {
  /**
   * Queue `run` behind every save before it. `run` reports its own failures;
   * one that throws anyway does not stop the saves after it. Resolves once
   * `run` has finished.
   */
  add(run: () => Promise<void> | void): Promise<void>;
  /** Saves queued or on their way. */
  readonly pending: number;
}

export function createSaveQueue(onBusy: (busy: boolean) => void): SaveQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    add(run) {
      pending++;
      if (pending === 1) onBusy(true);
      const done = tail.then(async () => {
        try {
          await run();
        } catch {
          // Reported by `run`, or nowhere to report it; the queue goes on.
        } finally {
          pending--;
          if (pending === 0) onBusy(false);
        }
      });
      tail = done;
      return done;
    },
  };
}
