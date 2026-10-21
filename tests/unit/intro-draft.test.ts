import { describe, expect, it } from 'vitest';
import {
  buildIntroDraft,
  cleanEmail,
  firstName,
  introBody,
  introHints,
  introKey,
  introRecipients,
  introSubject,
  joinNames,
  looksLikeCompany,
  parseIntroSide,
  type IntroPerson,
  type IntroSide,
} from '@/lib/intros/intro-draft';
import { SIGN_OFF_NAME } from '@/lib/email/signatures';
import { parseFollowUpMessage } from '@/lib/services/follow-ups';

/** "Write the intro": the fund's intro format, built from fictional people only. */

const person = (name: string, extra: Partial<IntroPerson> = {}): IntroPerson => ({
  name,
  email: null,
  linkedin: null,
  founder: false,
  ...extra,
});

const INVESTORS: IntroSide = {
  label: 'Wren Abara & Juno Castell (Halyard Ventures)',
  org: 'Halyard Ventures',
  people: [
    person('Wren Abara', {
      email: 'wren@halyard.example',
      linkedin: 'https://www.linkedin.com/in/wren-abara-example',
    }),
    person('Juno Castell', { email: 'juno@halyard.example' }),
  ],
};

const FOUNDERS: IntroSide = {
  label: 'Pellucid',
  org: 'Pellucid',
  people: [
    person('Ola Brightwater', {
      email: 'ola@pellucid.demo',
      linkedin: 'https://www.linkedin.com/in/ola-brightwater-example',
      founder: true,
    }),
  ],
};

describe('parseIntroSide', () => {
  it('reads names and the firm in brackets', () => {
    expect(parseIntroSide('Wren Abara & Juno Castell (Halyard Ventures)')).toEqual({
      who: 'Wren Abara & Juno Castell',
      names: ['Wren Abara', 'Juno Castell'],
      org: 'Halyard Ventures',
    });
  });

  it('reads "at" and lists joined with commas or "and"', () => {
    expect(parseIntroSide('Ola Brightwater at Pellucid')).toMatchObject({
      names: ['Ola Brightwater'],
      org: 'Pellucid',
    });
    expect(parseIntroSide('Ada Fenn, Bo Ruiz and Cy Vance')).toMatchObject({
      names: ['Ada Fenn', 'Bo Ruiz', 'Cy Vance'],
      org: null,
    });
  });

  it('keeps text with no firm whole, so a company name can be recognised', () => {
    expect(parseIntroSide('  Halyard   Ventures ')).toEqual({
      who: 'Halyard Ventures',
      names: ['Halyard Ventures'],
      org: null,
    });
  });

  it('tells a firm from a person by how the name reads, when no record knows it', () => {
    for (const firm of ['Halyard Ventures', 'Pellucid', 'Gannet Labs', 'Ortolan Family Office']) {
      expect(looksLikeCompany(firm), firm).toBe(true);
    }
    for (const who of ['Ola Brightwater', 'Wren & Juno', 'Kit Morrow', '']) {
      expect(looksLikeCompany(who), who).toBe(false);
    }
  });
});

describe('names', () => {
  it('greets by the first name, past an honorific', () => {
    expect(firstName('Dr. Ola Brightwater')).toBe('Ola');
    expect(firstName('Juno')).toBe('Juno');
  });

  it('joins two with "&" and three with commas', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A & B');
    expect(joinNames(['A', 'B', 'C'], 'and')).toBe('A, B and C');
  });

  it('keys an intro by its pair', () => {
    expect(introKey({ for_who: 'Pellucid', to_who: 'Halyard' })).toBe('Pellucid → Halyard');
  });
});

describe('introSubject', () => {
  it('is "Intro: First & First (Firm) <> First (Company)", the person asked first', () => {
    expect(introSubject(INVESTORS, FOUNDERS)).toBe(
      'Intro: Wren & Juno (Halyard Ventures) <> Ola (Pellucid)',
    );
  });

  it('names a firm alone when nobody there is known', () => {
    const firm: IntroSide = { label: 'Halyard Ventures', org: 'Halyard Ventures', people: [] };
    expect(introSubject(firm, FOUNDERS)).toBe('Intro: Halyard Ventures <> Ola (Pellucid)');
  });

  it('leaves the brackets out when the firm is unknown', () => {
    const solo: IntroSide = { label: 'Mira Okon', org: null, people: [person('Mira Okon')] };
    expect(introSubject(solo, FOUNDERS)).toBe('Intro: Mira <> Ola (Pellucid)');
  });
});

