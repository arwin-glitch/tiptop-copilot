import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectAffinityKind,
  mappingProblems,
  mappingWarnings,
  parseAffinityCsv,
} from '@/lib/crm/affinity-csv';
import {
  buildIntroductionsImport,
  introductionId,
  isAffinityIntroductionsText,
  partyKeys,
  readAffinityIntroductions,
  recordIntroKeys,
  type AffinityIntroductionPayload,
} from '@/lib/crm/affinity-introductions';

/**
 * The introductions export parser, against invented files that mirror the
 * layout of Affinity's "Export all introductions in view": section titles,
 * a header per section, blank lines between. Every name and address is
 * fictional, on .example domains (and the demo fund's own nick@tiptop.demo).
 */

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const PEOPLE = readFileSync(path.join(FIXTURES, 'affinity_introductions_people.csv'), 'utf8');
const ORGS = readFileSync(path.join(FIXTURES, 'affinity_introductions_orgs.csv'), 'utf8');
const LIST = readFileSync(path.join(FIXTURES, 'harbor_seed_pipeline.csv'), 'utf8');

function read(text: string) {
  const out = readAffinityIntroductions(text);
  if (!out) throw new Error('expected an introductions export');
  return out;
}

function at(intros: AffinityIntroductionPayload[], lines: number[], line: number) {
  const i = lines.indexOf(line);
  if (i < 0) throw new Error(`no introduction from row ${line}`);
  return intros[i] as AffinityIntroductionPayload;
}

describe('recognising an introductions export', () => {
  it('tells it from a list or notes export by its opening section title', () => {
    expect(isAffinityIntroductionsText(PEOPLE)).toBe(true);
    expect(isAffinityIntroductionsText(ORGS)).toBe(true);
    expect(isAffinityIntroductionsText(LIST)).toBe(false);
    expect(readAffinityIntroductions(LIST)).toBeNull();
    // A title with the delimiters a spreadsheet pads it with is still a title.
    expect(isAffinityIntroductionsText('"Introductions Made To:",,,,\nA,B\n')).toBe(true);
    // A header that merely mentions introductions is not.
    expect(isAffinityIntroductionsText('Introductions Made By,Name,Email\n')).toBe(false);
  });

  it('is detected as its own kind when read as a table', () => {
    const csv = parseAffinityCsv(PEOPLE);
    expect(detectAffinityKind('Founders__introductions_export.csv', csv.headers)).toBe(
      'introductions',
    );
    expect(detectAffinityKind('pipeline.csv', parseAffinityCsv(LIST).headers)).toBe('list');
  });
});

describe('a person list export', () => {
  const { csv, mapping } = read(PEOPLE);

  it('reads all four sections and every row it can', () => {
    expect(mapping.sections.map((s) => [s.section, s.rows, s.unrecognised])).toEqual([
      ['made_by', 3, null],
      ['made_to', 2, null],
      ['source_people', 3, null],
      ['source_orgs', 2, null],
    ]);
    expect(mapping.introductions).toHaveLength(9);
    expect(mapping.unrecognised).toBeNull();
    expect(mappingProblems(mapping, csv)).toEqual([]);
    // A row with nobody named as the introducer is left out, by its row.
    expect(mapping.skipped).toEqual([
      {
        line: 10,
        message: 'No name or email for who made the introduction, so the row was skipped.',
      },
    ]);
    expect(mappingWarnings(mapping, csv).join(' ')).toContain('1 row has no name or email');
  });

  it('reads "made by" as the list person introducing the external person to the fund', () => {
    const intro = at(mapping.introductions, mapping.lines, 3);
    expect(intro.section).toBe('made_by');
    expect(intro.introducer).toEqual({
      kind: 'person',
      name: 'Hana Kuroda',
      email: 'hana@riverlight.example',
    });
    expect(intro.introduced.map((p) => p.email)).toEqual([
      'ada@brindlehealth.example',
      'nick@tiptop.demo',
    ]);
    expect(intro.date).toBe('2026-03-14');
    expect(intro.evidence).toBe('email');
    // A quoted name with a comma in it stays one name.
    expect(at(mapping.introductions, mapping.lines, 5).introducer.name).toBe('Okafor, Bea');
  });

  it('reads "made to" as someone introducing the list person', () => {
    const intro = at(mapping.introductions, mapping.lines, 9);
    expect(intro.introducer.name).toBe('Desmond Achterberg');
    expect(intro.introduced.map((p) => p.name)).toEqual(['Maren Solberg', 'Nick Tippmann']);
    expect(intro.date).toBe('2026-01-09');
  });

  it('reads sources, with or without a date, by email or by chat', () => {
    const handSet = at(mapping.introductions, mapping.lines, 15);
    expect(handSet.section).toBe('source_people');
    expect(handSet.date).toBeNull();
    expect(handSet.evidence).toBeNull();
    const chat = at(mapping.introductions, mapping.lines, 16);
    expect(chat.date).toBe('2026-05-05');
    expect(chat.evidence).toBe('chat');
    const company = at(mapping.introductions, mapping.lines, 20);
    expect(company.introduced).toEqual([
      { kind: 'company', name: 'Juniper Robotics', domain: 'juniperrobotics.example' },
    ]);
    // An organization with no domain is still read, by its name.
    expect(at(mapping.introductions, mapping.lines, 21).introduced[0]).toEqual({
      kind: 'company',
      name: 'Saltmarsh Labs',
      domain: null,
    });
  });

  it('previews one row per introduction, at its spreadsheet row', () => {
    expect(csv.headers).toEqual(['Section', 'Introduced by', 'Introduced', 'With', 'Date']);
    expect(csv.rows[0]).toEqual({
      line: 3,
      cells: {
        Section: 'Made by',
        'Introduced by': 'Hana Kuroda',
        Introduced: 'Ada Brennan',
        With: 'Nick Tippmann',
        Date: '2026-03-14',
      },
    });
  });
});

