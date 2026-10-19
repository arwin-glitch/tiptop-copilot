const ADDRESS =
  /^\s*(?:[^<>,]*<\s*[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+\s*>|[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+)\s*$/;

/** "a@x.com, Jane <j@y.com>" -> validated list, or null when any part is not an address. */
export function parseAddresses(value: string, max = 20): string[] | null {
  const parts = value
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > max || parts.some((p) => !ADDRESS.test(p))) return null;
  return parts;
}

/**
 * The address in a From header ("Name <a@b>", or a bare address); '' when
 * there is none. The last <...> is the address; one before it is part of
 * the display name, as in `"Nick <nick@x.com>" <someone@else.example>`.
 */
export function addressOf(from: string): string {
  const bracketed = [...from.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].at(-1)?.[1];
  if (bracketed) return bracketed;
  const bare = from.trim();
  return /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? bare : '';
}

/**
 * Whether a From header is the mailbox's own address, exactly: a lookalike
 * such as "Nick <nick@x.com.other.example>" is someone else.
 */
export function isFromMailbox(from: string, mailbox: string): boolean {
  const own = mailbox.trim().toLowerCase();
  return Boolean(own) && addressOf(from).toLowerCase() === own;
}
