/**
 * Spelling the invite's names right (D-076). Whisper hears "acme robotics"
 * or "dana reyes"; the calendar and the CRM know "Acme Robotics" and "Dana
 * Reyes". The speech worker passes every finished line through this before it
 * leaves the browser.
 *
 * Deliberately narrow: it only fixes the capitals of a phrase that already
 * matches a known term letter for letter, as whole words. It never swaps one
 * word for another, so it cannot put a name in someone's mouth.
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Terms worth fixing: at least three letters, longest first so "Acme Robotics" wins over "Acme". */
export function prepareVocabulary(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (term.replace(/[^\p{L}]/gu, '').length < 3) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** The line with each known term spelled the way the calendar or CRM spells it. */
export function applyVocabulary(text: string, terms: readonly string[]): string {
  let out = text;
  for (const term of terms) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(pattern, (match) => (match === term ? match : term));
  }
  return out;
}
