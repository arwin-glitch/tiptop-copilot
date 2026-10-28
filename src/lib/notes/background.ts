import 'server-only';
import { after } from 'next/server';
import { log } from '@/lib/security/redact';
import { settlesWithin } from '@/lib/util/settle';

/**
 * Work a Kraken Notes route finishes after it has answered (D-076): writing
 * notes with a model takes tens of seconds, and nobody should wait on a
 * spinner for it. Next's `after` keeps it running past the response; outside
 * a request (the tests, a script) it simply runs now, awaited. A failure is
 * logged, never thrown at the caller.
 */
export async function afterResponse(
  what: string,
  task: () => Promise<unknown>,
): Promise<'scheduled' | 'ran'> {
  const safe = async () => {
    try {
      await task();
    } catch (error) {
      log.warn(`Kraken Notes: could not ${what} after answering`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  try {
    after(safe);
    return 'scheduled';
  } catch {
    await safe();
    return 'ran';
  }
}

/**
 * Start `task`, wait up to `budgetMs` for it, and leave the rest to run after
 * the response. True when it finished within the budget.
 */
export async function withinOrAfter(
  what: string,
  task: Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  if (await settlesWithin(task, budgetMs)) return true;
  await afterResponse(what, () => task);
  return false;
}
