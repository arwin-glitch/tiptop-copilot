/**
 * The address in a person page's URL (/network/person/<email>), and the link
 * to it. Pure, so the Network table (a client component), Ctrl+K and the
 * hover preview build the same link the page reads.
 */

/** Strict: one address, plain characters, no spaces or URL syntax. */
const EMAIL =
  /^[a-z0-9.!#$&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The address a raw route value names, lower case, or null when it is not one address. */
export function parsePersonEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

/** The page for one person from mail and calendar. */
export function personPagePath(email: string): string {
  return `/network/person/${encodeURIComponent(email.trim().toLowerCase())}`;
}