describe('an organization list export', () => {
  const people = read(PEOPLE).mapping;
  const { mapping } = read(ORGS);

  it('keeps the organization each person was exported under', () => {
    const intro = at(mapping.introductions, mapping.lines, 3);
    expect(intro.introducer.organization).toEqual({
      name: 'Riverlight Ventures',
      domain: 'riverlight.example',
    });
    expect(partyKeys(intro.introducer)).toEqual([
      'email:hana@riverlight.example',
      'domain:riverlight.example',
    ]);
    const madeTo = at(mapping.introductions, mapping.lines, 8);
    expect(madeTo.introduced[0]?.organization?.name).toBe('Quillmark');
  });

  it('gives one introduction the same identity in every file and section', () => {
    // The same email, "made by" Hana in both files.
    expect(at(mapping.introductions, mapping.lines, 3).externalId).toBe(
      at(people.introductions, people.lines, 3).externalId,
    );
    // "Made by" Desmond here is "made to" Maren in the person list.
    expect(at(mapping.introductions, mapping.lines, 4).externalId).toBe(
      at(people.introductions, people.lines, 9).externalId,
    );
    // A hand-set source of the same pair is a separate record of it.
    expect(at(people.introductions, people.lines, 14).externalId).not.toBe(
      at(people.introductions, people.lines, 3).externalId,
    );
  });
});

