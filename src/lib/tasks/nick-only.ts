import { sha256 } from '@/lib/util/hash';

/**
 * Counterparties kept Nick-only by standing rule: the app never checks their
 * tasks automatically and never posts anything about them. Kept as SHA-256
 * digests of lowercased words (a name, or a label of their email domain) so
 * this public repository does not name them.
 */
const NICK_ONLY_WORDS: ReadonlySet<string> = new Set([
  '4ea12584f055ed265b13c048d2437128d12a199547557608112f61a9c3b6fbc1',
  'd044d241d16f024afb2419070948c6a7cecfa0b062124e34e01f277438008dd9',
]);

/** Whether any of the texts or addresses has a word whose digest is in `digests`. */
export function wordMatcher(
  digests: ReadonlySet<string>,
): (...texts: readonly (string | null | undefined)[]) => boolean {
  return (...texts) => {
    for (const text of texts) {
      if (!text) continue;
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word && digests.has(sha256(word))) return true;
      }
    }
    return false;
  };
}

/** Whether any of these texts or addresses names a Nick-only counterparty. */
export const mentionsNickOnly = wordMatcher(NICK_ONLY_WORDS);
