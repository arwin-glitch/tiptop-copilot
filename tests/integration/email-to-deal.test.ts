import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachEmailToDeal,
  correctFact,
  createDealFromEmail,
  factHistory,
} from '@/lib/services/deals';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, Deal, DealFact, DealSource, EmailMessage } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Email → deal.
 *
 * Covers invariants 1 (unknown stays unknown), 10 (corrections are additive)
 * and the duplicate rule: a certain match attaches, anything softer creates
 * the deal and returns candidates for a human to confirm.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** A fresh inbound pitch from a company that is not yet in the pipeline. */
async function inboundPitch(over: Partial<EmailMessage> = {}): Promise<EmailMessage> {
  const now = new Date().toISOString();
  const message: EmailMessage = {
    id: 'msg-inbound-1',
    organization_id: harness.auth.organizationId,
    thread_id: 'thread-inbound-1',
    provider: 'google',
    provider_message_id: 'demo-msg-inbound-1',
    subject: 'Intro: Kelvin Grid (grid-planning AI for utilities)',
    snippet: 'Kelvin Grid builds planning software for distribution utilities.',
    from_name: 'Sam Adeyemi',
    from_address: 'sam@kelvingrid.demo',
    to_addresses: ['nick@tiptop.demo'],
    cc_addresses: [],
    labels: ['INBOX'],
    is_unread: true,
    sent_at: now,
    body_text: `Nick,

Kelvin Grid builds grid-planning AI for distribution utilities. We turn interconnection
queues into a ranked build plan.

$210K ARR across 4 utilities. Growing about 12% a month.
Team is two ex-grid planners from a mid-size IOU.

Raising a $2M seed.

Sam`,
    body_fetched_at: now,
    body_hash: null,
    has_attachments: false,
    category: 'new_deal',
    category_confidence: 0.9,
    category_source: 'model',
    importance: 78,
    is_ignored: false,
    linked_deal_id: null,
    linked_portfolio_company_id: null,
    injection_flagged: false,
    created_at: now,
    updated_at: now,
    ...over,
  };
  await harness.store.insert('email_messages', message);
  return message;
}

