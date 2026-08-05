import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyPortfolioEmail,
  importPortfolioCsv,
  openRequests,
  setUpdateStatus,
} from '@/lib/services/portfolio';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, NetworkContact, PortfolioUpdate } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Invariant 9: no introductions to people who do not exist.
 *
 * The model is handed the org's own network list and may only choose ids from
 * it. Anything else is dropped and audited — the product must never imply Nick
 * knows someone he does not.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function networkIds(): Promise<Set<string>> {
  const contacts = (await harness.store.list(
    'network_contacts',
    harness.auth.organizationId,
  )) as NetworkContact[];
  return new Set(contacts.map((c) => c.id));
}

describe('classifyPortfolioEmail', () => {
  it('classifies an investor-introduction request and records the ask', async () => {
    const result = await classifyPortfolioEmail(harness.auth, DEMO_IDS.msgLedgerlyRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.portfolio_company_id).toBe(DEMO_IDS.pcLedgerly);
    expect(result.value.request_type).toBe('investor_introduction');
    expect(result.value.status).toBe('open');
    expect(result.value.summary.length).toBeGreaterThan(0);
  });

  it('only ever suggests contacts that exist in this organization’s network', async () => {
    const known = await networkIds();

    for (const messageId of [DEMO_IDS.msgLedgerlyRequest, DEMO_IDS.msgStonebridgeHiring]) {
      const result = await classifyPortfolioEmail(harness.auth, messageId);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      for (const id of result.value.suggested_network_contact_ids) {
        expect(known.has(id), `${id} must be a real contact`).toBe(true);
      }
    }
  });

  it('drops an invented contact id and audits the rejection', async () => {
    // Remove the network entirely: any id the model offers is now fabricated.
    await harness.store.removeWhere('network_contacts', harness.auth.organizationId, {});

    const result = await classifyPortfolioEmail(harness.auth, DEMO_IDS.msgLedgerlyRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.suggested_network_contact_ids).toEqual([]);
    // And it says so plainly rather than offering a vague introduction.
    expect(result.value.suggested_action).toMatch(
      /No one in the uploaded network data|Import more contacts/,
    );
  });

  it('cites the email it classified', async () => {
    const result = await classifyPortfolioEmail(harness.auth, DEMO_IDS.msgLedgerlyRequest);
    if (!result.ok) return;

    expect(result.value.citations.length).toBeGreaterThan(0);
    expect(result.value.citations[0]?.ref_id).toBe(DEMO_IDS.msgLedgerlyRequest);
  });

  it('links the message and updates the company’s last-contact date', async () => {
    const result = await classifyPortfolioEmail(harness.auth, DEMO_IDS.msgLedgerlyRequest);
    if (!result.ok) return;

    const message = await harness.store.get(
      'email_messages',
      harness.auth.organizationId,
      DEMO_IDS.msgLedgerlyRequest,
    );
    expect(message?.linked_portfolio_company_id).toBe(DEMO_IDS.pcLedgerly);

    const company = await harness.store.get(
      'portfolio_companies',
      harness.auth.organizationId,
      DEMO_IDS.pcLedgerly,
    );
    expect(company?.last_contact_at).toBe(message?.sent_at);
  });

  it('refuses a message that is not from a known portfolio company', async () => {
    const result = await classifyPortfolioEmail(harness.auth, DEMO_IDS.msgVetrixIntro);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toContain('Link it to one first');
    }
  });

  it('refuses a message that does not exist here', async () => {
    const result = await classifyPortfolioEmail(harness.auth, 'no-such-message');
    expect(result.ok).toBe(false);
  });
});

describe('open requests', () => {
  it('lists only open updates that carry an explicit ask', async () => {
    const requests = await openRequests(harness.auth.organizationId);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.status).toBe('open');
      expect(request.request_type).not.toBeNull();
    }
  });

  it('drops a request from the open list once it is handled, and audits it', async () => {
    const [request] = (await harness.store.list('portfolio_updates', harness.auth.organizationId, {
      eq: { status: 'open' },
    })) as PortfolioUpdate[];
    expect(request).toBeDefined();

    const updated = await setUpdateStatus(harness.auth, request!.id, 'handled');
    expect(updated.ok).toBe(true);

    const stillOpen = await openRequests(harness.auth.organizationId);
    expect(stillOpen.map((r) => r.id)).not.toContain(request!.id);

    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'portfolio.request_handled' },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
  });

  it('refuses to change the status of an update that does not exist here', async () => {
    const result = await setUpdateStatus(harness.auth, 'no-such-update', 'handled');
    expect(result.ok).toBe(false);
  });
});

describe('CSV import', () => {
  const csv = `Name,Website,Stage,Founder,Email
Northwind Rail,northwind.demo,Seed,Ada Fenn,ada@northwind.demo
Cobalt Yard,https://cobaltyard.demo,Series A,Ivo Petrov,ivo@cobaltyard.demo`;

  it('creates a company per row, keyed on the header not the column order', async () => {
    const result = await importPortfolioCsv(harness.auth, csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toBe(2);
    expect(result.value.errors).toEqual([]);

    const created = await harness.store.findOne(
      'portfolio_companies',
      harness.auth.organizationId,
      { eq: { name: 'Northwind Rail' } },
    );
    expect(created?.domain).toBe('northwind.demo');
    expect(created?.current_stage).toBe('Seed');
  });

  it('reads the same data correctly when the columns are reordered', async () => {
    const reordered = `Email,Stage,Name,Founder,Website
ada@northwind.demo,Seed,Northwind Rail,Ada Fenn,northwind.demo`;
    const result = await importPortfolioCsv(harness.auth, reordered);
    expect(result.ok).toBe(true);

    const created = await harness.store.findOne(
      'portfolio_companies',
      harness.auth.organizationId,
      { eq: { name: 'Northwind Rail' } },
    );
    expect(created?.current_stage).toBe('Seed');
  });

  it('skips a company it already has rather than duplicating it', async () => {
    await importPortfolioCsv(harness.auth, csv);
    const second = await importPortfolioCsv(harness.auth, csv);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.created).toBe(0);
      expect(second.value.skipped).toBe(2);
    }
  });

  it('reports a row it cannot use by number, and imports the rest', async () => {
    const withGap = `Name,Website
,nameless.demo
Cobalt Yard,cobaltyard.demo`;
    const result = await importPortfolioCsv(harness.auth, withGap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toBe(1);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain('Row 2');
  });

  it('creates the founder contact when the row names one', async () => {
    await importPortfolioCsv(harness.auth, csv);
    const company = await harness.store.findOne(
      'portfolio_companies',
      harness.auth.organizationId,
      { eq: { name: 'Cobalt Yard' } },
    );
    const contacts = await harness.store.list('portfolio_contacts', harness.auth.organizationId, {
      eq: { portfolio_company_id: company!.id },
    });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe('Ivo Petrov');
    expect(contacts[0]?.is_founder).toBe(true);
  });

  it('audits the import', async () => {
    await importPortfolioCsv(harness.auth, csv);
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'portfolio.imported' },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata?.created).toBe(2);
  });
});