describe('introBody', () => {
  const body = introBody(INVESTORS, FOUNDERS);
  const lines = body.split('\n');

  it('greets everyone by first name, unlinked', () => {
    expect(lines[0]).toBe('Hi Wren, Juno & Ola,');
  });

  it('links each full name to LinkedIn where it is presented, and only there', () => {
    expect(body).toContain(
      'Wren and Juno - meet [Ola Brightwater](https://www.linkedin.com/in/ola-brightwater-example), founder of Pellucid.',
    );
    expect(body).toContain(
      'Ola - meet [Wren Abara](https://www.linkedin.com/in/wren-abara-example) and Juno Castell at Halyard Ventures.',
    );
    // One link per person who has one; no other URL of any kind.
    expect(body.match(/https:\/\//g)).toHaveLength(2);
  });

  it('calls two or more founders co-founders', () => {
    const team: IntroSide = {
      ...FOUNDERS,
      people: [...FOUNDERS.people, person('Tamsin Reyes', { founder: true })],
    };
    expect(introBody(INVESTORS, team)).toContain('Tamsin Reyes, co-founders at Pellucid.');
    expect(introBody(INVESTORS, team).split('\n')[0]).toBe('Hi Wren, Juno, Ola & Tamsin,');
  });

  it('closes for "you all" with three or more people, "you two" with two', () => {
    expect(body).toContain("I'll let you all take it from here!");
    const pair = introBody({ ...INVESTORS, people: [INVESTORS.people[0]!] }, FOUNDERS);
    expect(pair).toContain("I'll let you two take it from here!");
  });

  it('ends at the sign-off, with no typed signature block', () => {
    expect(lines.slice(-2)).toEqual(['Cheers,', SIGN_OFF_NAME.nick]);
    expect(body).not.toMatch(/\n--\n/);
  });

  it('speaks to the team when nobody at the firm is known', () => {
    const firm: IntroSide = { label: 'Halyard Ventures', org: 'Halyard Ventures', people: [] };
    const text = introBody(firm, FOUNDERS);
    expect(text.split('\n')[0]).toBe('Hi all,');
    expect(text).toContain('Halyard Ventures team - meet [Ola Brightwater]');
    expect(text).toContain('Ola - meet the team at Halyard Ventures.');
  });
});

describe('recipients and hints', () => {
  it('addresses only the people whose email is on file', () => {
    const side: IntroSide = {
      ...INVESTORS,
      people: [...INVESTORS.people, person('Kit Morrow')],
    };
    expect(introRecipients(side, FOUNDERS)).toBe(
      'Wren Abara <wren@halyard.example>, Juno Castell <juno@halyard.example>, Ola Brightwater <ola@pellucid.demo>',
    );
  });

  it('never puts an invalid address or a header-breaking name in To', () => {
    const side: IntroSide = {
      label: 'x',
      org: null,
      people: [
        person('Eve "Ops", Inc <x>', { email: 'eve@ops.example' }),
        person('Bad Address', { email: 'not an address' }),
        person('Dup', { email: 'EVE@ops.example' }),
      ],
    };
    expect(introRecipients(side, { label: 'y', org: null, people: [] })).toBe(
      'Eve Ops Inc x <eve@ops.example>',
    );
    expect(cleanEmail(' Ola@Pellucid.Demo ')).toBe('ola@pellucid.demo');
    expect(cleanEmail('ola@pellucid')).toBeNull();
  });

  it('says what is missing before sending', () => {
    const firm: IntroSide = { label: 'Halyard Ventures', org: 'Halyard Ventures', people: [] };
    const founders: IntroSide = {
      ...FOUNDERS,
      people: [person('Ola Brightwater', { founder: true })],
    };
    expect(introHints(firm, founders)).toEqual([
      "Copilot doesn't know who at Halyard Ventures this goes to. Add their name in the email and their address in To.",
      'No email on file for Ola Brightwater. Add it to To before sending.',
      'No LinkedIn on file for Ola Brightwater, so that name stays unlinked.',
    ]);
    expect(introHints(INVESTORS, FOUNDERS)).toEqual([
      'No LinkedIn on file for Juno Castell, so that name stays unlinked.',
    ]);
  });

  it('puts it together for the compose window', () => {
    const draft = buildIntroDraft(INVESTORS, FOUNDERS);
    expect(draft.subject).toBe('Intro: Wren & Juno (Halyard Ventures) <> Ola (Pellucid)');
    expect(draft.to).toContain('ola@pellucid.demo');
    expect(draft.body.startsWith('Hi Wren, Juno & Ola,')).toBe(true);
  });
});

describe('INTROS_V1 party detail', () => {
  const post = (value: unknown) => `INTROS_V1\n\`${JSON.stringify(value)}\``;

  it('reads each side’s firm and people when the tracker gives them', () => {
    const parsed = parseFollowUpMessage(
      post({
        run_at: '2026-10-20T12:00:00Z',
        intros: [
          {
            for_who: 'Pellucid',
            to_who: 'Wren Abara',
            status: 'owed',
            to_org: 'Halyard Ventures',
            to_people: [
              {
                name: 'Wren Abara',
                email: 'Wren@Halyard.example',
                linkedin: 'https://www.linkedin.com/in/wren-abara-example',
              },
            ],
          },
        ],
      }),
    );
    expect(parsed?.marker).toBe('INTROS_V1');
    const row = parsed?.marker === 'INTROS_V1' ? parsed.value.intros[0] : null;
    expect(row?.to_org).toBe('Halyard Ventures');
    expect(row?.to_people?.[0]).toEqual({
      name: 'Wren Abara',
      email: 'wren@halyard.example',
      linkedin: 'https://www.linkedin.com/in/wren-abara-example',
    });
  });

  it('drops a malformed address instead of the whole post', () => {
    const parsed = parseFollowUpMessage(
      post({
        run_at: '2026-10-20T12:00:00Z',
        intros: [
          {
            for_who: 'Pellucid',
            to_who: 'Wren Abara',
            status: 'owed',
            to_people: [{ name: 'Wren Abara', email: 'wren at halyard' }],
            for_people: 'not a list',
          },
        ],
      }),
    );
    const row = parsed?.marker === 'INTROS_V1' ? parsed.value.intros[0] : null;
    expect(row?.to_people?.[0]?.email).toBeNull();
    expect(row?.for_people).toBeUndefined();
  });

  it('still reads rows without any of it, as the tracker posts today', () => {
    const parsed = parseFollowUpMessage(
      post({
        run_at: '2026-10-20T12:00:00Z',
        intros: [{ for_who: 'Pellucid', to_who: 'Halyard Ventures', status: 'owed' }],
      }),
    );
    const row = parsed?.marker === 'INTROS_V1' ? parsed.value.intros[0] : null;
    expect(row?.for_who).toBe('Pellucid');
    expect(row?.to_people).toBeUndefined();
  });
});
