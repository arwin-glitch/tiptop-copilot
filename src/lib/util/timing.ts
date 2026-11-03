/**
 * Server timing for slow tabs, off unless `KRAKEN_TIMING=1`.
 *
 * Each step logs one line, `[timing] <tab> <step> <ms>ms`, so a deploy's logs
 * show which await holds a page back without a profiler. It never changes what
 * the work returns or throws, and with the flag off it adds nothing but a check.
 */
export function timingEnabled(): boolean {
  return process.env.KRAKEN_TIMING === '1';
}

/** Run `work` and, with timing on, log how long it took to settle. */
export async function timed<T>(tab: string, step: string, work: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    console.info(`[timing] ${tab} ${step} ${Math.round(performance.now() - started)}ms`);
  }
}
