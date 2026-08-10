import { afterEach, describe, expect, it } from 'vitest';
import { allowedDomainsLabel, emailDomain, isEmailAllowed } from '@/lib/auth/domain';
import { resetEnvCache } from '@/lib/config/env';

/**
 * The front door.
 *
 * The login screen states that access is limited to members of the TipTop
 * organization. Nothing enforced that: `on_auth_user_created` provisions an
 * organization with owner role for every new `auth.users` row, so any account
 * completing the OAuth callback would have received its own workspace.
 */

const SAVED = { ...process.env };

function setDomains(value: string | undefined): void {
  if (value === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
  else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = value;
  resetEnvCache();
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED)) delete process.env[key];
  }
  Object.assign(process.env, SAVED);
  resetEnvCache();
});

describe('emailDomain', () => {
  it('reads the domain', () => {
    expect(emailDomain('nick@tiptop.vc')).toBe('tiptop.vc');
  });

  it('lowercases, because Google does not promise a case', () => {
    expect(emailDomain('Nick@TipTop.VC')).toBe('tiptop.vc');
  });

  it('takes the last @, so a quoted local part cannot smuggle a domain', () => {
    expect(emailDomain('"a@evil.com"@tiptop.vc')).toBe('tiptop.vc');
  });

  it('returns null for malformed addresses rather than guessing', () => {
    expect(emailDomain('nick')).toBeNull();
    expect(emailDomain('nick@')).toBeNull();
    expect(emailDomain('')).toBeNull();
  });
});

describe('isEmailAllowed', () => {
  it('permits everything when no allowlist is set', () => {
    // Deliberate: a first deployment must not lock its own operator out.
    // /diagnostics reports this state as missing rather than ready.
    setDomains(undefined);
    expect(isEmailAllowed('anyone@example.com')).toBe(true);
  });

  it('permits a listed domain', () => {
    setDomains('tiptop.vc');
    expect(isEmailAllowed('nick@tiptop.vc')).toBe(true);
  });

  it('rejects an unlisted domain', () => {
    setDomains('tiptop.vc');
    expect(isEmailAllowed('someone@gmail.com')).toBe(false);
  });

  it('rejects a lookalike rather than matching on a suffix', () => {
    setDomains('tiptop.vc');
    expect(isEmailAllowed('attacker@nottiptop.vc')).toBe(false);
    expect(isEmailAllowed('attacker@tiptop.vc.evil.com')).toBe(false);
  });

  it('rejects a missing address when an allowlist exists', () => {
    setDomains('tiptop.vc');
    expect(isEmailAllowed(null)).toBe(false);
    expect(isEmailAllowed(undefined)).toBe(false);
    expect(isEmailAllowed('')).toBe(false);
  });

  it('accepts several domains, tolerating spacing and a leading @', () => {
    setDomains(' @tiptop.vc , TipTop.Ventures ');
    expect(isEmailAllowed('nick@tiptop.vc')).toBe(true);
    expect(isEmailAllowed('arwin@tiptop.ventures')).toBe(true);
    expect(isEmailAllowed('x@elsewhere.com')).toBe(false);
  });

  it('labels the permitted domains for the rejection notice', () => {
    setDomains('tiptop.vc,tiptop.ventures');
    expect(allowedDomainsLabel()).toBe('@tiptop.vc, @tiptop.ventures');
  });
});
