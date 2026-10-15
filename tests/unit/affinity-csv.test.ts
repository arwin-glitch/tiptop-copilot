import { describe, expect, it } from 'vitest';
import {
  addCounts,
  affinityDomain,
  affinityNoteId,
  AFFINITY_IMPORT_LIMITS,
  buildListImport,
  buildNotesImport,
  compareAffinityOptions,
  defaultListName,
  detectAffinityKind,
  detectAffinityMapping,
  detectEntityType,
  detectListMapping,
  detectNotesMapping,
  inferColumnType,
  listFieldColumns,
  listFields,
  mappingProblems,
  mappingWarnings,
  NO_COUNTS,
  parseAffinityCsv,
  parseAffinityDate,
  suggestTargetList,
  type AffinityExistingList,
  type AffinityListMapping,
  type AffinityNotesMapping,
} from '@/lib/crm/affinity-csv';
import { CRM_UPSERT_BATCH_MAX } from '@/lib/services/crm';

/**
 * Reading Affinity's CSV exports. Every company, person, address and amount
 * below is invented, on .example domains.
 */

const DEALS = `Affinity Row ID,Opportunity ID,Opportunity Name,Organizations,Status,Amount,Owners,Date Added,Close Date,Fund,Source Channel,Time in Current Status
9001,7001,Lumenfold Seed,Lumenfold Labs,3. First Meeting,"$1,500,000",Avery Quill; Rowan Pike,10/01/2026,2026-11-30,Fund II,Referral,12 days
9002,7002,Quarrystone Pre-Seed,Quarrystone,5. Due Diligence,$750K,Avery Quill,10/03/2026,,Fund II,Inbound,3 days
9003,7003,Lumenfold Series A,Lumenfold Labs,8.2 Passed - Too Early,2000000,Rowan Pike,09/12/2026,,Fund I,Referral,30 days
9004,7004,Tidewell Seed,Tidewell,10. Won / Signed,"$500,000",Avery Quill,08/20/2026,2026-09-15,Fund II,Event,45 days
9005,7005,Brackenridge Seed,Brackenridge Energy,3. First Meeting,,Rowan Pike,10/10/2026,,Fund II,Inbound,5 days
`;

const ORGS =
  '﻿Organization ID, Organization Name ,Website,Industry,Last Contact,Employees\r\n' +
  '3101,Harborlight Analytics,https://www.harborlight.example/about,AI; Data,2026-09-30,45\r\n' +
  '3102,"Fernhollow, Inc.",fernhollow.example,Fintech,2026-08-12,120\r\n' +
  '3103,Gildcrest Robotics,linkedin.com/company/gildcrest-robotics,Robotics; AI,,8\r\n';

const PEOPLE = `Person ID,First Name,Last Name,Primary Email,Email Addresses,Organizations,Status,Commitment
5201,Juniper,Okafor,juniper@ashgrove-capital.example,juniper@ashgrove-capital.example; j.okafor@mail.example,Ashgrove Capital,Committed,"$250,000"
5202,Theo,Marchetti,,theo@marchetti-fo.example,Marchetti Family Office,Interested,
5203,,,,,,,
`;

const NOTES = `Entity Name,Entity Type,Creator,Date Created,Note Content,Associated Organizations,Associated People
Lumenfold Seed,Opportunity,Avery Quill,2026-10-02 14:05:00,"First call with the founders.
- Strong technical team
- Asked about ""design partners""",Lumenfold Labs,Juniper Okafor
Harborlight Analytics,Organization,Rowan Pike,10/05/2026,Quick intro; follow up in Q1.,,
Harborlight Analytics,Organization,Rowan Pike,10/06/2026,,,
`;

function listMapping(filename: string, text: string) {
  const csv = parseAffinityCsv(text);
  const mapping = detectAffinityMapping(filename, csv);
  expect(mapping.kind).toBe('list');
  return { csv, mapping: mapping as AffinityListMapping };
}

