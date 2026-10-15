/**
 * Turning pasted text into recipients. Pure, shared by the composer (which
 * counts as you paste) and the server (which decides).
 *
 * Accepts what people actually paste: one address per line, comma- or
 * semicolon-separated addresses, `Jane Doe <jane@example.com>`, and rows
 * copied from a spreadsheet ("Jane Doe<TAB>jane@example.com").
 */

export interface PastedRecipient {
  email: string;
  name: string | null;
}

export interface PasteResult {
  recipients: PastedRecipient[];
  /** Addresses that appeared more than once in the paste. */
  duplicates: number;
  /** Things that looked like an address but are not one. */
  invalid: string[];
}

const EMAIL = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[a-z]{2,}$/i;

export function isEmail(value: string): boolean {
  return value.length <= 320 && EMAIL.test(value);
}

export function normalizeEmail(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase();
}

const ANGLE = /(?:"([^"]*)"|([^<>,;\t"]*?))\s*<([^<>\s]+)>/g;
/** Anything with an @ in it, once the angle-bracket forms are taken out. */
const TOKEN = /[^\s,;<>]*@[^\s,;<>]*/g;
/** What wraps a pasted address: quotes, brackets, a trailing comma or full stop. */
const WRAPPING = /^["'([{]+|["')\]}.,;:]+$/g;

function cleanName(raw: string | undefined | null): string | null {
  const name = (raw ?? '')
    .replace(/["'<>]/g, ' ')
    .replace(/[\t,;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.includes('@') || name.length > 120 || !/\p{L}/u.test(name)) return null;
  return name;
}

export function parsePastedRecipients(text: string, max = 5_000): PasteResult {
  const seen = new Map<string, PastedRecipient>();
  const invalid: string[] = [];
  let duplicates = 0;

  const add = (rawEmail: string, name: string | null) => {
    const email = normalizeEmail(rawEmail.replace(/[.,;:]+$/, ''));
    if (!isEmail(email)) {
      if (invalid.length < 20) invalid.push(rawEmail.slice(0, 120));
      return;
    }
    const existing = seen.get(email);
    if (existing) {
      duplicates += 1;
      if (!existing.name && name) existing.name = name;
      return;
    }
    if (seen.size < max) seen.set(email, { email, name });
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    let rest = line;
    for (const m of line.matchAll(ANGLE)) {
      add(m[3] as string, cleanName(m[1] ?? m[2]));
      rest = rest.replace(m[0], ' ');
    }
    const bare = [...rest.matchAll(TOKEN)].map((m) => m[0]);
    if (bare.length === 1) {
      // One address on the line: whatever else is on it is the name
      // ("Jane Doe, jane@example.com", a spreadsheet row).
      const leftover = rest.replace(bare[0] as string, ' ');
      add(
        (bare[0] as string).replace(WRAPPING, ''),
        cleanName(leftover.split(/\t/).find((c) => cleanName(c)) ?? leftover),
      );
    } else {
      for (const address of bare) add(address.replace(WRAPPING, ''), null);
    }
  }

  return { recipients: [...seen.values()], duplicates, invalid };
}