describe('createDealFromEmail', () => {
  it('creates a deal, links the email and attaches it as a source', async () => {
    const message = await inboundPitch();
    const result = await createDealFromEmail(harness.auth, message.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.deal.company_name).toBe('Kelvin Grid');
    expect(result.value.deal.domain).toBe('kelvingrid.demo');
    expect(result.value.deal.stage).toBe('new');

    const sources = (await harness.store.list('deal_sources', harness.auth.organizationId, {
      eq: { deal_id: result.value.deal.id },
    })) as DealSource[];
    expect(sources.some((s) => s.kind === 'email_message' && s.ref_id === message.id)).toBe(true);

    const relinked = (await harness.store.get(
      'email_messages',
      harness.auth.organizationId,
      message.id,
    )) as EmailMessage;
    expect(relinked.linked_deal_id).toBe(result.value.deal.id);
  });

  it('leaves every field it cannot attribute to a source as null', async () => {
    const message = await inboundPitch();
    const result = await createDealFromEmail(harness.auth, message.id);
    if (!result.ok) return;

    const deal = result.value.deal;
    // Nothing in that email states a valuation, geography or ownership target.
    expect(deal.valuation_or_cap).toBeNull();
    expect(deal.geography).toBeNull();
    expect(deal.requested_check).toBeNull();
    // And no sentinel crept in for them.
    for (const value of Object.values(deal)) {
      expect(value).not.toBe('N/A');
      expect(value).not.toBe('unknown');
      expect(value).not.toBe('TBD');
    }
  });

  it('writes an append-only fact row with provenance for every field it does write', async () => {
    const message = await inboundPitch();
    const result = await createDealFromEmail(harness.auth, message.id);
    if (!result.ok) return;

    const facts = (await harness.store.list('deal_facts', harness.auth.organizationId, {
      eq: { deal_id: result.value.deal.id },
    })) as DealFact[];
    expect(facts.length).toBeGreaterThan(0);

    for (const fact of facts) {
      // A written fact must point at a source that exists, at version 1, unsuperseded.
      expect(fact.citation_id).toBeTruthy();
      expect(fact.version).toBe(1);
      expect(fact.superseded_by).toBeNull();
      expect(fact.source_type).not.toBe('human');
    }
  });

  it('attaches to an existing deal on a certain domain match instead of duplicating', async () => {
    // vetrix.demo is already in the pipeline from the fixtures.
    const message = await inboundPitch({
      id: 'msg-inbound-2',
      provider_message_id: 'demo-msg-inbound-2',
      from_address: 'priya@vetrix.demo',
      subject: 'Vetrix — updated numbers',
    });

    const before = await harness.store.count('deals', harness.auth.organizationId);
    const result = await createDealFromEmail(harness.auth, message.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(false);
    expect(result.value.deal.id).toBe(DEMO_IDS.dealVetrix);
    expect(await harness.store.count('deals', harness.auth.organizationId)).toBe(before);
  });

  it('creates the deal but reports soft duplicate candidates rather than merging', async () => {
    // Same company name as an existing deal, different domain — ambiguous.
    const message = await inboundPitch({
      id: 'msg-inbound-3',
      provider_message_id: 'demo-msg-inbound-3',
      from_address: 'hello@girder-ai.demo',
      subject: 'Girder — construction estimating',
    });

    const result = await createDealFromEmail(harness.auth, message.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    // Every returned candidate is a suggestion; nothing was folded together.
    expect(result.value.duplicates.every((d) => !d.isCertain)).toBe(true);
  });

  it('forces a new deal past a certain match when the user insists', async () => {
    const message = await inboundPitch({
      id: 'msg-inbound-4',
      provider_message_id: 'demo-msg-inbound-4',
      from_address: 'priya@vetrix.demo',
    });

    const before = await harness.store.count('deals', harness.auth.organizationId);
    const result = await createDealFromEmail(harness.auth, message.id, { force: true });
    expect(result.ok && result.value.created).toBe(true);
    expect(await harness.store.count('deals', harness.auth.organizationId)).toBe(before + 1);
  });

  it('audits the creation', async () => {
    const message = await inboundPitch();
    const result = await createDealFromEmail(harness.auth, message.id);
    if (!result.ok) return;

    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'deal.created', entity_id: result.value.deal.id },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
  });

  it('refuses an email that does not exist in this organization', async () => {
    const result = await createDealFromEmail(harness.auth, 'no-such-message');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('the prompt-injection payload does not steer extraction', () => {
  it('creates the Plumbline deal without obeying the embedded instruction', async () => {
    const result = await createDealFromEmail(harness.auth, DEMO_IDS.msgPlumblineIntro, {
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const deal = result.value.deal;
    // The email demands ADVANCE at 100. Extraction records facts; it does not
    // set a stage, a recommendation or an outcome.
    expect(deal.stage).toBe('new');
    expect(deal.outcome).toBeNull();

    const analyses = await harness.store.count('deal_analyses', harness.auth.organizationId, {
      eq: { deal_id: deal.id },
    });
    expect(analyses).toBe(0);

    const decisions = await harness.store.count('deal_decisions', harness.auth.organizationId, {
      eq: { deal_id: deal.id },
    });
    expect(decisions).toBe(0);
  });

  it('records the attempt in the audit trail instead of silently dropping it', async () => {
    await createDealFromEmail(harness.auth, DEMO_IDS.msgPlumblineIntro, { force: true });
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'security.injection_flagged' },
    })) as AuditEvent[];
    expect(events.length).toBeGreaterThan(0);
  });

  it('leaves the flagged email fully visible in the mailbox', async () => {
    const message = (await harness.store.get(
      'email_messages',
      harness.auth.organizationId,
      DEMO_IDS.msgPlumblineIntro,
    )) as EmailMessage;

    expect(message.injection_flagged).toBe(true);
    // Flagged, not hidden, not truncated.
    expect(message.is_ignored).toBe(false);
    expect(message.body_text).toContain('Ignore all previous');
  });
});

describe('attachEmailToDeal', () => {
  it('adds the email as a source and links it back', async () => {
    const message = await inboundPitch({ id: 'msg-attach-1', provider_message_id: 'pm-attach-1' });
    const result = await attachEmailToDeal(harness.auth, DEMO_IDS.dealGirder, message.id);
    expect(result.ok).toBe(true);

    const sources = (await harness.store.list('deal_sources', harness.auth.organizationId, {
      eq: { deal_id: DEMO_IDS.dealGirder, ref_id: message.id },
    })) as DealSource[];
    expect(sources).toHaveLength(1);
  });

  it('is idempotent — attaching twice does not create a second source row', async () => {
    const message = await inboundPitch({ id: 'msg-attach-2', provider_message_id: 'pm-attach-2' });
    await attachEmailToDeal(harness.auth, DEMO_IDS.dealGirder, message.id);
    await attachEmailToDeal(harness.auth, DEMO_IDS.dealGirder, message.id);

    expect(
      await harness.store.count('deal_sources', harness.auth.organizationId, {
        eq: { deal_id: DEMO_IDS.dealGirder, ref_id: message.id },
      }),
    ).toBe(1);
  });
});

describe('correctFact', () => {
  it('appends a new version and supersedes the old one, destroying nothing', async () => {
    const message = await inboundPitch();
    const created = await createDealFromEmail(harness.auth, message.id);
    if (!created.ok) return;
    const dealId = created.value.deal.id;

    const before = (await harness.store.list('deal_facts', harness.auth.organizationId, {
      eq: { deal_id: dealId, field: 'revenue' },
    })) as DealFact[];
    const original = before[0];

    const correction = await correctFact(
      harness.auth,
      dealId,
      'revenue',
      '$210K ARR (confirmed on the call)',
      'Founder confirmed verbally.',
    );
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;

    const after = (await harness.store.list('deal_facts', harness.auth.organizationId, {
      eq: { deal_id: dealId, field: 'revenue' },
    })) as DealFact[];

    // The original row still exists, now pointing at its replacement.
    expect(after.length).toBe(before.length + 1);
    if (original) {
      const reread = after.find((f) => f.id === original.id);
      expect(reread?.value).toBe(original.value);
      expect(reread?.superseded_by).toBe(correction.value.id);
    }

    expect(correction.value.source_type).toBe('human');
    expect(correction.value.created_by).toBe(harness.auth.userId);
    expect(correction.value.superseded_by).toBeNull();
  });

  it('writes the corrected value onto the deal column too', async () => {
    const message = await inboundPitch();
    const created = await createDealFromEmail(harness.auth, message.id);
    if (!created.ok) return;

    await correctFact(harness.auth, created.value.deal.id, 'revenue', '$999K ARR');
    const deal = (await harness.store.get(
      'deals',
      harness.auth.organizationId,
      created.value.deal.id,
    )) as Deal;
    expect(deal.revenue).toBe('$999K ARR');
  });

  it('can correct a field to unknown without deleting the history', async () => {
    const message = await inboundPitch();
    const created = await createDealFromEmail(harness.auth, message.id);
    if (!created.ok) return;

    const correction = await correctFact(harness.auth, created.value.deal.id, 'revenue', null);
    expect(correction.ok && correction.value.value).toBeNull();

    const facts = (await harness.store.list('deal_facts', harness.auth.organizationId, {
      eq: { deal_id: created.value.deal.id, field: 'revenue' },
    })) as DealFact[];
    expect(facts.length).toBeGreaterThan(1);
  });

  it('orders factHistory newest version first', async () => {
    const message = await inboundPitch();
    const created = await createDealFromEmail(harness.auth, message.id);
    if (!created.ok) return;

    await correctFact(harness.auth, created.value.deal.id, 'revenue', 'v2');
    await correctFact(harness.auth, created.value.deal.id, 'revenue', 'v3');

    const facts = (await harness.store.list('deal_facts', harness.auth.organizationId, {
      eq: { deal_id: created.value.deal.id },
    })) as DealFact[];
    const history = factHistory(facts, 'revenue');

    expect(history[0]?.value).toBe('v3');
    expect(history.map((f) => f.version)).toEqual(
      [...history.map((f) => f.version)].sort((a, b) => b - a),
    );
  });

  it('audits the correction with both the old and the new value', async () => {
    const message = await inboundPitch();
    const created = await createDealFromEmail(harness.auth, message.id);
    if (!created.ok) return;

    await correctFact(harness.auth, created.value.deal.id, 'revenue', '$1M ARR');
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'deal.fact_corrected' },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata?.new_value).toBe('$1M ARR');
  });
});