describe('parsing', () => {
  it('strips a byte-order mark and trims headers', () => {
    const csv = parseAffinityCsv(ORGS);
    expect(csv.headers).toEqual([
      'Organization ID',
      'Organization Name',
      'Website',
      'Industry',
      'Last Contact',
      'Employees',
    ]);
    expect(csv.rows[1]?.cells['Organization Name']).toBe('Fernhollow, Inc.');
  });

  it('keeps quoted multi-line cells whole, with escaped quotes undone', () => {
    const csv = parseAffinityCsv(NOTES);
    expect(csv.rows[0]?.cells['Note Content']).toBe(
      'First call with the founders.\n- Strong technical team\n- Asked about "design partners"',
    );
    expect(csv.rows).toHaveLength(3);
  });

  it('numbers rows as a spreadsheet does, counting the header and blank lines', () => {
    const csv = parseAffinityCsv('Name,Note\n"Lumenfold Labs","two\nlines"\n\nQuarrystone,x\n');
    expect(csv.rows.map((r) => [r.line, r.cells.Name])).toEqual([
      [2, 'Lumenfold Labs'],
      [4, 'Quarrystone'],
    ]);
  });

  it('reads a semicolon-delimited file without splitting multi-value cells', () => {
    const csv = parseAffinityCsv(
      'Organization Name;Industry;Website\nTidewell;"AI; Climate";tidewell.example\n',
    );
    expect(csv.headers).toEqual(['Organization Name', 'Industry', 'Website']);
    expect(csv.rows[0]?.cells.Industry).toBe('AI; Climate');
  });

  it('warns about a row with more cells than columns', () => {
    const csv = parseAffinityCsv('Name,Status\nTidewell,Active,extra\n');
    expect(csv.warnings).toEqual([
      'Row 2 has more cells than there are columns; the extra cells were left out.',
    ]);
    expect(csv.rows[0]?.cells).toEqual({ Name: 'Tidewell', Status: 'Active' });
  });

  it('suffixes duplicate headers instead of losing a column', () => {
    const csv = parseAffinityCsv('Name,Name,Status\nTidewell,Tidewell Co,Active\n');
    expect(csv.headers).toHaveLength(3);
    expect(new Set(csv.headers).size).toBe(3);
  });
});

describe('dates', () => {
  it('reads the formats Affinity writes, strictly', () => {
    expect(parseAffinityDate('2026-03-14')).toEqual({ kind: 'date', value: '2026-03-14' });
    expect(parseAffinityDate('3/14/2026')).toEqual({ kind: 'date', value: '2026-03-14' });
    expect(parseAffinityDate('Mar 14, 2026')).toEqual({ kind: 'date', value: '2026-03-14' });
    expect(parseAffinityDate('14 March 2026')).toEqual({ kind: 'date', value: '2026-03-14' });
    expect(parseAffinityDate('2026/03/14')).toEqual({ kind: 'date', value: '2026-03-14' });
  });

  it('reads a time without a zone as UTC, and honours an explicit offset', () => {
    expect(parseAffinityDate('2026-03-14 15:22:10')?.value).toBe('2026-03-14T15:22:10.000Z');
    expect(parseAffinityDate('3/14/2026 3:04 PM')?.value).toBe('2026-03-14T15:04:00.000Z');
    expect(parseAffinityDate('3/14/2026 12:30 AM')?.value).toBe('2026-03-14T00:30:00.000Z');
    expect(parseAffinityDate('2026-03-14T10:00:00-05:00')?.value).toBe('2026-03-14T15:00:00.000Z');
    expect(parseAffinityDate('2026-03-14 10:00:00 UTC')?.value).toBe('2026-03-14T10:00:00.000Z');
  });

  it('reads the dates a spreadsheet writes back after the export is opened and saved', () => {
    const day = { kind: 'date', value: '2026-10-02' };
    expect(parseAffinityDate('10/2/26')).toEqual(day);
    expect(parseAffinityDate('02.10.2026')).toEqual(day);
    expect(parseAffinityDate('2.10.26')).toEqual(day);
    expect(parseAffinityDate('2-Oct-2026')).toEqual(day);
    expect(parseAffinityDate('02-Oct-26')).toEqual(day);
    expect(parseAffinityDate('Fri, Oct 2, 2026')).toEqual(day);
    expect(parseAffinityDate('Friday, October 2nd, 2026')).toEqual(day);
    expect(parseAffinityDate('10/2/26 14:05')?.value).toBe('2026-10-02T14:05:00.000Z');
    // Two-digit years as Excel reads them.
    expect(parseAffinityDate('3/14/98')).toEqual({ kind: 'date', value: '1998-03-14' });
    expect(parseAffinityDate('3/14/29')).toEqual({ kind: 'date', value: '2029-03-14' });
  });

  it('honours a zone abbreviation, and refuses one it does not know', () => {
    expect(parseAffinityDate('10/2/2026 14:05 CDT')?.value).toBe('2026-10-02T19:05:00.000Z');
    expect(parseAffinityDate('10/2/2026 2:05 PM EST')?.value).toBe('2026-10-02T19:05:00.000Z');
    expect(parseAffinityDate('2026-10-02 14:05 GMT')?.value).toBe('2026-10-02T14:05:00.000Z');
    expect(parseAffinityDate('10/2/2026 14:05 QQT')).toBeNull();
  });

  it('rejects what only looks like a date', () => {
    for (const raw of [
      '2/30/2026',
      'Q3 2026',
      '5',
      '12 days',
      '2026',
      '',
      '13/01/2026',
      '31.02.2026',
      '1.2.3',
    ]) {
      expect(parseAffinityDate(raw)).toBeNull();
    }
  });
});

