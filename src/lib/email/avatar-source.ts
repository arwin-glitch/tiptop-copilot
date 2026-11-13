/**
 * Where a sender's picture comes from, for the Inbox's avatars (Gmail shows a
 * photo or a brand logo where it has one, the initial otherwise):
 *
 *   1. their Gravatar, when they have set one (looked up by a hash of the
 *      address, never the address itself);
 *   2. for a company address, the company's logo (its site icon, by domain);
 *   3. nothing: the avatar keeps the initial.
 *
 * Pure helpers; the route (app/api/avatar) fetches and keeps the result.
 */

const ADDRESS = /^[^\s@<>"]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/** Personal mail: the domain's logo would be Gmail's, not the person's. */
const PERSONAL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'hey.com',
  'fastmail.com',
  'qq.com',
  '163.com',
]);

/** A clean, lower-case address, or null when it is not one. */
export function avatarAddress(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return v.length <= 254 && ADDRESS.test(v) ? v : null;
}

/** The domain whose logo stands for this address, or null for personal mail. */
export function logoDomain(address: string): string | null {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (PERSONAL_DOMAINS.has(domain)) return null;
  // mail.acme.com and acme.com share a logo; keep the last two labels
  // (three for a two-letter country pair like acme.co.uk).
  const parts = domain.split('.');
  const keep = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function gravatarUrl(sha256Hex: string, size = 96): string {
  return `https://gravatar.com/avatar/${sha256Hex}?d=404&s=${size}`;
}

export function logoUrl(domain: string, size = 64): string {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(`https://${domain}`)}&size=${size}`;
}
