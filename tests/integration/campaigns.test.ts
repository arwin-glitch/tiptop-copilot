import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoCampaignSender } from '@/lib/campaigns/demo-sender';
import { readTrackingToken, trackingToken } from '@/lib/campaigns/tokens';
import type { DataStore } from '@/lib/db/store';
import { DEMO_IDS, demoCampaignId } from '@/lib/demo/ids';
import { LocalStorageProvider } from '@/lib/storage/provider';
import {
  addAttachmentChunk,
  addRecipientsFromList,
  addRecipientsFromPaste,
  checkReplies,
  confirmCampaign,
  controlCampaign,
  createCampaign,
  deleteCampaign,
  fillRecipientMerge,
  getCampaign,
  listCampaigns,
  listUnsubscribes,
  recordClick,
  recordOpen,
  removeAttachment,
  removeRecipients,
  resolveTestClick,
  resubscribe,
  reviewCampaign,
  sendBatch,
  sendTest,
  suppressEmail,
  unsubscribe,
  updateCampaign,
  type BatchDeps,
} from '@/lib/services/campaigns';
import type { Campaign, CampaignRecipient, EmailMessage, EmailThread } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { PROCESS_ZONES, underProcessZone } from '../helpers/process-zone';

/**
 * Campaigns end to end on the demo store: draft, recipients, review, the one
 * confirmation, paced batches through a sender that sends nothing, tracking,
 * unsubscribes, replies, every way a send stops, and the races between two
 * tabs or two server instances.
 */

let harness: Harness;
let org: string;
let storage: LocalStorageProvider;

beforeEach(async () => {
  harness = await createHarness();
  org = harness.auth.organizationId;
  storage = new LocalStorageProvider();
});

afterEach(async () => {
  await harness.dispose();
});

const actor = () => ({ userId: harness.auth.userId });
const LINK = 'https://tiptop.example/q4';
/** A mail app's user agent: a person reading. */
const MAIL_APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function deps(sender: DemoCampaignSender, extra: Partial<BatchDeps> = {}): BatchDeps {
  return {
    sender,
    storage,
    appUrl: 'https://copilot.example',
    sleep: async () => {},
    intervalMs: 0,
    ...extra,
  };
}

async function draftWithLps(): Promise<Campaign> {
  const created = await createCampaign(harness.store, org, actor(), { name: 'Q4 LP update' });
  if (!created.ok) throw new Error(created.error.message);
  const added = await addRecipientsFromList(harness.store, org, created.value.id, {
    listId: DEMO_IDS.crmListLps,
  });
  if (!added.ok) throw new Error(added.error.message);
  const updated = await updateCampaign(harness.store, org, created.value.id, {
    subject: 'Q4 for {{company|you}}',
    body_template: `Hi {{first_name|there}},\n\nThe letter: [read it](${LINK}).`,
  });
  if (!updated.ok) throw new Error(updated.error.message);
  return updated.value;
}

async function expectation(store: DataStore, campaignId: string) {
  const review = await reviewCampaign(store, org, campaignId);
  if (!review.ok) throw new Error(review.error.message);
  return {
    version: review.value.version,
    recipients: review.value.recipientCount,
    subject: review.value.campaign.subject,
    from: review.value.campaign.from_identity,
    track: review.value.campaign.track_activity,
    unsubscribe: review.value.campaign.unsubscribe_link,
  };
}

async function confirm(campaign: Campaign, store: DataStore = harness.store): Promise<Campaign> {
  const confirmed = await confirmCampaign(
    store,
    org,
    campaign.id,
    actor(),
    await expectation(store, campaign.id),
  );
  if (!confirmed.ok) throw new Error(confirmed.error.message);
  return confirmed.value;
}

async function recipients(campaignId: string): Promise<CampaignRecipient[]> {
  const detail = await getCampaign(harness.store, org, campaignId);
  if (!detail.ok) throw new Error(detail.error.message);
  return detail.value.recipients;
}

/** The store, but `hook` runs just before the first updateWhere that `matches`. */
function racing(
  matches: (table: string, filter: { eq?: Record<string, unknown> }, patch: object) => boolean,
  hook: () => Promise<void>,
): DataStore {
  const target = harness.store;
  let fired = false;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'updateWhere') {
        return async (...args: Parameters<DataStore['updateWhere']>) => {
          const [table, , filter, patch] = args;
          if (!fired && matches(table, filter, patch as object)) {
            fired = true;
            await hook();
          }
          return obj.updateWhere(...args);
        };
      }
      const value = Reflect.get(obj, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(obj)
        : value;
    },
  });
}

describe('a new draft', () => {
  // 9 PM Central on Oct 18, when the server's UTC clock already says Oct 19.
  const EVENING = new Date('2026-10-19T02:00:00Z');

  it('with no name is called after today in the creator’s timezone, whatever the process zone', async () => {
    for (const tz of PROCESS_ZONES) {
      const created = await underProcessZone(tz, () =>
        createCampaign(harness.store, org, actor(), {
          timeZone: 'America/Chicago',
          now: EVENING,
        }),
      );
      if (!created.ok) throw new Error(created.error.message);
      expect(created.value.name, tz).toBe('Campaign Oct 18, 2026');
      expect(created.value.created_at).toBe(EVENING.toISOString());
    }
  });

  it('reads the profile’s own timezone, and Central when none is given', async () => {
    const tokyo = await createCampaign(harness.store, org, actor(), {
      timeZone: 'Asia/Tokyo',
      now: EVENING,
    });
    const unset = await createCampaign(harness.store, org, actor(), { now: EVENING });
    expect(tokyo.ok && tokyo.value.name).toBe('Campaign Oct 19, 2026');
    expect(unset.ok && unset.value.name).toBe('Campaign Oct 18, 2026');
  });

  it('keeps a name it was given', async () => {
    const created = await createCampaign(harness.store, org, actor(), {
      name: '  Fund II close  ',
      timeZone: 'America/Chicago',
    });
    expect(created.ok && created.value.name).toBe('Fund II close');
  });
});

describe('recipients', () => {
  it('come from a CRM list, minus anyone who unsubscribed', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const added = await addRecipientsFromList(harness.store, org, created.value.id, {
      listId: DEMO_IDS.crmListLps,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // Five LPs; Hana unsubscribed from the Q3 update in the fixtures.
    expect(added.value).toMatchObject({
      added: 4,
      unsubscribed: 1,
      unsubscribedEmails: ['hana@riverlight.example'],
      total: 4,
    });
    const rows = await recipients(created.value.id);
    const maren = rows.find((r) => r.email === 'maren@oakhaven-capital.example');
    expect(maren?.merge).toEqual({
      name: 'Maren Solberg',
      first_name: 'Maren',
      company: 'Oakhaven Capital',
    });
    expect(maren?.record_id).toBeTruthy();
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('filter a list by status', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const added = await addRecipientsFromList(harness.store, org, created.value.id, {
      listId: DEMO_IDS.crmListLps,
      statuses: ['Soft Circle', 'Committed'],
    });
    expect(added.ok && added.value.added).toBe(2);
  });

  it("take a company list's people, with the company as {{company}}", async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const added = await addRecipientsFromList(harness.store, org, created.value.id, {
      listId: DEMO_IDS.crmListPortfolio,
    });
    expect(added.ok).toBe(true);
    const rows = await recipients(created.value.id);
    const sven = rows.find((r) => r.email === 'sven@kestrel-analytics.example');
    expect(sven?.merge.company).toBe('Kestrel Analytics');
  });

  it('can be pasted, deduped, and matched to CRM people', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const added = await addRecipientsFromPaste(
      harness.store,
      org,
      created.value.id,
      'desmond@pinecrest-fo.example\nDESMOND@pinecrest-fo.example\nnew.person@lp.example, nope@',
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value).toMatchObject({ added: 2, duplicates: 1, invalid: ['nope@'] });
    const rows = await recipients(created.value.id);
    expect(rows.find((r) => r.email === 'desmond@pinecrest-fo.example')?.name).toBe(
      'Desmond Achterberg',
    );
    // Adding the same again changes nothing.
    const again = await addRecipientsFromPaste(
      harness.store,
      org,
      created.value.id,
      'new.person@lp.example',
    );
    expect(again.ok && again.value).toMatchObject({ added: 0, alreadyIn: 1, total: 2 });
    const removed = await removeRecipients(harness.store, org, created.value.id, { all: true });
    expect(removed.ok && removed.value).toEqual({ removed: 2, total: 0 });
  });
});