describe('warnings before importing', () => {
  it('says how many note dates cannot be read, without blocking the import', () => {
    const csv = parseAffinityCsv(
      'Entity Name,Date Created,Note Content\nTidewell,10/2/26 14:05,Call\nQuarrystone,sometime in May,Call\nLumenfold Labs,around Easter,Call\n',
    );
    const mapping = detectNotesMapping(csv);
    expect(mappingProblems(mapping, csv)).toEqual([]);
    expect(mappingWarnings(mapping, csv)).toEqual([
      expect.stringMatching(
        /^2 notes have dates Copilot cannot read, such as “sometime in May”, so they will be imported without a date\./,
      ),
    ]);
    expect(mappingWarnings({ ...mapping, dateColumn: null }, csv)).toEqual([
      'No date column is chosen, so the notes will be imported without dates.',
    ]);
  });

  it('says which date columns of a list have cells that are not dates', () => {
    const csv = parseAffinityCsv(
      'Organization Name,Close Date\nTidewell,2026-11-30\nQuarrystone,TBD\nLumenfold Labs,12/01/2026\n',
    );
    const mapping = detectListMapping('Portfolio.csv', csv);
    expect(mappingWarnings(mapping, csv)).toEqual([]);
    const asDates = { ...mapping, types: { ...mapping.types, 'Close Date': 'date' as const } };
    expect(mappingWarnings(asDates, csv)).toEqual([
      '1 cell in “Close Date” is not a date Copilot can read, such as “TBD”. It is kept as text and will not sort as dates.',
    ]);
  });
});

describe('choosing the list a file updates', () => {
  const lists: AffinityExistingList[] = [
    {
      id: 'l-1',
      name: 'Startup Deal Pipeline',
      entityType: 'deal',
      archived: false,
      entryCount: 4,
    },
    {
      id: 'l-2',
      name: 'Startup Deal Pipeline - Q4',
      entityType: 'deal',
      archived: false,
      entryCount: 2,
    },
    { id: 'l-3', name: 'LP Pipeline', entityType: 'person', archived: false, entryCount: 5 },
    { id: 'l-4', name: 'Portfolio', entityType: 'company', archived: true, entryCount: 4 },
  ];
  const suggest = (file: string, entityType: AffinityExistingList['entityType']) =>
    suggestTargetList(file, defaultListName(file), entityType, lists)?.id ?? null;

  it('picks the list with the name the file suggests', () => {
    expect(suggest('Startup Deal Pipeline - All deals.csv', 'deal')).toBe('l-1');
    expect(suggest('lp pipeline.csv', 'person')).toBe('l-3');
    // Archived, but still the list this file updates.
    expect(suggest('Portfolio.csv', 'company')).toBe('l-4');
  });

  it('picks the list a second saved view of it belongs to, the longest name first', () => {
    expect(defaultListName('Startup Deal Pipeline - Active Pipeline.csv')).toBe(
      'Startup Deal Pipeline - Active Pipeline',
    );
    expect(suggest('Startup Deal Pipeline - Active Pipeline.csv', 'deal')).toBe('l-1');
    expect(suggest('Startup Deal Pipeline - Q4 - Hot.csv', 'deal')).toBe('l-2');
  });

  it('suggests nothing for a list of another kind, or a list that is new', () => {
    expect(suggest('LP Pipeline.csv', 'deal')).toBeNull();
    expect(suggest('Angels.csv', 'person')).toBeNull();
    expect(suggest('Startup Deal Pipelines.csv', 'deal')).toBeNull();
  });

  it('sends the chosen list with every request', () => {
    const { csv, mapping } = listMapping('Startup Deal Pipeline - Active.csv', DEALS);
    expect(mapping.targetListId).toBeNull();
    expect(buildListImport(mapping, csv).requests[0]?.list.id).toBeUndefined();
    const plan = buildListImport({ ...mapping, targetListId: 'l-1' }, csv, { rowsPerChunk: 2 });
    expect(plan.requests.map((r) => r.list.id)).toEqual(['l-1', 'l-1', 'l-1']);
  });
});

