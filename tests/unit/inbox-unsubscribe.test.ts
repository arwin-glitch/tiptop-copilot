import { describe, expect, it } from 'vitest';
import { parseUnsubscribe, unsubscribeHow } from '@/lib/email/unsubscribe';

describe('List-Unsubscribe parsing', () => {
  it('reads one-click (RFC 8058) when both headers say so', () => {
    const o = parseUnsubscribe(
      '<mailto:leave@news.demo?subject=stop>, <https://news.demo/u/abc123>',
      'List-Unsubscribe=One-Click',
    )!;
    expect(o.http).toBe('https://news.demo/u/abc123');
    expect(o.mailto).toEqual({ to: 'leave@news.demo', subject: 'stop', body: '' });
    expect(o.oneClick).toBe(true);
    expect(unsubscribeHow(o)).toBe('one-click');
  });

  it('without the Post header a link is only a link; mailto wins over a plain link', () => {
    const o = parseUnsubscribe('<https://news.demo/u/1>, <mailto:leave@news.demo>', null)!;
    expect(o.oneClick).toBe(false);
    expect(unsubscribeHow(o)).toBe('email');
    expect(unsubscribeHow(parseUnsubscribe('<https://news.demo/u/1>', null)!)).toBe('link');
  });

  it('never takes http, javascript: or credentials in a link', () => {
    expect(parseUnsubscribe('<http://news.demo/u/1>', 'List-Unsubscribe=One-Click')).toBeNull();
    expect(parseUnsubscribe('<javascript:alert(1)>', null)).toBeNull();
    expect(parseUnsubscribe('<https://user:pw@news.demo/u>', null)).toBeNull();
    expect(parseUnsubscribe('', null)).toBeNull();
    expect(parseUnsubscribe('<mailto:not-an-address>', null)).toBeNull();
  });

  it('a mailto subject or body cannot carry header breaks', () => {
    const o = parseUnsubscribe(
      '<mailto:leave@news.demo?subject=a%0D%0ABcc:x@y.demo&body=hi>',
      null,
    )!;
    expect(o.mailto!.subject).not.toMatch(/[\r\n]/);
    expect(o.mailto!.body).toBe('hi');
  });
});
