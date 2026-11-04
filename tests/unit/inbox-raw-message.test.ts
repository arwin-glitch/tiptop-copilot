import { describe, expect, it } from 'vitest';
import {
  demoRawMessage,
  emlFileName,
  originalSummary,
  parseHeaders,
} from '@/lib/email/raw-message';

const SOURCE = [
  'Message-ID: <abc@mail.example>',
  'Date: Tue, 3 Nov 2026 10:00:00 +0000',
  'From: Jane Doe <jane@founder.example>',
  'To: partner@firm.example',
  'Subject: A long',
  ' folded subject',
  'Authentication-Results: mx.example; spf=pass smtp.mailfrom=x; dkim=fail; dmarc=pass',
  '',
  'Body line: not a header',
].join('\r\n');

describe('original message', () => {
  it('reads headers, folded lines joined, and stops at the body', () => {
    const headers = parseHeaders(SOURCE);
    expect(headers.find((h) => h.name === 'Subject')?.value).toBe('A long folded subject');
    expect(headers.some((h) => h.name === 'Body line')).toBe(false);
  });

  it("summarises like Gmail's Show original", () => {
    const rows = Object.fromEntries(
      originalSummary(parseHeaders(SOURCE)).map((r) => [r.name, r.value]),
    );
    expect(rows['Message ID']).toBe('<abc@mail.example>');
    expect(rows.SPF).toBe('PASS');
    expect(rows.DKIM).toBe('FAIL');
    expect(rows.DMARC).toBe('PASS');
  });

  it('makes a safe .eml name', () => {
    expect(emlFileName('Re: Q3 / numbers? <draft>')).toBe('Re Q3 numbers draft.eml');
    expect(emlFileName('   ')).toBe('message.eml');
  });

  it('builds the demo stand-in from fictional fields', () => {
    const raw = demoRawMessage({
      id: 'd1',
      from: 'Jane Doe <jane@founder.example>',
      to: 'partner@firm.example',
      cc: '',
      at: '2026-11-03T10:00:00.000Z',
      subject: 'Hello',
      text: 'Hi\nthere',
    });
    expect(parseHeaders(raw).find((h) => h.name === 'Subject')?.value).toBe('Hello');
    expect(raw.endsWith('Hi\r\nthere\r\n')).toBe(true);
  });
});