describe('column types', () => {
  it('infers types from values', () => {
    expect(inferColumnType('Close Date', ['2026-11-30', '', '10/01/2026'])).toBe('date');
    expect(inferColumnType('Amount', ['$1,500,000', '$750K', '2000000'])).toBe('money');
    expect(inferColumnType('Check Size', ['250000', '500000'])).toBe('money');
    expect(inferColumnType('Employees', ['45', '120', '8'])).toBe('number');
    expect(inferColumnType('Contact', ['a@tidewell.example', 'b@quarry.example'])).toBe('email');
    expect(inferColumnType('Deck', ['https://deck.example/a', 'www.deck.example/b'])).toBe('url');
    expect(inferColumnType('LinkedIn', ['linkedin.example/in/a', 'linkedin.example/in/b'])).toBe(
      'url',
    );
    expect(inferColumnType('Focus', ['AI; Data', 'Fintech', 'Robotics; AI'])).toBe('multi');
    expect(inferColumnType('Fund', ['Fund II', 'Fund II', 'Fund I', 'Fund II'])).toBe('status');
    expect(inferColumnType('Time in Current Status', ['12 days', '3 days', '30 days'])).toBe(
      'text',
    );
  });

  it('knows the columns that hold people, companies and tags whatever their cells say', () => {
    expect(inferColumnType('Owners', ['Avery Quill'])).toBe('person');
    expect(inferColumnType('People', [''])).toBe('person');
    expect(inferColumnType('Organizations', ['Lumenfold Labs'])).toBe('company');
    expect(inferColumnType('Industry', ['Fintech'])).toBe('multi');
  });

  it('keeps sentences with semicolons, phone numbers and ids as text', () => {
    expect(
      inferColumnType('Comments', [
        'Strong team; slow sales cycle, but the pilot with the logistics customer went well overall and they want to expand it',
        'Met at the demo day',
        'Pass for now',
      ]),
    ).toBe('text');
    expect(inferColumnType('Phone Number', ['+1 512 555 0100', '+1 512 555 0199'])).toBe('text');
    expect(inferColumnType('List Entry ID', ['1', '2', '3'])).toBe('text');
  });

  it('orders options the way Affinity numbers its stages', () => {
    const stages = [
      '10. Won / Signed',
      '3. First Meeting',
      '8.2 Passed - Too Early',
      '5. Due Diligence',
    ];
    expect([...stages].sort(compareAffinityOptions)).toEqual([
      '3. First Meeting',
      '5. Due Diligence',
      '8.2 Passed - Too Early',
      '10. Won / Signed',
    ]);
  });
});

describe('file names', () => {
  it('suggests a list name without the export suffixes', () => {
    expect(defaultListName('Startup Deal Pipeline - All deals.csv')).toBe('Startup Deal Pipeline');
    expect(defaultListName('Startup Deal Pipeline - All deals - 2026-10-15.csv')).toBe(
      'Startup Deal Pipeline',
    );
    expect(defaultListName('LP Pipeline (1).csv')).toBe('LP Pipeline');
    expect(defaultListName('portfolio_companies_2026_10_15.csv')).toBe('portfolio companies');
    expect(defaultListName('Deals export 2026-10-15T14_30_00.csv')).toBe('Deals');
    expect(defaultListName('VC Partners 10-15-2026.csv')).toBe('VC Partners');
    expect(defaultListName('Seed 2024-2025.csv')).toBe('Seed 2024-2025');
    expect(defaultListName('.csv')).toBe('Imported list');
  });
});

