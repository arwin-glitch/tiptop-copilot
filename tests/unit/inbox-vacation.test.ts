import { describe, expect, it } from 'vitest';
import {
  VACATION_OFF,
  vacationActive,
  vacationConfirmText,
  vacationProblem,
} from '@/lib/email/vacation';

const ON = { ...VACATION_OFF, enabled: true, subject: 'Out of office', html: 'Back Monday.' };

describe('vacation responder', () => {
  it('is active only while on and inside its dates', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(vacationActive(VACATION_OFF, now)).toBe(false);
    expect(vacationActive(ON, now)).toBe(true);
    expect(vacationActive({ ...ON, start: '2026-11-11T00:00:00Z' }, now)).toBe(false);
    expect(vacationActive({ ...ON, end: '2026-11-09T00:00:00Z' }, now)).toBe(false);
    expect(vacationActive(null, now)).toBe(false);
  });

  it('refuses an empty or backwards responder, never one being turned off', () => {
    expect(vacationProblem({ ...ON, subject: '', html: '<br>' })).toMatch(/subject or a message/);
    expect(
      vacationProblem({ ...ON, start: '2026-11-12T00:00:00Z', end: '2026-11-11T00:00:00Z' }),
    ).toMatch(/after the first day/);
    expect(vacationProblem({ ...VACATION_OFF })).toBeNull();
    expect(vacationProblem(ON)).toBeNull();
  });

  it('says plainly that it will auto-reply, and to whom', () => {
    expect(vacationConfirmText(ON, 'partner@firm.example')).toMatch(
      /automatically reply to incoming mail from everyone who emails you until you turn it off/,
    );
    expect(vacationConfirmText({ ...ON, domainOnly: true }, 'partner@firm.example')).toMatch(
      /people at firm\.example/,
    );
    expect(
      vacationConfirmText({ ...ON, contactsOnly: true, domainOnly: true }, 'partner@firm.example'),
    ).toMatch(/people in your Contacts at firm\.example/);
  });
});
