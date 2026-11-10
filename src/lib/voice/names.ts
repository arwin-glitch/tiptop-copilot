import { fixTranscript, prepareNames, type FixResult } from './fix';

/**
 * The team's companies and people, for spelling speech the way Kraken spells
 * it. Asked for once per page load, kept in memory only.
 */
let names: ReturnType<typeof prepareNames> = [];
let loading: Promise<void> | null = null;

export function loadVoiceNames(): Promise<void> {
  if (!loading) {
    loading = fetch('/api/voice/vocabulary', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { terms?: unknown } | null) => {
        const terms = Array.isArray(body?.terms)
          ? body.terms.filter((t): t is string => typeof t === 'string')
          : [];
        names = prepareNames(terms);
      })
      .catch(() => {
        // Kraken's own words still work; try again on the next use.
        loading = null;
      });
  }
  return loading;
}

/** What was heard, cleaned up against Kraken's words and the team's names. */
export function fixHeard(heard: string): FixResult {
  return fixTranscript(heard, names);
}