describe('detecting what a file is', () => {
  it('tells list exports from notes exports', () => {
    expect(detectAffinityKind('pipeline.csv', parseAffinityCsv(DEALS).headers)).toBe('list');
    expect(detectAffinityKind('export.csv', parseAffinityCsv(NOTES).headers)).toBe('notes');
    // A list view with a "Notes" text column is still a list.
    expect(
      detectAffinityKind('partners.csv', ['Affinity Row ID', 'Organization ID', 'Name', 'Notes']),
    ).toBe('list');
    expect(detectAffinityKind('Pipeline notes.csv', ['Name', 'Body', 'Author'])).toBe('notes');
  });

  it('tells deal, company and person lists apart', () => {
    expect(detectEntityType('x.csv', parseAffinityCsv(DEALS).headers)).toBe('deal');
    expect(detectEntityType('x.csv', parseAffinityCsv(ORGS).headers)).toBe('company');
    expect(detectEntityType('x.csv', parseAffinityCsv(PEOPLE).headers)).toBe('person');
    // A person list with a company column, and the other way round.
    expect(detectEntityType('x.csv', ['Full Name', 'Company Name', 'Email Addresses'])).toBe(
      'person',
    );
    expect(detectEntityType('x.csv', ['Organization Name', 'Website', 'Contact'])).toBe('company');
    expect(detectEntityType('LP Pipeline.csv', ['Name', 'Stage'])).toBe('person');
    expect(detectEntityType('Startup Deal Pipeline.csv', ['Name', 'Stage'])).toBe('deal');
  });

  it('maps an opportunity list', () => {
    const { csv, mapping } = listMapping('Startup Deal Pipeline - All deals.csv', DEALS);
    expect(mapping).toMatchObject({
      listName: 'Startup Deal Pipeline',
      entityType: 'deal',
      nameColumn: 'Opportunity Name',
      rowIdColumn: 'Affinity Row ID',
      entityIdColumn: 'Opportunity ID',
      organizationColumn: 'Organizations',
      statusColumn: 'Status',
      domainColumn: null,
    });
    expect(mapping.types).toMatchObject({
      Amount: 'money',
      Owners: 'person',
      Organizations: 'company',
      'Date Added': 'date',
      'Close Date': 'date',
      Fund: 'status',
      'Time in Current Status': 'text',
    });

    const fields = listFields(mapping, csv).map((c) => c.field);
    expect(fields[0]).toEqual({
      key: 'status',
      name: 'Status',
      type: 'status',
      options: [
        '3. First Meeting',
        '5. Due Diligence',
        '8.2 Passed - Too Early',
        '10. Won / Signed',
      ],
    });
    expect(fields.map((f) => f.key)).toEqual([
      'status',
      'organizations',
      'amount',
      'owners',
      'date_added',
      'close_date',
      'fund',
      'source_channel',
      'time_in_current_status',
    ]);
    expect(mappingProblems(mapping, csv)).toEqual([]);
  });

  it('maps an organization list with odd headers', () => {
    const { csv, mapping } = listMapping('Portfolio.csv', ORGS);
    expect(mapping).toMatchObject({
      entityType: 'company',
      nameColumn: 'Organization Name',
      entityIdColumn: 'Organization ID',
      domainColumn: 'Website',
      rowIdColumn: null,
    });
    expect(listFieldColumns(mapping, csv.headers)).toEqual([
      'Industry',
      'Last Contact',
      'Employees',
    ]);
    const industry = listFields(mapping, csv).find((c) => c.header === 'Industry')?.field;
    expect(industry).toEqual({
      key: 'industry',
      name: 'Industry',
      type: 'multi',
      options: ['AI', 'Data', 'Fintech', 'Robotics'],
    });
  });

  it('maps a person list without a full-name column', () => {
    const { csv, mapping } = listMapping('LP Pipeline.csv', PEOPLE);
    expect(mapping).toMatchObject({
      entityType: 'person',
      nameColumn: null,
      firstNameColumn: 'First Name',
      lastNameColumn: 'Last Name',
      primaryEmailColumn: 'Primary Email',
      emailsColumn: 'Email Addresses',
      entityIdColumn: 'Person ID',
      statusColumn: 'Status',
    });
    expect(mapping.types).toMatchObject({ Organizations: 'company', Commitment: 'money' });
    expect(listFieldColumns(mapping, csv.headers)).toEqual([
      'Status',
      'Organizations',
      'Commitment',
    ]);
  });

  it('maps a notes export', () => {
    const csv = parseAffinityCsv(NOTES);
    expect(detectNotesMapping(csv)).toEqual({
      kind: 'notes',
      contentColumn: 'Note Content',
      authorColumn: 'Creator',
      dateColumn: 'Date Created',
      entityColumn: 'Entity Name',
      associatedColumns: ['Associated Organizations', 'Associated People'],
      idColumn: null,
    });
  });

  it('reads notes headers worded differently', () => {
    const csv = parseAffinityCsv('Note ID,Name,Created By,Created At,Body,Related People\n');
    expect(detectNotesMapping(csv)).toMatchObject({
      idColumn: 'Note ID',
      contentColumn: 'Body',
      authorColumn: 'Created By',
      dateColumn: 'Created At',
      entityColumn: 'Name',
      associatedColumns: ['Related People'],
    });
  });

  it('says what is missing before anything can import', () => {
    const csv = parseAffinityCsv('Stage,Amount\nSourced,100\n');
    const mapping = detectListMapping('mystery.csv', csv);
    expect(mapping.nameColumn).toBeNull();
    expect(mappingProblems(mapping, csv)).toEqual(['Pick the column with the company names.']);
    expect(mappingProblems({ ...mapping, listName: ' ' }, csv)).toContain('Give the list a name.');
    const notes = detectAffinityMapping('notes.csv', csv, 'notes') as AffinityNotesMapping;
    expect(mappingProblems({ ...notes, contentColumn: null }, csv)).toEqual([
      'Pick the column that holds the note text.',
    ]);
  });
});

describe('websites', () => {
  it('stores a bare domain, never a shared host', () => {
    expect(affinityDomain('https://www.harborlight.example/about')).toBe('harborlight.example');
    expect(affinityDomain('fernhollow.example')).toBe('fernhollow.example');
    expect(affinityDomain('linkedin.com/company/gildcrest-robotics')).toBeNull();
    expect(affinityDomain('https://docs.google.com/presentation/d/x')).toBeNull();
    expect(affinityDomain('tidewell.example; tidewell.io.example')).toBe('tidewell.example');
    expect(affinityDomain('')).toBeNull();
  });
});

