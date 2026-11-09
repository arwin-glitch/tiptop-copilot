import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { demoCrmId } from '@/lib/demo/ids';
import { getRelationshipIndex, resetRelationshipCache } from '@/lib/services/relationships';
import { parsePreviewRequest, previewCard, safeLink } from '@/lib/services/search-preview';
import type { Deal, NetworkContact, PortfolioCompany } from '@/lib/types/domain';

/**
 * The Ctrl+K hover preview card for every result kind, from the demo store
 * (fictional fixtures only).
 */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  resetRelationshipCache();
});

afterEach(async () => {
  resetRelationshipCache();
  await h.dispose();
});

const q = (s: string) => new URLSearchParams(s);

describe('parsePreviewRequest', () => {
  it('accepts each kind with its strict key shape', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(parsePreviewRequest(q(`kind=crm&key=${id}`))).toEqual({
      ok: true,
      value: { kind: 'crm', key: id },
    });
    expect(parsePreviewRequest(q(`id=${id}`))).toEqual({
      ok: true,
      value: { kind: 'crm', key: id },
    });
    expect(parsePreviewRequest(q('kind=mail&key=Ada%40Example.test'))).toEqual({
      ok: true,
      value: { kind: 'mail', key: 'ada@example.test' },
    });
    expect(parsePreviewRequest(q('kind=harmonic_company&key=7700001')).ok).toBe(true);
  });

  it('refuses bad input as invalid_input', () => {
    const bad = [
      '',
      'kind=nope&key=1',
      'kind=crm&key=not-a-uuid',
      'id=not-a-uuid',
      'kind=deal&key=',
      'kind=mail&key=not-an-email',
      'kind=mail&key=a%40b',
      'kind=harmonic_person&key=12a',
      'kind=harmonic_person&key=urn:harmonic:person:1',
      'kind=portfolio&key=../../etc',
      `kind=mail&key=${'a'.repeat(250)}%40example.test`,
    ];
    for (const s of bad) {
      const r = parsePreviewRequest(q(s));
      expect(r.ok, s).toBe(false);
      expect(!r.ok && r.error.code, s).toBe('invalid_input');
    }
  });
});

describe('safeLink', () => {
  it('keeps http(s) and in-app paths only', () => {
    expect(safeLink('a', '/deals/1')?.external).toBe(false);
    expect(safeLink('a', 'https://x.example')?.external).toBe(true);
    expect(safeLink('a', 'javascript:alert(1)')).toBeNull();
    expect(safeLink('a', '//evil.example')).toBeNull();
    expect(safeLink('a', 'mailto:a@b.example')).toBeNull();
  });
});

describe('previewCard', () => {
  it('builds a mail person from the relationship index', async () => {
    const index = await getRelationshipIndex(h.store, h.auth.organizationId, {
      ownAddresses: [],
    });
    if (!index.ok) throw new Error(index.error.message);
    const email = [...index.value.byAddress.entries()].find(
      ([address, entry]) => entry.threads.size > 0 && !index.value.own.has(address),
    )?.[0];
    if (!email) throw new Error('demo data has no mail correspondent');

    const res = await previewCard(h.store, h.auth, { kind: 'mail', key: email });
    if (!res.ok) throw new Error(res.error.message);
    const card = res.value.card;
    expect(card.kind).toBe('mail');
    expect(card.source).toBe('mail');
    expect(card.subtitle).toBe(email);
    expect(card.openHref).toBe(`/network?tab=people&source=mail&q=${encodeURIComponent(email)}`);
    expect(card.status?.label).toMatch(/contacted|touch/i);
    expect(card.counts.map((c) => c.label)).toEqual(['Emails', 'Meetings', 'Connections']);
    expect(card.counts[0]?.value).toBeGreaterThan(0);
    expect(card.lastContact?.at).toBeTruthy();
    expect(card.avatarText.length).toBeGreaterThan(0);
  });

  it('says Never contacted for an address nobody has written to', async () => {
    const res = await previewCard(h.store, h.auth, {
      kind: 'mail',
      key: 'nobody-here@unknown-co.example',
    });
    if (!res.ok) throw new Error(res.error.message);
    expect(res.value.card.status).toEqual({ label: 'Never contacted', tone: 'neutral' });
    expect(res.value.card.logoDomain).toBe('unknown-co.example');
    expect(res.value.card.lastContact).toBeNull();
  });

  it('keeps the CRM preview and adds a card', async () => {
    const res = await previewCard(h.store, h.auth, { kind: 'crm', key: demoCrmId('record', 0) });
    if (!res.ok) throw new Error(res.error.message);
    expect(res.value.preview?.id).toBe(demoCrmId('record', 0));
    expect(res.value.card.source).toBe('affinity');
    expect(res.value.card.openHref).toBe(`/lists/records/${demoCrmId('record', 0)}`);
  });

  it('previews a deal, a portfolio company and a network contact', async () => {
    const org = h.auth.organizationId;
    const deal = ((await h.store.list('deals', org)) as Deal[])[0];
    const company = ((await h.store.list('portfolio_companies', org)) as PortfolioCompany[])[0];
    const contact = ((await h.store.list('network_contacts', org)) as NetworkContact[])[0];
    if (deal) {
      const r = await previewCard(h.store, h.auth, { kind: 'deal', key: deal.id });
      expect(r.ok && r.value.card.openHref).toBe(`/deals/${deal.id}`);
      expect(r.ok && r.value.card.title).toBe(deal.company_name);
    }
    if (company) {
      const r = await previewCard(h.store, h.auth, { kind: 'portfolio', key: company.id });
      expect(r.ok && r.value.card.openHref).toBe(`/portfolio/${company.id}`);
      expect(r.ok && r.value.card.status).toBeTruthy();
    }
    if (contact) {
      const r = await previewCard(h.store, h.auth, { kind: 'network', key: contact.id });
      expect(r.ok && r.value.card.title).toBe(contact.full_name);
    }
    for (const r of await Promise.all([
      previewCard(h.store, h.auth, { kind: 'deal', key: '00000000-0000-4000-8000-00000000dead' }),
    ])) {
      expect(!r.ok && r.error.code).toBe('not_found');
    }
  });
});