describe('review and the one confirmation', () => {
  it('lists what must be fixed first', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const review = await reviewCampaign(harness.store, org, created.value.id);
    expect(review.ok && review.value.issues).toEqual([
      'Add at least one recipient.',
      'Write a subject.',
      'Write the email.',
    ]);
  });

  it('refuses anything other than exactly what was reviewed', async () => {
    const campaign = await draftWithLps();
    const base = await expectation(harness.store, campaign.id);
    for (const wrong of [
      { ...base, recipients: base.recipients + 1 },
      { ...base, subject: 'Something else' },
      { ...base, from: 'arwin' as const },
      { ...base, track: !base.track },
      { ...base, unsubscribe: !base.unsubscribe },
      { ...base, version: '2001-01-01T00:00:00.000Z' },
    ]) {
      const result = await confirmCampaign(harness.store, org, campaign.id, actor(), wrong);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('conflict');
    }
    // A change after the review (one more recipient) makes the review stale.
    await addRecipientsFromPaste(harness.store, org, campaign.id, 'late@lp.example');
    const stale = await confirmCampaign(harness.store, org, campaign.id, actor(), base);
    expect(stale.ok).toBe(false);
    // So does a switch flipped after it, even with the count unchanged.
    const fresh = await expectation(harness.store, campaign.id);
    await updateCampaign(harness.store, org, campaign.id, { track_activity: false });
    const flipped = await confirmCampaign(harness.store, org, campaign.id, actor(), fresh);
    expect(flipped.ok).toBe(false);
    const still = await harness.store.get('campaigns', org, campaign.id);
    expect(still?.status).toBe('draft');
  });

  it('starts sending, records the allowlist and the reviewed recipients, and audits the tap', async () => {
    const draft = await draftWithLps();
    const rows = await recipients(draft.id);
    const confirmed = await confirm(draft);
    expect(confirmed.status).toBe('sending');
    expect(confirmed.link_allowlist).toEqual([LINK]);
    expect(confirmed.confirmed_by).toBe(harness.auth.userId);
    expect(confirmed.confirmed_through).toBe(rows.at(-1)?.created_at);
    const audits = await harness.store.list('audit_events', org, {
      eq: { action: 'campaign.confirmed' },
    });
    expect(audits[0]?.metadata).toMatchObject({ recipients: 4, from: 'nick', tracking: true });
    // A sent campaign can no longer be edited.
    const edit = await updateCampaign(harness.store, org, confirmed.id, { subject: 'x' });
    expect(edit.ok).toBe(false);
  });

  it('a draft sends nothing, however often a batch is asked for', async () => {
    const campaign = await draftWithLps();
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(batch.ok && batch.value.state).toBe('idle');
    expect(sender.sent).toHaveLength(0);
  });

  it('will not start with Copilot links on a local address, but a plain email needs none', async () => {
    const campaign = await draftWithLps();
    const local = { appUrl: null };
    const review = await reviewCampaign(harness.store, org, campaign.id, local);
    expect(review.ok && review.value.issues.some((i) => /APP_URL/.test(i))).toBe(true);
    const refused = await confirmCampaign(
      harness.store,
      org,
      campaign.id,
      actor(),
      await expectation(harness.store, campaign.id),
      local,
    );
    expect(refused.ok).toBe(false);

    await updateCampaign(harness.store, org, campaign.id, { track_activity: false });
    const plain = await confirmCampaign(
      harness.store,
      org,
      campaign.id,
      actor(),
      await expectation(harness.store, campaign.id),
      local,
    );
    expect(plain.ok).toBe(true);
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender, { appUrl: null }));
    expect(batch.ok && batch.value.state).toBe('done');
    expect(sender.sent.every((e) => !e.html.includes('copilot') && !e.listUnsubscribe)).toBe(true);
    expect(sender.sent[0]?.html).toContain(`href="${LINK}"`);
  });
});