describe('list payloads', () => {
  it('builds deal rows linked to their companies, one company record per name', () => {
    const { csv, mapping } = listMapping('Startup Deal Pipeline.csv', DEALS);
    const plan = buildListImport(mapping, csv);
    expect(plan.requests).toHaveLength(1);
    expect(plan.lines).toEqual([[2, 3, 4, 5, 6]]);
    expect(plan.skipped).toEqual([]);
    const [request] = plan.requests;
    expect(request?.list).toMatchObject({ name: 'Startup Deal Pipeline', entityType: 'deal' });
    expect(request?.records).toEqual([
      { name: 'Lumenfold Labs' },
      { name: 'Quarrystone' },
      { name: 'Tidewell' },
      { name: 'Brackenridge Energy' },
    ]);
    // Both Lumenfold deals point at the one Lumenfold record.
    expect(request?.entries.map((e) => e.record)).toEqual([0, 1, 0, 2, 3]);
    expect(request?.entries[0]).toEqual({
      externalId: '9001',
      title: 'Lumenfold Seed',
      record: 0,
      values: {
        status: '3. First Meeting',
        organizations: 'Lumenfold Labs',
        amount: '$1,500,000',
        owners: 'Avery Quill; Rowan Pike',
        date_added: '2026-10-01',
        close_date: '2026-11-30',
        fund: 'Fund II',
        source_channel: 'Referral',
        time_in_current_status: '12 days',
      },
    });
    // An empty cell is sent as '' so a re-import clears what Affinity cleared.
    expect(request?.entries[1]?.values?.close_date).toBe('');
  });

  it('builds company rows with their ids and domains', () => {
    const { csv, mapping } = listMapping('Portfolio.csv', ORGS);
    const [request] = buildListImport(mapping, csv).requests;
    expect(request?.records).toEqual([
      { externalId: '3101', name: 'Harborlight Analytics', domain: 'harborlight.example' },
      { externalId: '3102', name: 'Fernhollow, Inc.', domain: 'fernhollow.example' },
      { externalId: '3103', name: 'Gildcrest Robotics', domain: null },
    ]);
    // Without a row id, a row is keyed by its entity id, marked as such so a
    // later export with row ids can still find it (see upsertEntries).
    expect(request?.entries.map((e) => [e.externalId, e.record])).toEqual([
      ['entity:3101', 0],
      ['entity:3102', 1],
      ['entity:3103', 2],
    ]);
    expect(request?.entries[0]?.values).toEqual({
      industry: 'AI; Data',
      last_contact: '2026-09-30',
      employees: '45',
    });
  });

  it('builds person rows from first and last names, and skips a row with nothing to go on', () => {
    const { csv, mapping } = listMapping('LP Pipeline.csv', PEOPLE);
    const plan = buildListImport(mapping, csv);
    expect(plan.skipped).toEqual([{ line: 4, message: 'No name, so the row was skipped.' }]);
    expect(plan.rowCount).toBe(2);
    expect(plan.requests[0]?.records).toEqual([
      {
        externalId: '5201',
        name: 'Juniper Okafor',
        emails: 'juniper@ashgrove-capital.example; j.okafor@mail.example',
        primaryEmail: 'juniper@ashgrove-capital.example',
      },
      {
        externalId: '5202',
        name: 'Theo Marchetti',
        emails: 'theo@marchetti-fo.example',
        primaryEmail: null,
      },
    ]);
  });

  it('leaves out skipped columns and respects the chosen status column', () => {
    const { csv, mapping } = listMapping('Startup Deal Pipeline.csv', DEALS);
    const edited: AffinityListMapping = {
      ...mapping,
      statusColumn: 'Fund',
      types: { ...mapping.types, Status: 'text', 'Time in Current Status': 'skip' },
    };
    const fields = listFields(edited, csv).map((c) => c.field);
    expect(fields[0]).toMatchObject({
      key: 'status',
      name: 'Fund',
      options: ['Fund I', 'Fund II'],
    });
    expect(fields.find((f) => f.name === 'Status')).toMatchObject({
      key: 'status_2',
      type: 'text',
    });
    expect(fields.some((f) => f.name === 'Time in Current Status')).toBe(false);
  });

  it('keys deals by name when the export has no ids, so a second deal with a company stays separate', () => {
    const csv = parseAffinityCsv(
      'Opportunity Name,Organizations,Status\nLumenfold Seed,Lumenfold Labs,Sourced\nLumenfold Series A,Lumenfold Labs,Sourced\n',
    );
    const mapping = detectListMapping('Deals.csv', csv);
    const [request] = buildListImport(mapping, csv).requests;
    expect(request?.entries.map((e) => e.externalId)).toEqual([
      'name:lumenfold seed',
      'name:lumenfold series a',
    ]);
  });

  it('chunks by row count, keeping each chunk’s records with it', () => {
    const rows = Array.from(
      { length: 450 },
      (_, i) => `${i + 1},Deal ${i + 1},Company ${i % 7},Sourced`,
    );
    const csv = parseAffinityCsv(
      `Opportunity ID,Opportunity Name,Organizations,Status\n${rows.join('\n')}\n`,
    );
    const plan = buildListImport(detectListMapping('Deals.csv', csv), csv);
    expect(plan.requests.map((r) => r.entries.length)).toEqual([200, 200, 50]);
    expect(plan.lines[1]?.[0]).toBe(202);
    for (const request of plan.requests) {
      expect(request.records.length).toBe(7);
      for (const entry of request.entries) {
        expect(entry.record).toBeLessThan(request.records.length);
      }
    }
  });

  it('chunks by size too, and clips an oversized cell instead of failing the chunk', () => {
    const big = 'x'.repeat(AFFINITY_IMPORT_LIMITS.cellChars + 500);
    const csv = parseAffinityCsv(
      `Organization Name,Memo\nTidewell,${big}\nQuarrystone,${big}\nBrackenridge,short\n`,
    );
    const mapping = detectListMapping('Companies.csv', csv);
    const plan = buildListImport(mapping, csv, { bytesPerChunk: 30_000 });
    expect(plan.requests.map((r) => r.entries.length)).toEqual([1, 2]);
    expect(plan.requests[0]?.entries[0]?.values?.memo).toHaveLength(
      AFFINITY_IMPORT_LIMITS.cellChars,
    );
  });

  it('never sends more rows than the route accepts', () => {
    expect(AFFINITY_IMPORT_LIMITS.rowsPerRequest).toBe(CRM_UPSERT_BATCH_MAX);
    const csv = parseAffinityCsv(`Organization Name\nTidewell\n`);
    const plan = buildListImport(detectListMapping('x.csv', csv), csv, { rowsPerChunk: 10_000 });
    expect(plan.requests).toHaveLength(1);
  });
});

