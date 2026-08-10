import { env } from '@/lib/config/env';

/**
 * Who is allowed through the front door.
 *
 * The login screen promises that "access is limited to members of the TipTop
 * organization". Nothing in the database enforced that: the
 * `on_auth_user_created` trigger provisions an organization with owner role for
 * *every* new user, so without this check any Google account that reaches the
 * callback would receive its own working workspace.
 *
 * Kept as a pure function so it can be tested without a Supabase project, and
 * so the callback route and the diagnostics screen cannot disagree.
 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowed = env().authAllowedDomains;
  // No allowlist configured means no restriction. Deliberate: a first
  // deployment must not lock its own operator out. `/diagnostics` says so.
  if (allowed.length === 0) return true;
  if (!email) return false;
  const domain = emailDomain(email);
  return domain !== null && allowed.includes(domain);
}

/** For the message shown to someone who was turned away. */
export function allowedDomainsLabel(): string {
  return env()
    .authAllowedDomains.map((d) => `@${d}`)
    .join(', ');
}