describe('filling in missing merge values from the review', () => {
  const NEW_LP = 'dana.new@fill.example';
  const LUCIA = 'lucia.ferraro@mail.example';

  /** Lucia is a CRM person with no company; the new LP is a bare pasted address. */
  async function draftToFill(): Promise<Campaign> {
    const created = await createCampaign(harness.store, org, actor(), { name: 'Fill test' });
    if (!created.ok) throw new Error(created.error.message);
    const added = await addRecipientsFromPaste(
      harness.store,
      org,
      created.value.id,
      `${LUCIA}\n${NEW_LP}`,
    );
    if (!added.ok) throw new Error(added.error.message);
    const updated = await updateCampaign(harness.store, org, created.value.id, {
      subject: 'Hello {{first_name|there}}',
      body_template: `A note for {{company|your firm}}: [read it](${LINK}).`,
    });
    if (!updated.ok) throw new Error(updated.error.message);
    return updated.value;
  }

  async function reviewOf(campaignId: string) {
    const review = await reviewCampaign(harness.store, org, campaignId);
    if (!review.ok) throw new Error(review.error.message);
    return review.value;
  }

  const recipientBy = async (campaignId: string, email: string) =>
    (await recipients(campaignId)).find((r) => r.email === email) as CampaignRecipient;

  const fill = (
    campaignId: string,
    recipientId: string,
    values: Record<string, string>,
    saveToContact = false,
    store: DataStore = harness.store,
  ) => fillRecipientMerge(store, org, campaignId, actor(), { recipientId, values, saveToContact });

  it('the review lists who lacks which field, with their CRM contact', async () => {
    const campaign = await draftToFill();
    const review = await reviewOf(campaign.id);
    expect(review.fallbacks).toEqual([
      { field: 'first_name', count: 1 },
      { field: 'company', count: 2 },
    ]);
    const lucia = review.missing.find((p) => p.email === LUCIA);
    expect(lucia).toMatchObject({
      name: 'Lucia Ferraro',
      lacks: ['company'],
      contact: { name: 'Lucia Ferraro', company: null },
    });
    expect(review.missing.find((p) => p.email === NEW_LP)).toMatchObject({
      name: null,
      lacks: ['first_name', 'name', 'company'],
      contact: null,
    });
  });

  it('a fill drops the counts, stales the old review, and is what the email says', async () => {
    const campaign = await draftToFill();
    const before = await expectation(harness.store, campaign.id);
    const dana = await recipientBy(campaign.id, NEW_LP);
    const saved = await fill(campaign.id, dana.id, { first_name: ' Dana ', company: 'Fillmore' });
    expect(saved.ok && saved.value).toEqual({
      filled: ['first_name', 'company'],
      contact: { status: 'skipped' },
    });
    expect((await recipientBy(campaign.id, NEW_LP)).merge).toEqual({
      first_name: 'Dana',
      company: 'Fillmore',
    });
    const review = await reviewOf(campaign.id);
    expect(review.fallbacks).toEqual([{ field: 'company', count: 1 }]);
    expect(review.missing.map((p) => p.email)).toEqual([LUCIA]);
    const audits = await harness.store.list('audit_events', org, {
      eq: { action: 'campaign.recipient_updated' },
    });
    expect(audits[0]?.metadata).toMatchObject({ fields: ['first_name', 'company'] });

    // The review read before the fill can no longer be confirmed.
    const stale = await confirmCampaign(harness.store, org, campaign.id, actor(), before);
    expect(stale.ok).toBe(false);
    const confirmed = await confirm(campaign);
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, confirmed.id, deps(sender));
    expect(batch.ok && batch.value.state).toBe('done');
    const toDana = sender.sent.find((e) => e.to.includes(NEW_LP));
    expect(toDana?.subject).toBe('Hello Dana');
    expect(toDana?.text).toContain('A note for Fillmore');
    // Lucia was left empty: she still gets the fallback.
    const toLucia = sender.sent.find((e) => e.to.includes(LUCIA));
    expect(toLucia?.text).toContain('A note for your firm');
  });

  it('fills only what is empty: a value already there stays', async () => {
    const campaign = await draftToFill();
    const lucia = await recipientBy(campaign.id, LUCIA);
    const saved = await fill(campaign.id, lucia.id, { name: 'Someone Else', company: 'Ferro' });
    expect(saved.ok && saved.value.filled).toEqual(['company']);
    expect((await recipientBy(campaign.id, LUCIA)).merge).toMatchObject({
      name: 'Lucia Ferraro',
      company: 'Ferro',
    });
    const again = await fill(campaign.id, lucia.id, { company: 'Other' });
    expect(again.ok && again.value).toEqual({ filled: [], contact: { status: 'skipped' } });
  });

  it('writes the CRM contact only when asked, naming what it changed', async () => {
    const campaign = await draftToFill();
    const lucia = await recipientBy(campaign.id, LUCIA);
    const recordId = lucia.record_id as string;
    const untouched = await harness.store.get('crm_records', org, recordId);

    // Not asked: the campaign has it, the contact does not.
    const quiet = await fill(campaign.id, lucia.id, { company: 'Ferro Partners' });
    expect(quiet.ok && quiet.value.contact).toEqual({ status: 'skipped' });
    expect(await harness.store.get('crm_records', org, recordId)).toEqual(untouched);

    // Asked: the same value goes to the contact.
    const second = await draftToFill();
    const lucia2 = await recipientBy(second.id, LUCIA);
    const asked = await fill(second.id, lucia2.id, { company: 'Ferro Partners' }, true);
    expect(asked.ok && asked.value.contact).toEqual({ status: 'saved', fields: ['company'] });
    const record = await harness.store.get('crm_records', org, recordId);
    expect(record?.fields).toMatchObject({ Company: 'Ferro Partners' });
    expect(record?.name).toBe('Lucia Ferraro');
    const audits = await harness.store.list('audit_events', org, {
      eq: { action: 'crm.record_updated' },
    });
    expect(audits[0]?.metadata).toEqual({ fields: ['company'] });

    // The next review shows the contact's company beside the checkbox.
    const third = await draftToFill();
    const review = await reviewOf(third.id);
    expect(review.missing.find((p) => p.email === LUCIA)?.contact).toEqual({
      name: 'Lucia Ferraro',
      company: 'Ferro Partners',
    });
  });

  it('a full name and company replace the contact’s, a list of companies keeps the rest', async () => {
    const campaign = await draftToFill();
    const lucia = await recipientBy(campaign.id, LUCIA);
    const recordId = lucia.record_id as string;
    await harness.store.update('crm_records', org, recordId, {
      name: LUCIA,
      fields: { Organizations: ['Old Mill', 'Second Co'] },
    });
    // Her merge name was the address too, as a record without a name gives.
    await harness.store.update('campaign_recipients', org, lucia.id, {
      name: LUCIA,
      merge: { name: LUCIA },
    });
    const saved = await fill(
      campaign.id,
      lucia.id,
      { name: 'Lucia Ferraro-Ng', company: 'New Mill' },
      true,
    );
    expect(saved.ok && saved.value).toEqual({
      filled: ['name', 'company'],
      contact: { status: 'saved', fields: ['name', 'company'] },
    });
    const record = await harness.store.get('crm_records', org, recordId);
    expect(record).toMatchObject({
      name: 'Lucia Ferraro-Ng',
      name_key: 'lucia ferraro-ng',
      fields: { Organizations: ['New Mill', 'Old Mill', 'Second Co'] },
    });
  });

  it('a recipient with no contact is filled for the campaign alone', async () => {
    const campaign = await draftToFill();
    const dana = await recipientBy(campaign.id, NEW_LP);
    const saved = await fill(campaign.id, dana.id, { name: 'Dana Newell' }, true);
    expect(saved.ok && saved.value).toEqual({
      filled: ['name'],
      contact: { status: 'not_linked' },
    });
    // The full name fills the first name too.
    const review = await reviewOf(campaign.id);
    expect(review.fallbacks).toEqual([{ field: 'company', count: 2 }]);
  });

  it('refuses what cannot be filled', async () => {
    const campaign = await draftToFill();
    const dana = await recipientBy(campaign.id, NEW_LP);
    const empty = await fill(campaign.id, dana.id, { first_name: '  ' });
    expect(!empty.ok && empty.error.code).toBe('invalid_input');
    const address = await fill(campaign.id, dana.id, { name: NEW_LP });
    expect(!address.ok && address.error.message).toBe('A name cannot be an email address.');
    const other = await draftToFill();
    const elsewhere = await fill(other.id, dana.id, { first_name: 'Dana' });
    expect(!elsewhere.ok && elsewhere.error.code).toBe('not_found');
    const bogus = await fill(campaign.id, 'not-an-id', { first_name: 'Dana' });
    expect(!bogus.ok && bogus.error.code).toBe('not_found');

    await confirm(campaign);
    const started = await fill(campaign.id, dana.id, { first_name: 'Dana' });
    expect(!started.ok && started.error.code).toBe('conflict');
    expect((await recipientBy(campaign.id, NEW_LP)).merge).toEqual({});
  });

  it('a fill racing the tap is put back, so the email sent is the one reviewed', async () => {
    const campaign = await draftToFill();
    const dana = await recipientBy(campaign.id, NEW_LP);
    const store = racing(
      (table, filter, patch) =>
        table === 'campaigns' &&
        filter.eq?.status === 'draft' &&
        Object.keys(patch).join() === 'updated_at',
      async () => {
        await confirm(campaign);
      },
    );
    const saved = await fill(campaign.id, dana.id, { first_name: 'Dana' }, false, store);
    expect(saved.ok).toBe(false);
    expect((await harness.store.get('campaigns', org, campaign.id))?.status).toBe('sending');
    expect((await recipientBy(campaign.id, NEW_LP)).merge).toEqual({});
  });
});

