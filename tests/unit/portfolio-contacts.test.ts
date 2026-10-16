import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRelationshipIndex } from '@/lib/network/evidence';
import {
  CARD_CONTACTS,
  companyLastContact,
  isRoleInbox,
  mailContactsAtDomain,
  mergeCompanyContacts,
  provenanceLabel,
} from '@/lib/portfolio/contacts';
import { portfolioCrmPeople } from '@/lib/services/crm-pages';
import { loadPortfolioContacts } from '@/lib/services/portfolio-contacts';
import { resetRelationshipCache } from '@/lib/services/relationships';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { CrmRecord, EmailMessage, PortfolioCompany } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

// Fictional companies, people and addresses only: this repository is public.

const NOW = new Date('2026-10-15T15:00:00Z');
const NICK = 'nick@fund.example';
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let n = 0;
function mail(from: string, to: string[], day: number, name: string | null = null): EmailMessage {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    organization_id: 'org',
    thread_id: `thread-${n}`,
    provider: 'google',
    provider_message_id: `m-${n}`,
    subject: `Subject ${n}`,
    snippet: '',
    from_name: name,
    from_address: from,
    to_addresses: to,
    cc_addresses: [],
    labels: [],
    is_unread: false,
    sent_at: daysAgo(day),
    body_text: null,
    body_fetched_at: null,
    body_hash: null,
    has_attachments: false,
    category: 'portfolio_company',
    category_confidence: null,
    category_source: null,
    importance: null,
    is_ignored: false,
    linked_deal_id: null,
    linked_portfolio_company_id: null,
    injection_flagged: false,
    created_at: daysAgo(day),
    updated_at: daysAgo(day),
  };
}

const index = buildRelationshipIndex(
  {
    messages: [
      mail('rowan@brightfield.example', [NICK], 3, 'Rowan Example'),
      mail('rowan@brightfield.example', [NICK], 20, 'Rowan Example'),
      mail('rowan@brightfield.example', [NICK], 40, 'Rowan Example'),
      mail('ines@brightfield.example', [NICK], 10, 'Ines Example'),
      mail(NICK, ['ines@brightfield.example'], 9),
      // Someone Nick only wrote to: not a sender.
      mail(NICK, ['quiet@brightfield.example'], 2),
      // Role inboxes and machines at the company's domain.
      mail('info@brightfield.example', [NICK], 1, 'Brightfield'),
      mail('hello@brightfield.example', [NICK], 1, 'Brightfield'),
      mail('support@brightfield.example', [NICK], 1, 'Brightfield Support'),
      mail('no-reply@brightfield.example', [NICK], 1, 'Brightfield'),
      // A subdomain of the company counts as the company.
      mail('pat@eu.brightfield.example', [NICK], 5, 'Pat Example'),
      // Colleagues at the fund, and personal mail.
      mail('casey@fund.example', [NICK], 1, 'Casey Colleague'),
      mail('rowan.personal@gmail.com', [NICK], 1, 'Rowan Example'),
    ],
    events: [],
    threads: [],
    ownAddresses: [NICK],
  },
  NOW,
);

