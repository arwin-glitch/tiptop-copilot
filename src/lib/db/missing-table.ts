/**
 * Whether an error means a table does not exist yet.
 *
 * Production migrations are applied by hand in the Supabase SQL editor, so
 * code can reach production before its table does — the Sep 15 outage was
 * exactly that, a page awaiting a read of `routine_briefings` before the table
 * existed. Reads of a new table therefore catch this and degrade to an empty
 * "not set up yet" state, and writes turn it into a plain error, instead of
 * taking down the page around them.
 *
 * Postgres reports a missing relation as `42P01`; PostgREST, which answers
 * from its schema cache before Postgres is asked, as `PGRST205`. The store
 * keeps that code on the thrown error (see supabase-store.ts), and the
 * message is matched as well — the same test the Granola backfill applies —
 * for an error that reached here some other way. A missing *column* is not a
 * missing table and does not match.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42P01' || code === 'PGRST205') return true;
  const message = (error as { message?: unknown }).message;
  // `column "x" of relation "y" does not exist` contains the relation phrase.
  if (typeof message !== 'string' || /\bcolumn\b/i.test(message)) return false;
  return /42P01|PGRST205|relation "?[\w.]+"? does not exist|could not find the table/i.test(
    message,
  );
}

/**
 * Whether an error means a column does not exist yet: the table is there, but
 * from an earlier copy of its migration. Postgres says `42703`; PostgREST,
 * refusing a write that names an unknown column, `PGRST204`. Kept apart from
 * isMissingTableError because the fix reads differently — run the migration
 * again, rather than for the first time.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '42703' || code === 'PGRST204') return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /PGRST204|could not find the '?[\w.]+'? column|column "?[\w.]+"? (of relation "?[\w.]+"? )?does not exist/i.test(
    message,
  );
}