describe('what was reviewed is what goes, even when a second tab races the tap', () => {
  it('a file that finishes uploading after the tap never joins, and its pieces go', async () => {
    const campaign = await draftWithLps();
    const uploadId = '00000000-0000-4000-8000-0000000c0009';
    const meta = { uploadId, count: 2, name: 'Late.pdf', type: 'application/pdf', size: 8 };
    await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...meta, index: 0 },
      Buffer.from('%PDF'),
    );
    // The tap lands while the last piece is being read back.
    const store = racing(
      (table, _f, patch) => table === 'campaigns' && 'attachments' in patch,
      async () => {
        await confirm(campaign);
      },
    );
    const last = await addAttachmentChunk(
      store,
      storage,
      org,
      campaign.id,
      { ...meta, index: 1 },
      Buffer.from('-1.4'),
    );
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error.code).toBe('conflict');
    const after = await harness.store.get('campaigns', org, campaign.id);
    expect(after).toMatchObject({ status: 'sending', attachments: [] });
    const piece = await storage.get(`campaigns/${org}/${campaign.id}/${uploadId}/0`);
    expect(piece.ok).toBe(false);
  });

  it('a removal racing the tap leaves the reviewed attachment and its pieces alone', async () => {
    const campaign = await draftWithLps();
    const uploadId = '00000000-0000-4000-8000-0000000c000a';
    await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { uploadId, index: 0, count: 1, name: 'Deck.pdf', type: 'application/pdf', size: 4 },
      Buffer.from('%PDF'),
    );
    const reviewed = (await harness.store.get('campaigns', org, campaign.id)) as Campaign;
    const store = racing(
      (table, _f, patch) => table === 'campaigns' && 'attachments' in patch,
      async () => {
        await confirm(reviewed);
      },
    );
    const removed = await removeAttachment(store, storage, org, campaign.id, uploadId);
    expect(removed.ok).toBe(false);
    const after = await harness.store.get('campaigns', org, campaign.id);
    expect(after?.attachments.map((a) => a.id)).toEqual([uploadId]);
    expect((await storage.get(`campaigns/${org}/${campaign.id}/${uploadId}/0`)).ok).toBe(true);
  });

  it('a save racing the tap is refused, so the body sent is the body reviewed', async () => {
    const campaign = await draftWithLps();
    const store = racing(
      (table, _f, patch) => table === 'campaigns' && 'body_template' in patch,
      async () => {
        await confirm(campaign);
      },
    );
    const saved = await updateCampaign(store, org, campaign.id, {
      body_template: 'Something nobody reviewed: [here](https://evil.example/)',
    });
    expect(saved.ok).toBe(false);
    const after = await harness.store.get('campaigns', org, campaign.id);
    expect(after?.status).toBe('sending');
    expect(after?.body_template).toBe(campaign.body_template);
    expect(after?.link_allowlist).toEqual([LINK]);
  });

  it('people added as the tap lands are taken out again, and never sent', async () => {
    const campaign = await draftWithLps();
    // The confirmation reads the campaign before these rows go in.
    const store = new Proxy(harness.store, {
      get(obj, prop, receiver) {
        if (prop === 'insertMany') {
          return async (...args: Parameters<DataStore['insertMany']>) => {
            await confirm(campaign);
            return obj.insertMany(...args);
          };
        }
        const value = Reflect.get(obj, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(obj)
          : value;
      },
    });
    const added = await addRecipientsFromPaste(store, org, campaign.id, 'late@lp.example');
    expect(added.ok).toBe(false);
    expect((await recipients(campaign.id)).map((r) => r.email)).not.toContain('late@lp.example');
  });

  it('a recipient that slipped in after the reviewed ones is skipped by the batch', async () => {
    const campaign = await confirm(await draftWithLps());
    const [first] = await recipients(campaign.id);
    const lateAt = new Date(Date.parse(campaign.confirmed_through as string) + 1_000).toISOString();
    await harness.store.insert('campaign_recipients', {
      ...(first as CampaignRecipient),
      id: '00000000-0000-4000-8000-0000000d0001',
      email: 'slipped@lp.example',
      name: null,
      created_at: lateAt,
      updated_at: lateAt,
    });
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(batch.ok && batch.value.state).toBe('done');
    expect(sender.sent).toHaveLength(4);
    expect(sender.sent.some((e) => e.to.includes('slipped@'))).toBe(false);
    const slipped = await harness.store.get(
      'campaign_recipients',
      org,
      '00000000-0000-4000-8000-0000000d0001',
    );
    expect(slipped).toMatchObject({ status: 'skipped' });
    expect(slipped?.error).toMatch(/after the review/);
  });

  it('deleting a draft claims it first, so a tap racing it cannot start it', async () => {
    const campaign = await draftWithLps();
    const store = racing(
      (table, filter) => table === 'campaigns' && filter.eq?.status === 'draft',
      async () => {
        await confirm(campaign);
      },
    );
    const deleted = await deleteCampaign(store, storage, org, campaign.id, actor());
    expect(deleted.ok).toBe(false);
    expect((await harness.store.get('campaigns', org, campaign.id))?.status).toBe('sending');
  });
});