describe('layouts that vary', () => {
  it('reads semicolons, CRLF line endings, padded titles and lower-case headers alike', () => {
    const text =
      '﻿introductions made by:;;;;;;;\r\n' +
      'person name;person email;internal name;internal email;external name;external email;date;email id\r\n' +
      'Hana Kuroda;hana@riverlight.example;Nick Tippmann;nick@tiptop.demo;Ada Brennan;ADA@brindlehealth.example;2026-03-14;90001\r\n' +
      ';;;;;;;\r\n' +
      'SOURCE OF INTRODUCTION FOR PEOPLE:;;;;;;;\r\n' +
      'Person Name;Person Email;Person Introduced Name;Person Introduced Email;Date;Email ID;Date;Chat Message ID\r\n' +
      'Owen Thistlewood;owen@thistlewood.example;Imani Oduya;imani@quillmark.example;;;5/5/2026;77001\r\n';
    const { mapping } = read(text);
    expect(mapping.introductions).toHaveLength(2);
    const [first, second] = mapping.introductions;
    expect(first?.introduced[0]?.email).toBe('ada@brindlehealth.example');
    // The same introduction as the comma file's, whatever the file looked like.
    expect(first?.externalId).toBe(
      introductionId({
        introducer: { kind: 'person', name: 'Hana Kuroda', email: 'hana@riverlight.example' },
        introduced: [
          { kind: 'person', name: 'Ada Brennan', email: 'ada@brindlehealth.example' },
          { kind: 'person', name: 'Nick Tippmann', email: 'nick@tiptop.demo' },
        ],
        date: '2026-03-14',
      }),
    );
    expect(second?.evidence).toBe('chat');
  });

  it('reports a section it does not know, and still reads the others', () => {
    const text = [
      'Introductions Received By:',
      'Person Name,Person Email,Sender,When',
      'Hana Kuroda,hana@riverlight.example,Someone,3/14/2026',
      '',
      'Introductions Made To:',
      'Person Name,Person Email,Introducer Name,Introducer Email,Introducee Name,Introducee Email,Date,Email ID',
      'Maren Solberg,maren@oakhaven-capital.example,Desmond Achterberg,desmond@pinecrest-fo.example,,,1/9/2026,90004',
      '',
    ].join('\n');
    const { csv, mapping } = read(text);
    expect(mapping.introductions).toHaveLength(1);
    expect(mapping.introductions[0]?.introduced).toHaveLength(1);
    expect(mapping.sections[0]).toMatchObject({ section: null, rows: 1 });
    expect(mapping.sections[0]?.unrecognised).toContain('not a section Copilot knows');
    expect(mappingProblems(mapping, csv)).toEqual([]);
    expect(mappingWarnings(mapping, csv).join(' ')).toContain('“Introductions Received By:”');
  });

  it('imports nothing from a file whose columns it does not recognise, and says so', () => {
    const text = 'Introductions Made By:\nWho,Whom,When\nHana,Ada,3/14/2026\n';
    const { csv, mapping } = read(text);
    expect(mapping.introductions).toEqual([]);
    expect(mapping.sections[0]?.unrecognised).toContain('columns under “Introductions Made By:”');
    expect(mapping.unrecognised).toContain('does not recognise its layout');
    expect(mappingProblems(mapping, csv)).toEqual([mapping.unrecognised]);
    expect(buildIntroductionsImport(mapping).requests).toEqual([]);
  });

  it('treats a title with no header as unrecognised rather than reading rows as headers', () => {
    const text =
      'Introductions Made By:\nHana Kuroda,hana@riverlight.example,Nick Tippmann,nick@tiptop.demo,Ada Brennan,ada@brindlehealth.example,3/14/2026,90001\n';
    const { mapping } = read(text);
    expect(mapping.introductions).toEqual([]);
    expect(mapping.unrecognised).not.toBeNull();
  });

  it('says a file with only titles has no introductions', () => {
    const { csv, mapping } = read('Introductions Made By:\n\nIntroductions Made To:\n');
    expect(mapping.introductions).toEqual([]);
    expect(mappingProblems(mapping, csv)[0]).toMatch(/no introductions|does not recognise/);
  });

  it('keeps an introduction whose date cannot be read, without a date, and says so', () => {
    const text =
      'Introductions Made By:\nPerson Name,Person Email,External Name,External Email,Date,Email ID\n' +
      'Hana Kuroda,hana@riverlight.example,Ada Brennan,ada@brindlehealth.example,sometime in Q1,90001\n';
    const { csv, mapping } = read(text);
    expect(mapping.introductions[0]?.date).toBeNull();
    expect(mapping.introductions[0]?.evidence).toBe('email');
    expect(mapping.notices[0]?.line).toBe(3);
    expect(mappingWarnings(mapping, csv).join(' ')).toContain('1 date could not be read');
  });
});

describe('sending and linking', () => {
  it('chunks the introductions with the spreadsheet row of each', () => {
    const { mapping } = read(PEOPLE);
    const plan = buildIntroductionsImport(mapping, { rowsPerChunk: 4 });
    expect(plan.requests.map((r) => r.introductions.length)).toEqual([4, 4, 1]);
    expect(plan.lines[0]).toEqual([3, 4, 5, 9]);
    expect(plan.rowCount).toBe(9);
    expect(plan.skipped.map((s) => s.line)).toEqual([10]);
  });

  it('finds a record by the same keys a party is stored under', () => {
    expect(
      recordIntroKeys({
        kind: 'person',
        name: 'Ada  Brennan',
        emails: ['ada@brindlehealth.example'],
        domain: null,
      }),
    ).toEqual(['email:ada@brindlehealth.example', 'person:ada brennan']);
    expect(
      recordIntroKeys({
        kind: 'company',
        name: 'Juniper Robotics',
        emails: [],
        domain: 'juniperrobotics.example',
      }),
    ).toEqual(['domain:juniperrobotics.example', 'company:juniper robotics']);
    // A person with no email is found by name; with one, only by the email.
    expect(partyKeys({ kind: 'person', name: 'Sven Malmberg', email: null })).toEqual([
      'person:sven malmberg',
    ]);
    expect(
      partyKeys({ kind: 'person', name: 'Sven Malmberg', email: 'sven@kestrel-analytics.example' }),
    ).toEqual(['email:sven@kestrel-analytics.example']);
  });
});