describe('people at a company domain in the mail', () => {
  it('lists real senders at the domain, most mail first, with their last contact', () => {
    const found = mailContactsAtDomain(index, 'brightfield.example', NOW, ['fund.example']);
    expect(found.map((c) => [c.email, c.emailsFromThem])).toEqual([
      ['rowan@brightfield.example', 3],
      ['pat@eu.brightfield.example', 1],
      ['ines@brightfield.example', 1],
    ]);
    expect(found[0]?.name).toBe('Rowan Example');
    expect(found[0]?.lastContactAt).toBe(daysAgo(3));
    // Ines's last contact is Nick's reply, a day after her email.
    expect(found[2]?.lastContactAt).toBe(daysAgo(9));
  });

  it('leaves out role inboxes, machines and people Nick only wrote to', () => {
    const emails = mailContactsAtDomain(index, 'brightfield.example', NOW, []).map((c) => c.email);
    for (const left of ['info@', 'hello@', 'support@', 'no-reply@', 'quiet@']) {
      expect(emails.some((e) => e.startsWith(left))).toBe(false);
    }
  });

  it('leaves out the shared inboxes investor updates come from, however much they send', () => {
    const shared = buildRelationshipIndex(
      {
        messages: [
          ...['founders', 'investors', 'ir', 'hi', 'careers', 'jobs', 'press', 'office'].flatMap(
            (local) => [
              mail(`${local}@brightfield.example`, [NICK], 2, `Brightfield ${local}`),
              mail(`${local}@brightfield.example`, [NICK], 4, `Brightfield ${local}`),
            ],
          ),
          mail('rowan@brightfield.example', [NICK], 6, 'Rowan Example'),
          // A person whose address happens to start like a role word.
          mail('irene@brightfield.example', [NICK], 7, 'Irene Example'),
        ],
        events: [],
        threads: [],
        ownAddresses: [NICK],
      },
      NOW,
    );
    expect(
      mailContactsAtDomain(shared, 'brightfield.example', NOW, []).map((c) => c.email),
    ).toEqual(['rowan@brightfield.example', 'irene@brightfield.example']);
  });

  it('knows a role inbox from a person', () => {
    for (const address of [
      'founders@acme.example',
      'investor-relations@acme.example',
      'ir@acme.example',
      'updates+oct@acme.example',
      'support@acme.example',
      'no-reply@acme.example',
    ]) {
      expect(isRoleInbox(address)).toBe(true);
    }
    for (const address of ['rowan@acme.example', 'irene@acme.example', 'dev@acme.example']) {
      expect(isRoleInbox(address)).toBe(false);
    }
  });

  it("matches nobody for personal mail or the fund's own domain", () => {
    expect(mailContactsAtDomain(index, 'gmail.com', NOW, [])).toEqual([]);
    expect(mailContactsAtDomain(index, 'fund.example', NOW, ['fund.example'])).toEqual([]);
    expect(mailContactsAtDomain(index, null, NOW, [])).toEqual([]);
  });

  it('gives the company its last contact from the mail, or the stored date if later', () => {
    const base = { domain: 'brightfield.example', emails: [], ownDomains: ['fund.example'] };
    // Nick's email to quiet@ two days ago; the role inboxes' mail a day ago never counts.
    expect(companyLastContact(index, { ...base, stored: null }, NOW)).toBe(daysAgo(2));
    expect(companyLastContact(index, { ...base, stored: daysAgo(0.5) }, NOW)).toBe(daysAgo(0.5));
    expect(companyLastContact(index, { ...base, stored: daysAgo(30) }, NOW)).toBe(daysAgo(2));
    expect(companyLastContact(null, { ...base, stored: daysAgo(30) }, NOW)).toBe(daysAgo(30));
    // A contact's personal address counts for them.
    expect(
      companyLastContact(
        index,
        { stored: null, domain: null, emails: ['rowan.personal@gmail.com'], ownDomains: [] },
        NOW,
      ),
    ).toBe(daysAgo(1));
  });
});

describe('mergeCompanyContacts', () => {
  const mailFound = mailContactsAtDomain(index, 'brightfield.example', NOW, []);

  it('merges one person seen by several sources and lists each source', () => {
    const contacts = mergeCompanyContacts(
      {
        recorded: [],
        affinity: [
          {
            recordId: 'rec-rowan',
            name: 'Rowan Example',
            role: 'CEO',
            email: 'rowan@brightfield.example',
            founder: true,
          },
        ],
        mail: mailFound,
      },
      NOW,
    );
    const rowan = contacts.find((c) => c.name === 'Rowan Example');
    expect(rowan).toMatchObject({
      role: 'CEO',
      recordId: 'rec-rowan',
      sources: ['affinity', 'mail'],
      founder: true,
      emailsFromThem: 3,
    });
    expect(contacts.filter((c) => c.email === 'rowan@brightfield.example')).toHaveLength(1);
    expect(provenanceLabel(rowan!.sources)).toBe('from Affinity and your mail');
  });

  it('puts saved contacts first, then founders, then the most mail, most recent', () => {
    const contacts = mergeCompanyContacts(
      {
        recorded: [{ name: 'Sam Saved', role: 'COO', email: null, isFounder: false }],
        affinity: [
          {
            recordId: 'rec-founder',
            name: 'Fay Founder',
            role: 'CTO',
            email: null,
            founder: true,
          },
          {
            recordId: 'rec-ines',
            name: 'Ines Example',
            role: null,
            email: 'ines@brightfield.example',
            founder: false,
          },
        ],
        mail: mailFound,
      },
      NOW,
    );
    expect(contacts.map((c) => c.name)).toEqual([
      'Sam Saved',
      'Fay Founder',
      'Ines Example',
      'Rowan Example',
      'Pat Example',
    ]);
    expect(contacts.slice(0, CARD_CONTACTS)).toHaveLength(3);
    expect(provenanceLabel(contacts[0]!.sources)).toBeNull();
    expect(provenanceLabel(contacts[4]!.sources)).toBe('from your mail');
  });

  it('matches a saved contact with no address to the same name in Affinity', () => {
    const contacts = mergeCompanyContacts(
      {
        recorded: [{ name: 'Rowan Example', role: null, email: null, isFounder: true }],
        affinity: [
          {
            recordId: 'rec-rowan',
            name: 'rowan  example',
            role: 'CEO',
            email: 'rowan@brightfield.example',
            founder: true,
          },
        ],
        mail: mailFound,
      },
      NOW,
    );
    expect(contacts[0]).toMatchObject({
      name: 'Rowan Example',
      role: 'CEO',
      email: 'rowan@brightfield.example',
      sources: ['recorded', 'affinity', 'mail'],
    });
  });

  it('meets a contact saved without an address when they write, by exact name', () => {
    const contacts = mergeCompanyContacts(
      {
        recorded: [{ name: 'Rowan Example', role: 'CEO', email: null, isFounder: true }],
        affinity: [],
        mail: mailFound,
      },
      NOW,
    );
    expect(contacts.filter((c) => c.name === 'Rowan Example')).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: 'Rowan Example',
      role: 'CEO',
      email: 'rowan@brightfield.example',
      sources: ['recorded', 'mail'],
      emailsFromThem: 3,
    });
  });

  it('never merges a mail sender into a contact saved with another address', () => {
    const contacts = mergeCompanyContacts(
      {
        recorded: [
          { name: 'Pat Example', role: null, email: 'pat@other.example', isFounder: false },
        ],
        affinity: [],
        mail: mailFound,
      },
      NOW,
    );
    expect(contacts.filter((c) => c.name === 'Pat Example')).toHaveLength(2);
  });
});