describe('sending', () => {
  it('goes in paced batches until everyone is sent, recording Gmail ids', async () => {
    const campaign = await confirm(await draftWithLps());
    const sender = new DemoCampaignSender();
    const waits: number[] = [];
    const paced = deps(sender, {
      batchMax: 3,
      intervalMs: 2_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const first = await sendBatch(harness.store, org, campaign.id, paced);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({ state: 'sending', sentNow: 3, status: 'sending' });
    expect(first.value.counts).toMatchObject({ sent: 3, pending: 1 });
    // Every send after the first waited for the pace.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.every((ms) => ms > 0 && ms <= 2_000)).toBe(true);

    const second = await sendBatch(harness.store, org, campaign.id, paced);
    expect(second.ok && second.value).toMatchObject({ state: 'done', status: 'sent', sentNow: 1 });

    const rows = await recipients(campaign.id);
    expect(rows.every((r) => r.status === 'sent' && r.gmail_message_id && r.sent_at)).toBe(true);
    const after = await harness.store.get('campaigns', org, campaign.id);
    expect(after?.status).toBe('sent');
    expect(after?.sent_at).toBeTruthy();

    // One personal email each, with tracking and (by default) no unsubscribe line.
    expect(sender.sent.map((e) => e.to).sort()).toEqual(
      rows.map((r) => `"${r.name}" <${r.email}>`).sort(),
    );
    const toMaren = sender.sent.find((e) => e.to.includes('maren@'));
    expect(toMaren?.subject).toBe('Q4 for Oakhaven Capital');
    expect(toMaren?.html).toContain('Hi Maren,');
    expect(toMaren?.html).toContain('https://copilot.example/t/o/');
    expect(toMaren?.html).toContain('https://copilot.example/t/c/');
    expect(toMaren?.html).not.toContain(`href="${LINK}"`);
    expect(toMaren?.html).not.toContain('/t/u/');
    expect(toMaren?.listUnsubscribe).toBeNull();

    // Asking again after it finished sends nothing more.
    const third = await sendBatch(harness.store, org, campaign.id, paced);
    expect(third.ok && third.value.state).toBe('idle');
    expect(sender.sent).toHaveLength(4);
  });

  it('carries the unsubscribe line and header only when switched on', async () => {
    const draft = await draftWithLps();
    await updateCampaign(harness.store, org, draft.id, { unsubscribe_link: true });
    const campaign = await confirm(draft);
    const sender = new DemoCampaignSender();
    await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(sender.sent[0]?.listUnsubscribe).toMatch(/^https:\/\/copilot\.example\/t\/u\//);
    expect(sender.sent[0]?.html).toContain('unsubscribe</a>');
  });

  it('paces across campaigns: the organization’s last email sets the next one’s wait', async () => {
    const one = await confirm(await draftWithLps());
    await sendBatch(harness.store, org, one.id, deps(new DemoCampaignSender(), { batchMax: 1 }));
    const two = await confirm(await draftWithLps());
    const waits: number[] = [];
    await sendBatch(
      harness.store,
      org,
      two.id,
      deps(new DemoCampaignSender(), {
        batchMax: 1,
        intervalMs: 60_000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    );
    // The second campaign had never sent, yet it waited for the first one's email.
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('stops at the daily cap, pauses, and says when the next slot opens', async () => {
    const campaign = await confirm(await draftWithLps());
    const sender = new DemoCampaignSender();
    const capped = deps(sender, { dailyCap: 2 });
    const first = await sendBatch(harness.store, org, campaign.id, capped);
    expect(first.ok && first.value.sentNow).toBe(2);
    const second = await sendBatch(harness.store, org, campaign.id, capped);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({
      state: 'capped',
      status: 'paused',
      pauseReason: 'capped',
      dailyRemaining: 0,
    });
    expect(second.value.message).toMatch(/Daily limit reached/);
    expect(second.value.capResetsAt).toBeTruthy();
    expect(sender.sent).toHaveLength(2);
  });

  it('pauses, resumes and cancels', async () => {
    const campaign = await confirm(await draftWithLps());
    const sender = new DemoCampaignSender();
    const paused = await controlCampaign(harness.store, org, campaign.id, actor(), 'pause');
    expect(paused.ok && paused.value).toMatchObject({ status: 'paused', pause_reason: 'manual' });
    const none = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(none.ok && none.value.state).toBe('paused');
    expect(sender.sent).toHaveLength(0);

    const resumed = await controlCampaign(harness.store, org, campaign.id, actor(), 'resume');
    expect(resumed.ok && resumed.value).toMatchObject({ status: 'sending', pause_reason: null });
    await sendBatch(harness.store, org, campaign.id, deps(sender, { batchMax: 1 }));
    expect(sender.sent).toHaveLength(1);

    const cancelled = await controlCampaign(harness.store, org, campaign.id, actor(), 'cancel');
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    const rows = await recipients(campaign.id);
    expect(rows.filter((r) => r.status === 'skipped')).toHaveLength(3);
    const after = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(after.ok && after.value.state).toBe('idle');
    expect(sender.sent).toHaveLength(1);
  });

  it('leaving the sending page pauses it, so every view says so', async () => {
    const campaign = await confirm(await draftWithLps());
    const left = await controlCampaign(harness.store, org, campaign.id, actor(), 'pause', {
      reason: 'left',
    });
    expect(left.ok && left.value).toMatchObject({ status: 'paused', pause_reason: 'left' });
    // Leaving a page that was not sending changes nothing, and is not an error.
    const again = await controlCampaign(harness.store, org, campaign.id, actor(), 'pause', {
      reason: 'left',
    });
    expect(again.ok && again.value.status).toBe('paused');
    const manual = await controlCampaign(harness.store, org, campaign.id, actor(), 'pause');
    expect(manual.ok).toBe(false);
  });

  it('pauses after failures in a row, and retries only on request', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    await addRecipientsFromPaste(
      harness.store,
      org,
      created.value.id,
      'a@fail.example\nb@fail.example\nc@fail.example\nd@lp.example',
    );
    const campaign = await updateCampaign(harness.store, org, created.value.id, {
      subject: 'Hello',
      body_template: 'Hi',
    });
    if (!campaign.ok) throw new Error('update');
    await confirm(campaign.value);
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.value.id, deps(sender));
    expect(batch.ok && batch.value).toMatchObject({
      state: 'paused',
      pauseReason: 'failures',
      failedNow: 3,
      sentNow: 0,
    });
    expect(batch.ok && batch.value.message).toMatch(/in a row/);

    const retry = await controlCampaign(
      harness.store,
      org,
      campaign.value.id,
      actor(),
      'retry_failed',
    );
    expect(retry.ok && retry.value.status).toBe('sending');
    const rows = await recipients(campaign.value.id);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(4);
  });

  it('refuses to send without the signature, sending nothing', async () => {
    const campaign = await confirm(await draftWithLps());
    const sender = new DemoCampaignSender('nick@tiptop.demo', { nick: null });
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.error.message).toMatch(/signature/);
    expect(sender.sent).toHaveLength(0);
    expect((await recipients(campaign.id)).every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('one sender at a time, across tabs and server instances', () => {
  it('a lease held by another instance means busy, and nothing is sent', async () => {
    const campaign = await confirm(await draftWithLps());
    await harness.store.insert('campaign_send_locks', {
      organization_id: org,
      lease_token: 'held-by-another-instance',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      campaign_id: campaign.id,
      last_sent_at: null,
      updated_at: new Date().toISOString(),
    });
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(batch.ok && batch.value.state).toBe('busy');
    expect(sender.sent).toHaveLength(0);
  });

  it('a lease left by a crashed batch is taken over once it expires', async () => {
    const campaign = await confirm(await draftWithLps());
    await harness.store.insert('campaign_send_locks', {
      organization_id: org,
      lease_token: 'crashed',
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      campaign_id: campaign.id,
      last_sent_at: null,
      updated_at: new Date().toISOString(),
    });
    const sender = new DemoCampaignSender();
    const batch = await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(batch.ok && batch.value.state).toBe('done');
    expect(sender.sent).toHaveLength(4);
    const [lock] = await harness.store.list('campaign_send_locks', org);
    // Released, with the organization's last send kept for the pace.
    expect(lock).toMatchObject({ lease_expires_at: null });
    expect(lock?.last_sent_at).toBeTruthy();
  });

  it('two batches at once never send anyone the same email twice', async () => {
    const campaign = await confirm(await draftWithLps());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new DemoCampaignSender();
    const send = slow.send.bind(slow);
    let calls = 0;
    slow.send = async (email) => {
      calls += 1;
      if (calls === 1) await gate;
      return send(email);
    };
    const first = sendBatch(harness.store, org, campaign.id, deps(slow));
    await vi.waitFor(() => expect(calls).toBe(1));
    // A second server instance does not share this process's lock: only the
    // database lease stands between it and the same recipients.
    processWide('campaign-send-locks', () => new Set<string>()).delete(org);
    const other = new DemoCampaignSender();
    const second = await sendBatch(harness.store, org, campaign.id, deps(other));
    expect(second.ok && second.value.state).toBe('busy');
    release();
    const done = await first;
    expect(done.ok && done.value.state).toBe('done');
    expect(other.sent).toHaveLength(0);
    const to = slow.sent.map((e) => e.to);
    expect(new Set(to).size).toBe(4);
    expect(to).toHaveLength(4);
  });

  it('a recipient claimed elsewhere between the queue and the send is not sent here', async () => {
    const campaign = await confirm(await draftWithLps());
    const [victim] = await recipients(campaign.id);
    const store = racing(
      (table, filter, patch) =>
        table === 'campaign_recipients' && 'attempted_at' in patch && filter.eq?.id === victim!.id,
      async () => {
        await harness.store.update('campaign_recipients', org, victim!.id, {
          attempted_at: new Date().toISOString(),
        });
      },
    );
    const sender = new DemoCampaignSender();
    await sendBatch(store, org, campaign.id, deps(sender));
    expect(sender.sent.some((e) => e.to.includes(victim!.email))).toBe(false);
    expect(sender.sent).toHaveLength(3);
  });
});

describe('"may have gone out"', () => {
  async function interrupted() {
    const campaign = await confirm(await draftWithLps());
    const [first] = await recipients(campaign.id);
    const attemptedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await harness.store.update('campaign_recipients', org, first!.id, {
      attempted_at: attemptedAt,
    });
    const sender = new DemoCampaignSender();
    await sendBatch(harness.store, org, campaign.id, deps(sender));
    return { campaign, first: first!, sender, attemptedAt };
  }

  it('is never sent again on its own, and is not a failure', async () => {
    const { campaign, first, sender } = await interrupted();
    const row = await harness.store.get('campaign_recipients', org, first.id);
    expect(row?.status).toBe('unconfirmed');
    expect(row?.error).toMatch(/may have gone out/);
    expect(sender.sent.some((e) => e.to.includes(first.email))).toBe(false);
    expect(sender.sent).toHaveLength(3);
    // "Retry failed" leaves it alone: there is nothing failed to retry.
    const retry = await controlCampaign(harness.store, org, campaign.id, actor(), 'retry_failed');
    expect(retry.ok).toBe(false);
    expect((await harness.store.get('campaign_recipients', org, first.id))?.status).toBe(
      'unconfirmed',
    );
    const detail = await getCampaign(harness.store, org, campaign.id);
    expect(detail.ok && detail.value.counts).toMatchObject({ unconfirmed: 1, failed: 0 });
  });

  it('a person marks it sent (it was in Gmail Sent), and its opens then count', async () => {
    const { campaign, first, attemptedAt } = await interrupted();
    const marked = await controlCampaign(harness.store, org, campaign.id, actor(), 'mark_sent', {
      recipientIds: [first.id],
    });
    expect(marked.ok).toBe(true);
    const row = await harness.store.get('campaign_recipients', org, first.id);
    expect(row).toMatchObject({ status: 'sent', sent_at: attemptedAt, error: null });
    const opened = await recordOpen(
      harness.store,
      { organizationId: org, recipientId: first.id },
      { userAgent: MAIL_APP },
    );
    expect(opened.ok && opened.value).toBe(true);
  });

  it('or sends it again (it was not), as a tap of its own', async () => {
    const { campaign, first } = await interrupted();
    const resent = await controlCampaign(harness.store, org, campaign.id, actor(), 'resend', {
      recipientIds: [first.id],
    });
    expect(resent.ok && resent.value.status).toBe('sending');
    const sender = new DemoCampaignSender();
    await sendBatch(harness.store, org, campaign.id, deps(sender));
    expect(sender.sent.map((e) => e.to)).toEqual([`"${first.name}" <${first.email}>`]);
  });

  it('settles itself when its copy turns up in Sent in the synced mailbox', async () => {
    const { campaign, first, attemptedAt } = await interrupted();
    const at = new Date(Date.parse(attemptedAt) + 2_000).toISOString();
    const thread = '00000000-0000-4000-8000-00000000a0f1';
    await harness.store.insert('email_threads', makeThread('gm-thread-1', thread, at));
    await harness.store.insert(
      'email_messages',
      makeMessage(thread, 'nick@tiptop.demo', '00000000-0000-4000-8000-00000000b0f1', at, {
        to_addresses: [first.email],
        labels: ['SENT'],
        subject: `Q4 for ${first.merge.company ?? 'you'}`,
        provider_message_id: 'gm-msg-1',
      }),
    );
    const checked = await checkReplies(harness.store, org, { campaignId: campaign.id });
    expect(checked.ok && checked.value.settled).toBe(1);
    expect(await harness.store.get('campaign_recipients', org, first.id)).toMatchObject({
      status: 'sent',
      sent_at: at,
      gmail_message_id: 'gm-msg-1',
      gmail_thread_id: 'gm-thread-1',
    });
  });
});

describe('send test to me', () => {
  it('goes to the signed-in person only, marked, through the real links, uncounted', async () => {
    const campaign = await draftWithLps();
    const sender = new DemoCampaignSender();
    const result = await sendTest(harness.store, org, campaign.id, {
      sender,
      storage,
      appUrl: 'https://copilot.example',
      to: 'Arwin@TipTop.example',
      actor: actor(),
    });
    expect(result.ok && result.value.to).toBe('arwin@tiptop.example');
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0]!;
    expect(email.to).toBe('arwin@tiptop.example');
    expect(email.subject).toMatch(/^\[Test\] Q4 for /);
    // The same tracked link the real email carries, on a token that names the campaign.
    const click = /href="https:\/\/copilot\.example\/t\/c\/([^"?]+)\?u=([^"]+)"/.exec(email.html);
    expect(click).toBeTruthy();
    const [, token, encoded] = click as RegExpExecArray;
    expect(readTrackingToken(token)).toBeNull();
    const followed = await resolveTestClick(
      harness.store,
      { organizationId: org, campaignId: campaign.id },
      decodeURIComponent((encoded as string).replace(/&amp;/g, '&')),
    );
    expect(followed.ok && followed.value).toBe(LINK);
    const elsewhere = await resolveTestClick(
      harness.store,
      { organizationId: org, campaignId: campaign.id },
      'https://evil.example/',
    );
    expect(elsewhere.ok).toBe(false);
    expect((await recipients(campaign.id)).every((r) => r.status === 'pending')).toBe(true);
    const still = await harness.store.get('campaigns', org, campaign.id);
    expect(still?.status).toBe('draft');
  });
});

describe('tracking', () => {
  async function sentCampaign() {
    const campaign = await confirm(await draftWithLps());
    await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender()));
    const rows = await recipients(campaign.id);
    return { campaign, rows };
  }
  /** Well after the scan window. */
  const later = (r: CampaignRecipient) => new Date(Date.parse(r.sent_at as string) + 5 * 60_000);

  it('counts opens from the pixel token', async () => {
    const { rows } = await sentCampaign();
    const r = rows[0]!;
    const target = readTrackingToken(trackingToken(org, r.id))!;
    await recordOpen(harness.store, target, { userAgent: MAIL_APP, now: later(r) });
    await recordOpen(harness.store, target, {
      userAgent:
        'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
      now: later(r),
    });
    const row = await harness.store.get('campaign_recipients', org, r.id);
    expect(row?.open_count).toBe(2);
    expect(row?.opened_at).toBeTruthy();
    const events = await harness.store.list('campaign_events', org, {
      eq: { recipient_id: r.id, kind: 'open', automated: false },
    });
    expect(events).toHaveLength(2);
  });

  it('keeps but never counts a machine’s open: on delivery, a prefetch, a scanner', async () => {
    const { rows } = await sentCampaign();
    const r = rows[0]!;
    const target = { organizationId: org, recipientId: r.id };
    const onDelivery = new Date(Date.parse(r.sent_at as string) + 5_000);
    await recordOpen(harness.store, target, { userAgent: MAIL_APP, now: onDelivery });
    await recordOpen(harness.store, target, { userAgent: MAIL_APP, now: later(r), prefetch: true });
    await recordOpen(harness.store, target, { userAgent: 'python-requests/2.31', now: later(r) });
    await recordOpen(harness.store, target, { userAgent: null, now: later(r) });
    const row = await harness.store.get('campaign_recipients', org, r.id);
    expect(row).toMatchObject({ open_count: 0, opened_at: null });
    const kept = await harness.store.list('campaign_events', org, {
      eq: { recipient_id: r.id, automated: true },
    });
    expect(kept).toHaveLength(4);
  });

  it('redirects a click only to a link from the campaign', async () => {
    const { rows } = await sentCampaign();
    const r = rows[1]!;
    const target = { organizationId: org, recipientId: r.id };
    const good = await recordClick(harness.store, target, LINK, {
      userAgent: MAIL_APP,
      now: later(r),
    });
    expect(good.ok && good.value).toBe(LINK);
    const row = await harness.store.get('campaign_recipients', org, r.id);
    // A click is an open even with images off; open_count stays the pixel's.
    expect(row).toMatchObject({ click_count: 1, open_count: 0 });
    expect(row?.clicked_at).toBeTruthy();
    expect(row?.opened_at).toBeTruthy();

    for (const evil of ['https://evil.example/', `${LINK}?x=1`, 'javascript:alert(1)']) {
      const bad = await recordClick(harness.store, target, evil);
      expect(bad.ok).toBe(false);
    }
    // Nobody else's recipient, even in a known organization.
    const unknown = await recordClick(
      harness.store,
      { organizationId: org, recipientId: '00000000-0000-4000-8000-00000000ffff' },
      LINK,
    );
    expect(unknown.ok).toBe(false);
  });

  it('redirects a mail scanner’s click but never counts it', async () => {
    const { rows } = await sentCampaign();
    const r = rows[2]!;
    const target = { organizationId: org, recipientId: r.id };
    const onDelivery = new Date(Date.parse(r.sent_at as string) + 3_000);
    for (const signal of [
      { userAgent: MAIL_APP, now: onDelivery },
      { userAgent: MAIL_APP, now: later(r), head: true },
      { userAgent: 'Mozilla/5.0 (compatible; Barracuda Sentinel)', now: later(r) },
    ]) {
      const followed = await recordClick(harness.store, target, LINK, signal);
      expect(followed.ok && followed.value).toBe(LINK);
    }
    expect(await harness.store.get('campaign_recipients', org, r.id)).toMatchObject({
      click_count: 0,
      clicked_at: null,
      opened_at: null,
    });
  });

  it('undoes clicks once a second link is hit seconds after the first: a scanner walking it', async () => {
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    await addRecipientsFromPaste(harness.store, org, created.value.id, 'ines@lp.example');
    const second = 'https://tiptop.example/memo';
    const draft = await updateCampaign(harness.store, org, created.value.id, {
      subject: 'Two links',
      body_template: `[The letter](${LINK}) and [the memo](${second}).`,
    });
    if (!draft.ok) throw new Error('update');
    const campaign = await confirm(draft.value);
    await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender()));
    const [r] = await recipients(campaign.id);
    const target = { organizationId: org, recipientId: r!.id };
    const t = later(r!);
    await recordClick(harness.store, target, LINK, { userAgent: MAIL_APP, now: t });
    expect((await harness.store.get('campaign_recipients', org, r!.id))?.click_count).toBe(1);
    await recordClick(harness.store, target, second, {
      userAgent: MAIL_APP,
      now: new Date(t.getTime() + 800),
    });
    expect(await harness.store.get('campaign_recipients', org, r!.id)).toMatchObject({
      click_count: 0,
      clicked_at: null,
      opened_at: null,
    });
    // A person clicking later still counts.
    await recordClick(harness.store, target, second, {
      userAgent: MAIL_APP,
      now: new Date(t.getTime() + 60_000),
    });
    expect((await harness.store.get('campaign_recipients', org, r!.id))?.click_count).toBe(1);
  });

  it('suppresses an unsubscribed address in every later campaign', async () => {
    const { rows } = await sentCampaign();
    const desmond = rows.find((r) => r.email === 'desmond@pinecrest-fo.example')!;
    // A draft that already holds Desmond.
    const other = await createCampaign(harness.store, org, actor());
    if (!other.ok) throw new Error('create');
    await addRecipientsFromPaste(harness.store, org, other.value.id, desmond.email);

    const result = await unsubscribe(harness.store, {
      organizationId: org,
      recipientId: desmond.id,
    });
    expect(result.ok && result.value).toEqual({
      email: 'd•••@pinecrest-fo.example',
      already: false,
    });
    const again = await unsubscribe(harness.store, {
      organizationId: org,
      recipientId: desmond.id,
    });
    expect(again.ok && again.value.already).toBe(true);

    // The waiting copy is skipped, and adding him again leaves him out.
    const waiting = await recipients(other.value.id);
    expect(waiting[0]).toMatchObject({ status: 'skipped', error: 'Unsubscribed' });
    const third = await createCampaign(harness.store, org, actor());
    if (!third.ok) throw new Error('create');
    const added = await addRecipientsFromPaste(harness.store, org, third.value.id, desmond.email);
    expect(added.ok && added.value).toMatchObject({ added: 0, unsubscribed: 1 });
  });
});

describe('the unsubscribe list', () => {
  it('lists who is unsubscribed, and a person can put one back or take one off', async () => {
    const listed = await listUnsubscribes(harness.store, org);
    expect(listed.ok && listed.value.map((u) => u.email)).toEqual(['hana@riverlight.example']);
    expect(listed.ok && listed.value[0]).toMatchObject({
      source: 'link',
      campaignName: 'Q3 LP update',
    });

    const back = await resubscribe(harness.store, org, actor(), 'Hana@Riverlight.example');
    expect(back.ok).toBe(true);
    const after = await listUnsubscribes(harness.store, org);
    expect(after.ok && after.value).toEqual([]);
    const created = await createCampaign(harness.store, org, actor());
    if (!created.ok) throw new Error('create');
    const added = await addRecipientsFromPaste(
      harness.store,
      org,
      created.value.id,
      'hana@riverlight.example',
    );
    expect(added.ok && added.value).toMatchObject({ added: 1, unsubscribed: 0 });

    // Someone who replied "please take me off": left out of the waiting draft too.
    const off = await suppressEmail(harness.store, org, actor(), 'hana@riverlight.example');
    expect(off.ok && off.value.already).toBe(false);
    expect((await recipients(created.value.id))[0]).toMatchObject({ status: 'skipped' });
    const now = await listUnsubscribes(harness.store, org);
    expect(now.ok && now.value[0]).toMatchObject({
      email: 'hana@riverlight.example',
      source: 'manual',
    });
    const notOff = await resubscribe(harness.store, org, actor(), 'nobody@lp.example');
    expect(notOff.ok).toBe(false);
  });
});

/* -------------------------------------------------------------- mailbox */

function makeThread(providerId: string, id: string, at: string): EmailThread {
  return {
    id,
    organization_id: org,
    provider: 'google',
    provider_thread_id: providerId,
    subject: 'Re: Q4',
    last_message_at: at,
    message_count: 2,
    created_at: at,
    updated_at: at,
  };
}

function makeMessage(
  threadId: string,
  from: string,
  id: string,
  at: string,
  extra: Partial<EmailMessage> = {},
): EmailMessage {
  return {
    id,
    organization_id: org,
    thread_id: threadId,
    provider: 'google',
    provider_message_id: id,
    subject: 'Re: Q4',
    snippet: 'Thanks',
    from_name: null,
    from_address: from,
    to_addresses: ['nick@tiptop.demo'],
    cc_addresses: [],
    labels: ['INBOX'],
    is_unread: true,
    sent_at: at,
    body_text: null,
    body_fetched_at: null,
    body_hash: null,
    has_attachments: false,
    category: 'unknown',
    category_confidence: null,
    category_source: null,
    importance: null,
    is_ignored: false,
    linked_deal_id: null,
    linked_portfolio_company_id: null,
    injection_flagged: false,
    created_at: at,
    updated_at: at,
    ...extra,
  } as EmailMessage;
}

describe('replies and bounces', () => {
  it('are read from the synced mailbox thread of each sent email', async () => {
    const campaign = await confirm(await draftWithLps());
    await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender()));
    const rows = await recipients(campaign.id);
    const maren = rows.find((r) => r.email.startsWith('maren@'))!;
    const owen = rows.find((r) => r.email.startsWith('owen@'))!;
    const later = new Date(Date.parse(maren.sent_at!) + 60_000).toISOString();

    const t1 = '00000000-0000-4000-8000-00000000a001';
    const t2 = '00000000-0000-4000-8000-00000000a002';
    await harness.store.insert('email_threads', makeThread(maren.gmail_thread_id!, t1, later));
    await harness.store.insert('email_threads', makeThread(owen.gmail_thread_id!, t2, later));
    await harness.store.insert(
      'email_messages',
      makeMessage(t1, maren.email, '00000000-0000-4000-8000-00000000b001', later),
    );
    await harness.store.insert(
      'email_messages',
      makeMessage(
        t2,
        'mailer-daemon@googlemail.com',
        '00000000-0000-4000-8000-00000000b002',
        later,
      ),
    );

    const result = await checkReplies(harness.store, org, { campaignId: campaign.id });
    expect(result.ok && result.value).toMatchObject({ replies: 1, bounces: 1 });
    expect((await harness.store.get('campaign_recipients', org, maren.id))?.replied_at).toBe(later);
    expect((await harness.store.get('campaign_recipients', org, owen.id))?.bounced_at).toBe(later);
    // Checking again finds nothing new.
    const again = await checkReplies(harness.store, org, { campaignId: campaign.id });
    expect(again.ok && again.value.replies + again.value.bounces).toBe(0);
  });

  it('an out-of-office is not a reply; the person’s real answer after it is', async () => {
    const campaign = await confirm(await draftWithLps());
    await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender()));
    const rows = await recipients(campaign.id);
    const maren = rows.find((r) => r.email.startsWith('maren@'))!;
    const lucia = rows.find((r) => r.email.startsWith('lucia'))!;
    const soon = new Date(Date.parse(maren.sent_at!) + 20_000).toISOString();
    const t1 = '00000000-0000-4000-8000-00000000a011';
    const t2 = '00000000-0000-4000-8000-00000000a012';
    await harness.store.insert('email_threads', makeThread(maren.gmail_thread_id!, t1, soon));
    await harness.store.insert('email_threads', makeThread(lucia.gmail_thread_id!, t2, soon));
    await harness.store.insert(
      'email_messages',
      makeMessage(t1, maren.email, '00000000-0000-4000-8000-00000000b011', soon, {
        subject: 'Automatic reply: Q4 for Oakhaven Capital',
        snippet: 'I am out of the office until January 3.',
      }),
    );
    // A vacation responder that keeps "Re:" is caught by its opening line.
    await harness.store.insert(
      'email_messages',
      makeMessage(t2, lucia.email, '00000000-0000-4000-8000-00000000b012', soon, {
        subject: 'Re: Q4 for you',
        snippet: "I'm currently out of office with limited access to email.",
      }),
    );
    const first = await checkReplies(harness.store, org, { campaignId: campaign.id });
    expect(first.ok && first.value).toMatchObject({ replies: 0, autoReplies: 2 });
    expect((await harness.store.get('campaign_recipients', org, maren.id))?.replied_at).toBeNull();

    const real = new Date(Date.parse(maren.sent_at!) + 3 * 86_400_000).toISOString();
    await harness.store.insert(
      'email_messages',
      makeMessage(t1, maren.email, '00000000-0000-4000-8000-00000000b013', real, {
        subject: 'Re: Q4 for Oakhaven Capital',
        snippet: 'Back now. Great quarter, thanks for the update.',
      }),
    );
    const second = await checkReplies(harness.store, org, { campaignId: campaign.id });
    expect(second.ok && second.value.replies).toBe(1);
    expect((await harness.store.get('campaign_recipients', org, maren.id))?.replied_at).toBe(real);
  });
});

