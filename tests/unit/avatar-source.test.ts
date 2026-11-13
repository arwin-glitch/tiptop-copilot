import { describe, expect, it } from 'vitest';
import { avatarAddress, logoDomain, logoUrl } from '@/lib/email/avatar-source';

/** Inbox avatars: a photo or a company logo, never a personal-mail logo. */
describe('avatar source', () => {
  it('takes clean addresses only', () => {
    expect(avatarAddress(' Sam@Example.TEST ')).toBe('sam@example.test');
    expect(avatarAddress('Sam <sam@example.test>')).toBeNull();
    expect(avatarAddress('not an address')).toBeNull();
    expect(avatarAddress(null)).toBeNull();
  });

  it('uses the company domain, never a personal-mail one', () => {
    expect(logoDomain('sam@mail.acme-demo.test')).toBe('acme-demo.test');
    expect(logoDomain('sam@acme-demo.co.uk')).toBe('acme-demo.co.uk');
    expect(logoDomain('sam@gmail.com')).toBeNull();
    expect(logoDomain('sam@outlook.com')).toBeNull();
    expect(logoUrl('acme-demo.test')).toContain(encodeURIComponent('https://acme-demo.test'));
  });
});
