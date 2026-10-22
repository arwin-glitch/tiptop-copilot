import { describe, expect, it } from 'vitest';
import {
  guessMapping,
  guestExportCsv,
  guestExportRows,
  headcounts,
  parseGuestCsv,
  parsePastedEmails,
  previewImport,
} from '@/lib/events/csv';
import type { RegistrationQuestion } from '@/lib/events/registration';
import type { EventGuest, EventGuestSession, EventSession } from '@/lib/types/domain';

/**
 * Guest CSV (D-075): the export (a row per guest and per plus-one, every
 * answer, removed questions marked, formula cells neutralised), the caterer
 * headcount, and the import's detection and preview. Fictional people.
 */

const NOW = '2030-01-10T12:00:00.000Z';
const S1 = '00000000-0000-4000-8000-00000000c001';
const S2 = '00000000-0000-4000-8000-00000000c002';
const Q_DIET = '00000000-0000-4000-8000-00000000d001';
const Q_OLD = '00000000-0000-4000-8000-00000000d002';

function guest(id: string, over: Partial<EventGuest> = {}): EventGuest {
  return {
    id,
    organization_id: 'o',
    event_id: 'e',
    parent_guest_id: null,
    email: `${id}@example.com`,
    first_name: 'Sam',
    last_name: id,
    company: 'Example Co',
    title: null,
    phone: null,
    record_id: null,
    tags: [],
    host_note: 'never exported',
    answers: {},
    source: 'invite',
    token_version: 1,
    show_on_wall: false,
    referral_code: null,
    utm: null,
    ip_hash: null,
    notified_status: {},
    registered_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function row(
  guestId: string,
  sessionId: string,
  status: EventGuestSession['status'],
  checkedIn: string | null = null,
): EventGuestSession {
  return {
    guest_id: guestId,
    session_id: sessionId,
    organization_id: 'o',
    event_id: 'e',
    status,
    requested_at: NOW,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    claim_expires_at: null,
    checked_in_at: checkedIn,
    checked_in_by: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const sessions = [
  { id: S1, name: 'Meeting', position: 0, capacity: 80 },
  { id: S2, name: 'Reception', position: 1, capacity: 125 },
] as EventSession[];

const questions: RegistrationQuestion[] = [
  {
    id: Q_DIET,
    type: 'dietary',
    label: 'Dietary needs',
    help: null,
    required: false,
    options: [],
    session_id: S2,
    ask_plus_ones: true,
    position: 0,
    removed_at: null,
  },
  {
    id: Q_OLD,
    type: 'short_text',
    label: 'Shirt size',
    help: null,
    required: false,
    options: [],
    session_id: null,
    ask_plus_ones: false,
    position: 1,
    removed_at: NOW,
  },
];

const host = guest('host', {
  tags: ['LP', 'VIP'],
  answers: { [Q_DIET]: ['Vegan', 'Other'], [`${Q_DIET}:note`]: 'No sesame', [Q_OLD]: 'M' },
});
const plusOne = guest('plus', {
  parent_guest_id: 'host',
  email: null,
  first_name: 'Rowan',
  answers: { [Q_DIET]: ['Vegetarian'] },
  source: 'plus_one',
});
const sneaky = guest('sneaky', {
  first_name: '=HYPERLINK("http://evil.example")',
  company: '+cmd',
});
const rows = [
  row('host', S1, 'going', '2030-01-25T19:05:00.000Z'),
  row('host', S2, 'going'),
  row('plus', S2, 'going'),
  row('sneaky', S1, 'waitlist'),
];

describe('export', () => {
  it('has a row per guest and per plus-one, plus-ones after their host', () => {
    const out = guestExportRows({
      guests: [plusOne, sneaky, host],
      rows,
      sessions,
      questions,
      timeZone: 'America/Chicago',
    });
    const header = out[0]!;
    expect(header).toContain('Status: Meeting');
    expect(header).toContain('Checked in: Reception');
    expect(header).toContain('(removed) Shirt size');
    expect(header).not.toContain('Host note');
    const names = out.slice(1).map((r) => r[0]);
    expect(names.indexOf('Rowan')).toBe(names.indexOf('Sam') + 1);
    const hostRow = out.find((r) => r[1] === 'host')!;
    expect(hostRow[header.indexOf('Tags')]).toBe('LP; VIP');
    expect(hostRow[header.indexOf('Dietary needs')]).toBe('Vegan, Other – No sesame');
    expect(hostRow[header.indexOf('Checked in: Meeting')]).toBe('2030-01-25 13:05');
    const plusRow = out.find((r) => r[0] === 'Rowan')!;
    expect(plusRow[header.indexOf('Plus-one of')]).toBe('Sam host');
  });

  it('neutralises formula cells and never exports host notes', () => {
    const csv = guestExportCsv({ guests: [sneaky], rows, sessions, questions, timeZone: 'UTC' });
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(csv).toContain("'+cmd");
    expect(csv).not.toContain('never exported');
  });

  it('counts heads per session for the caterer', () => {
    const counts = headcounts({
      guests: [host, plusOne, sneaky],
      rows,
      sessions,
      questions,
      timeZone: 'UTC',
    });
    expect(counts[1]).toMatchObject({
      name: 'Reception',
      going: 2,
      plusOnes: 1,
      dietary: { Vegan: 1, Other: 1, Vegetarian: 1 },
    });
    expect(counts[0]).toMatchObject({ name: 'Meeting', going: 1, waitlist: 1, checkedIn: 1 });
  });
});

describe('import', () => {
  it('maps known headers and question labels', () => {
    const csv = parseGuestCsv(
      '﻿First Name,Last Name,E-mail,Company,Tags,Dietary needs\nAvery,Quill,AVERY@example.com,Northwind,LP; VIP,Vegan\n',
    );
    const mapping = guessMapping(csv, questions);
    expect(mapping).toMatchObject({
      'First Name': 'first_name',
      'Last Name': 'last_name',
      'E-mail': 'email',
      Company: 'company',
      Tags: 'tags',
      'Dietary needs': `question:${Q_DIET}`,
    });
    const preview = previewImport(csv, mapping);
    expect(preview.people[0]).toMatchObject({
      email: 'avery@example.com',
      tags: ['LP', 'VIP'],
      answers: { [Q_DIET]: 'Vegan' },
    });
  });

  it('finds the email column by its contents, dedupes and reports bad rows', () => {
    const csv = parseGuestCsv(
      'Who;Contact\nBianca Moreau;bianca@example.com\nCarlos;not-an-email\nAgain;BIANCA@example.com\n',
    );
    const mapping = guessMapping(csv, []);
    expect(mapping.Contact).toBe('email');
    expect(mapping.Who).toBe('ignore');
    const preview = previewImport(csv, { ...mapping, Who: 'full_name' });
    expect(preview.people).toHaveLength(1);
    expect(preview.people[0]).toMatchObject({ first_name: 'Bianca', last_name: 'Moreau' });
    expect(preview.invalidLines).toEqual([3]);
    expect(preview.duplicateInFile).toBe(1);
  });

  it('reads pasted emails in any separator, with names around them', () => {
    const { emails, invalid } = parsePastedEmails(
      'Dana <dana@example.com>, eli@example.com\n\nELI@example.com; bad@nope',
    );
    expect(emails).toEqual(['dana@example.com', 'eli@example.com']);
    expect(invalid).toEqual(['bad@nope']);
  });
});