describe('attachments', () => {
  it('arrive in pieces and join up when the last one lands', async () => {
    const campaign = await draftWithLps();
    const uploadId = '00000000-0000-4000-8000-0000000c0001';
    const meta = { uploadId, count: 2, name: 'Q4 letter.pdf', type: 'application/pdf', size: 8 };
    const one = await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...meta, index: 0 },
      Buffer.from('%PDF'),
    );
    expect(one.ok && one.value.complete).toBe(false);
    const two = await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...meta, index: 1 },
      Buffer.from('-1.4'),
    );
    expect(two.ok && two.value.complete).toBe(true);
    expect(two.ok && two.value.attachments.map((a) => a.name)).toEqual(['Q4 letter.pdf']);

    // They go out with the email.
    const confirmed = await confirm((await harness.store.get('campaigns', org, campaign.id))!);
    const sender = new DemoCampaignSender();
    await sendBatch(harness.store, org, confirmed.id, deps(sender, { batchMax: 1 }));
    expect(sender.sent[0]?.attachments[0]?.data.toString()).toBe('%PDF-1.4');
  });

  it('refuses blocked types, oversize files and a short upload', async () => {
    const campaign = await draftWithLps();
    const base = { uploadId: '00000000-0000-4000-8000-0000000c0002', index: 0, count: 1 };
    const exe = await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...base, name: 'run.exe', type: 'application/x-msdownload', size: 3 },
      Buffer.from('MZ!'),
    );
    expect(exe.ok).toBe(false);
    const huge = await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...base, name: 'big.pdf', type: 'application/pdf', size: 30 * 1024 * 1024 },
      Buffer.from('x'),
    );
    expect(huge.ok).toBe(false);
    const short = await addAttachmentChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      { ...base, name: 'a.pdf', type: 'application/pdf', size: 99 },
      Buffer.from('abc'),
    );
    expect(short.ok).toBe(false);
    expect((await harness.store.get('campaigns', org, campaign.id))?.attachments).toEqual([]);
  });
});