describe('notes payloads', () => {
  it('builds notes with their names, author and date, verbatim text, and a stable id', () => {
    const csv = parseAffinityCsv(NOTES);
    const mapping = detectNotesMapping(csv);
    const plan = buildNotesImport(mapping, csv);
    // A multi-line note is still one spreadsheet row.
    expect(plan.skipped).toEqual([
      { line: 4, message: 'The note has no text, so it was skipped.' },
    ]);
    expect(plan.lines).toEqual([[2, 3]]);
    const [first, second] = plan.requests[0]?.notes ?? [];
    expect(first).toMatchObject({
      content:
        'First call with the founders.\n- Strong technical team\n- Asked about "design partners"',
      author: 'Avery Quill',
      occurredAt: '2026-10-02T14:05:00.000Z',
      entityNames: ['Lumenfold Seed', 'Lumenfold Labs', 'Juniper Okafor'],
    });
    expect(first?.externalId).toMatch(/^affinity-csv:[0-9a-f]{28}$/);
    // A bare date is noon UTC: the same calendar day wherever it is shown.
    expect(second).toMatchObject({
      occurredAt: '2026-10-05T12:00:00.000Z',
      entityNames: ['Harborlight Analytics'],
    });

    // The same file gives the same ids, so a re-import matches every note.
    const again = buildNotesImport(mapping, parseAffinityCsv(NOTES));
    expect(again.requests[0]?.notes.map((n) => n.externalId)).toEqual(
      plan.requests[0]?.notes.map((n) => n.externalId),
    );
  });

  it('hashes a note by date, author and text — not line endings, or how a spreadsheet rewrote the date', () => {
    const id = affinityNoteId('2026-10-05 14:05:33', 'Rowan Pike', 'Line one\nLine two');
    // Opened in a spreadsheet and saved: two-digit year, no seconds.
    expect(affinityNoteId('10/5/26 14:05', 'rowan pike', 'Line one\r\nLine two\n')).toBe(id);
    expect(affinityNoteId('2026-10-06 14:05:33', 'Rowan Pike', 'Line one\nLine two')).not.toBe(id);
    expect(affinityNoteId('2026-10-05 14:05:33', 'Avery Quill', 'Line one\nLine two')).not.toBe(id);
    expect(affinityNoteId('2026-10-05 14:05:33', 'Rowan Pike', 'Line one')).not.toBe(id);
    // A date that cannot be read still counts, as written.
    expect(affinityNoteId('sometime in May', 'Rowan Pike', 'Line one')).not.toBe(
      affinityNoteId('', 'Rowan Pike', 'Line one'),
    );
    // The names it is attached to do not count — unless there is nothing else
    // to tell a short note apart by.
    expect(affinityNoteId('2026-10-05', 'Rowan Pike', 'Sent the deck', ['Tidewell'])).toBe(
      affinityNoteId('2026-10-05', 'Rowan Pike', 'Sent the deck', ['Quarrystone']),
    );
    expect(affinityNoteId('', '', 'Sent the deck', ['Tidewell'])).not.toBe(
      affinityNoteId('', '', 'Sent the deck', ['Quarrystone']),
    );
    expect(affinityNoteId('', '', 'Sent the deck', ['Tidewell', 'Quarrystone'])).toBe(
      affinityNoteId('', '', 'Sent the deck', ['quarrystone', 'Tidewell']),
    );
  });

  it('gives one note the same id whichever list it was exported from', () => {
    // The same note, on an opportunity and on its organization: the deal
    // pipeline's export names the opportunity, the organization list's the company.
    const header = 'Entity Name,Creator,Date Created,Note Content,Associated Organizations';
    const fromDeals = parseAffinityCsv(
      `${header}\nSaltglass Seed,Avery Quill,2026-10-02 14:05:00,Diligence call.,Saltglass Robotics\n`,
    );
    const fromOrgs = parseAffinityCsv(
      `${header}\nSaltglass Robotics,Avery Quill,2026-10-02 14:05:00,Diligence call.,\n`,
    );
    const [a] = buildNotesImport(detectNotesMapping(fromDeals), fromDeals).requests[0]?.notes ?? [];
    const [b] = buildNotesImport(detectNotesMapping(fromOrgs), fromOrgs).requests[0]?.notes ?? [];
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.entityNames).toEqual(['Saltglass Seed', 'Saltglass Robotics']);
    expect(b?.entityNames).toEqual(['Saltglass Robotics']);
  });

  it('imports a note whose date cannot be read without one, and says so by row', () => {
    const csv = parseAffinityCsv(
      'Entity Name,Date Created,Note Content\nTidewell,10/2/26 14:05,Call\nQuarrystone,sometime in May,Call\n',
    );
    const plan = buildNotesImport(detectNotesMapping(csv), csv);
    expect(plan.requests[0]?.notes.map((n) => n.occurredAt)).toEqual([
      '2026-10-02T14:05:00.000Z',
      null,
    ]);
    expect(plan.notices).toEqual([
      {
        line: 3,
        message:
          'The date “sometime in May” could not be read, so the note was imported without one.',
      },
    ]);
  });

  it('uses the export’s note id when there is one', () => {
    const csv = parseAffinityCsv('Note ID,Entity Name,Content\nN-77,Tidewell,Pilot went well\n');
    const plan = buildNotesImport(detectNotesMapping(csv), csv);
    expect(plan.requests[0]?.notes[0]?.externalId).toBe('N-77');
  });

  it('chunks notes by size, and skips a note too long to store', () => {
    const long = 'y'.repeat(AFFINITY_IMPORT_LIMITS.noteChars + 1);
    const body = 'z'.repeat(40_000);
    const csv = parseAffinityCsv(
      `Entity Name,Content\nTidewell,${body}\nQuarrystone,${body}\nLumenfold Labs,${long}\nTidewell,short\n`,
    );
    const plan = buildNotesImport(detectNotesMapping(csv), csv, { bytesPerChunk: 60_000 });
    expect(plan.skipped).toEqual([
      { line: 4, message: 'The note is too long to store, so it was skipped.' },
    ]);
    expect(plan.requests.map((r) => r.notes.length)).toEqual([1, 2]);
    expect(plan.lines).toEqual([[2], [3, 5]]);
  });

  it('splits multi-value name cells on semicolons only', () => {
    const csv = parseAffinityCsv(
      'Entity Name,Content,Associated Organizations\n"Fernhollow, Inc.",Call,"Tidewell; Quarrystone"\n',
    );
    const plan = buildNotesImport(detectNotesMapping(csv), csv);
    expect(plan.requests[0]?.notes[0]?.entityNames).toEqual([
      'Fernhollow, Inc.',
      'Tidewell',
      'Quarrystone',
    ]);
  });
});

describe('counts', () => {
  it('adds up chunk results', () => {
    expect(
      addCounts(
        { inserted: 2, updated: 1, unchanged: 0, skipped: 1, errors: 0 },
        { ...NO_COUNTS, unchanged: 5, errors: 1 },
      ),
    ).toEqual({ inserted: 2, updated: 1, unchanged: 5, skipped: 1, errors: 1 });
  });
});
