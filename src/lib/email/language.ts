/**
 * A cheap guess at whether a message is in English, for Gmail's "Translate
 * message" (offered only when it probably is not). No model and no network:
 * mostly non-Latin letters means not English; otherwise the share of very
 * common English words decides. Short or empty text counts as English, so
 * the menu never offers a translation of a signature or a "Thanks!". Pure.
 */

const COMMON = new Set(
  (
    'the be to of and a in that have i it for not on with he as you do at this but his by from ' +
    'they we say her she or an will my one all would there their what so up out if about who get ' +
    'which go me when make can like time no just him know take people into year your good some ' +
    'could them see other than then now look only come its over think also back after use two how ' +
    'our work first well way even new want because any these give day most us is are was were ' +
    'has had been thanks thank please hi hello best regards let meeting call next week'
  ).split(' '),
);

/** The least text worth judging, in letters. */
const MIN_LETTERS = 40;

export function looksEnglish(text: string): boolean {
  const sample = text.slice(0, 4_000);
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_LETTERS) return true;
  const latin = letters.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length;
  if (latin / letters.length < 0.6) return false;
  const words = sample.toLowerCase().match(/[a-zÀ-ɏ']+/g) ?? [];
  if (words.length < 8) return true;
  const common = words.filter((w) => COMMON.has(w)).length;
  return common / words.length >= 0.12;
}
