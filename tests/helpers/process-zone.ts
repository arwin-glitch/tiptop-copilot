/**
 * Runs `run` with the process's clock zone set to `tz`, then puts it back.
 * Node re-reads `process.env.TZ` when it is assigned, so `new Date()`'s local
 * getters and Intl's default zone follow it at once.
 *
 * For tests that text read in the user's profile timezone is the same whatever
 * zone the server runs in (Render is UTC; a laptop is wherever it is).
 */
export async function underProcessZone<T>(tz: string, run: () => T | Promise<T>): Promise<T> {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/**
 * Process zones that disagree on the calendar day: at any instant at least two
 * of them are on different dates, so a date read from the process's own clock
 * cannot match all of them.
 */
export const PROCESS_ZONES = ['UTC', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