describe('loadPortfolioContacts (demo workspace)', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
    resetRelationshipCache();
  });
  afterEach(async () => {
    resetRelationshipCache();
    await harness.dispose();
  });

  it('fills every company from Affinity and the mail, never from a role inbox', async () => {
    const companies = (await harness.store.list(
      'portfolio_companies',
      harness.auth.organizationId,
    )) as PortfolioCompany[];
    const people = await loadPortfolioContacts(
      harness.store,
      harness.auth.organizationId,
      companies,
    );

    const ledgerly = people[DEMO_IDS.pcLedgerly]!;
    expect(ledgerly.contacts[0]).toMatchObject({
      name: 'Maya Chen',
      role: 'CEO',
      sources: ['recorded', 'affinity', 'mail'],
    });
    expect(ledgerly.contacts.map((c) => c.name)).toContain('Lena Ortiz');
    expect(ledgerly.contacts.some((c) => c.email === 'hello@ledgerly.demo')).toBe(false);
    expect(ledgerly.lastContactAt).not.toBeNull();

    const stonebridge = people[DEMO_IDS.pcStonebridge]!;
    expect(stonebridge.contacts.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Dev Sharma', 'Jonas Reyes']),
    );
    const jonas = stonebridge.contacts.find((c) => c.name === 'Jonas Reyes');
    expect(jonas?.sources).toEqual(['mail']);
  });

  it('finds Affinity people at the domain, and never by a near-miss name', async () => {
    const org = harness.auth.organizationId;
    const person = (id: string, name: string, email: string): CrmRecord => ({
      id,
      organization_id: org,
      kind: 'person',
      source: 'affinity',
      external_id: null,
      name,
      name_key: name.toLowerCase(),
      domain: null,
      emails: [email],
      primary_email: email,
      fields: { 'Job Title': 'Head of Engineering' },
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    await harness.store.insertMany('crm_records', [
      person('00000000-0000-4000-8000-00000000c001', 'Wren Example', 'wren@stonebridgeops.demo'),
      person('00000000-0000-4000-8000-00000000c002', 'Vic Example', 'vic@stonebridgeops-labs.demo'),
      // Affinity's record for a role inbox that wrote in.
      person(
        '00000000-0000-4000-8000-00000000c003',
        'Stonebridge Support',
        'support@stonebridgeops.demo',
      ),
      person(
        '00000000-0000-4000-8000-00000000c004',
        'Stonebridge Founders',
        'founders@stonebridgeops.demo',
      ),
    ]);
    const companies = (await harness.store.list('portfolio_companies', org)) as PortfolioCompany[];
    const crm = await portfolioCrmPeople(harness.store, org, companies);
    const stonebridge = crm[DEMO_IDS.pcStonebridge] ?? [];
    expect(stonebridge.find((p) => p.name === 'Wren Example')).toMatchObject({
      role: 'Head of Engineering',
      email: 'wren@stonebridgeops.demo',
      founder: false,
      matchedBy: 'domain',
    });
    expect(stonebridge.find((p) => p.name === 'Dev Sharma')).toMatchObject({ founder: true });
    expect(stonebridge.some((p) => p.name === 'Vic Example')).toBe(false);
    expect(stonebridge.some((p) => /Support|Founders/.test(p.name))).toBe(false);
  });

  it('keeps hand-entered contacts exactly as typed', async () => {
    const org = harness.auth.organizationId;
    const before = await harness.store.list('portfolio_contacts', org);
    const companies = (await harness.store.list('portfolio_companies', org)) as PortfolioCompany[];
    await loadPortfolioContacts(harness.store, org, companies);
    expect(await harness.store.list('portfolio_contacts', org)).toEqual(before);
  });
});