describe('the list, deleting and tenancy', () => {
  it('lists campaigns with their counts', async () => {
    const result = await listCampaigns(harness.store, org);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const q3 = result.value.find((c) => c.id === DEMO_IDS.campaignQ3Update);
    expect(q3?.counts).toMatchObject({
      total: 8,
      sent: 8,
      opened: 6,
      clicked: 3,
      replied: 2,
      bounced: 1,
    });
  });

  it('deletes only drafts', async () => {
    const sent = await deleteCampaign(
      harness.store,
      storage,
      org,
      DEMO_IDS.campaignQ3Update,
      actor(),
    );
    expect(sent.ok).toBe(false);
    const campaign = await draftWithLps();
    const removed = await deleteCampaign(harness.store, storage, org, campaign.id, actor());
    expect(removed.ok).toBe(true);
    expect(
      await harness.store.count('campaign_recipients', org, { eq: { campaign_id: campaign.id } }),
    ).toBe(0);
  });

  it('keeps one organization out of another', async () => {
    const other = await addSecondOrganization(harness);
    const read = await getCampaign(harness.store, other.organizationId, DEMO_IDS.campaignQ3Update);
    expect(read.ok).toBe(false);
    // A token for this organization's recipient does not open it from the other.
    const opened = await recordOpen(harness.store, {
      organizationId: other.organizationId,
      recipientId: demoCampaignId('recipient', 0),
    });
    expect(opened.ok && opened.value).toBe(false);
  });
});
