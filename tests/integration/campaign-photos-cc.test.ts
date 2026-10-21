import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoCampaignSender } from '@/lib/campaigns/demo-sender';
import { MAX_ATTACHMENT_BYTES } from '@/lib/campaigns/limits';
import type { OutgoingCampaignEmail } from '@/lib/campaigns/sender-types';
import { trackingUrls } from '@/lib/campaigns/tokens';
import type { DataStore } from '@/lib/db/store';
import { LocalStorageProvider } from '@/lib/storage/provider';
import {
  CAMPAIGN_EXTRAS_MIGRATION_FILE,
  PHOTO_UNREADABLE,
  addAttachmentChunk,
  addPhotoChunk,
  addRecipientsFromPaste,
  assignPhoto,
  campaignManifest,
  checkReplies,
  confirmCampaign,
  controlCampaign,
  createCampaign,
  dailyCapNow,
  deleteCampaign,
  getCampaign,
  listCampaignPhotos,
  matchPhotosByName,
  removePhoto,
  reviewCampaign,
  sendBatch,
  sendTest,
  setRecipientCc,
  updateCampaign,
  updateCampaignCopies,
  type BatchDeps,
} from '@/lib/services/campaigns';
import type { Campaign, CampaignRecipient, EmailMessage, EmailThread } from '@/lib/types/domain';
import { err, type ErrorCode } from '@/lib/util/result';
import { addSecondOrganization, createHarness, type Harness } from '../helpers/harness';
import { masterComposeCampaignEmail } from '../helpers/master-campaign-email';

/**
 * Photos and copies end to end on the demo store, through a sender that
 * sends nothing: the match by file name, the review that blocks on a photo
 * that cannot go, the version every change moves on, the email each person
 * gets (and only theirs), first-only BCC across pauses, the cap counting
 * copies, the test that never copies anyone, and a campaign that uses none of
 * it sending exactly what it always did. Every person here is invented.
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
const APP_URL = 'https://copilot.example';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an invented photo'),
]);
const PEOPLE =
  'Jane Doe <jane@acme.example>\nSam Lee <sam@lee.example>\nWei Chen <wei@harbor.example>';

function deps(sender: DemoCampaignSender, extra: Partial<BatchDeps> = {}): BatchDeps {
  return { sender, storage, appUrl: APP_URL, sleep: async () => {}, intervalMs: 0, ...extra };
}

/**
 * The demo sender (it sends nothing), except that the first email to each
 * listed address comes back with the given error, as Gmail's send path would
 * answer. Keeps every attempt, failed or not, in `attempts`.
 */
class ScriptedSender extends DemoCampaignSender {
  readonly attempts: OutgoingCampaignEmail[] = [];

  constructor(private readonly failFirst: Map<string, { code: ErrorCode; message: string }>) {
    super();
  }

  override async send(email: OutgoingCampaignEmail) {
    this.attempts.push(email);
    for (const [address, failure] of this.failFirst) {
      if (!email.to.toLowerCase().includes(`<${address}>`)) continue;
      this.failFirst.delete(address);
      return err(failure.code, failure.message);
    }
    return super.send(email);
  }
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function draft(people = PEOPLE, store: DataStore = harness.store): Promise<Campaign> {
  const created = must(await createCampaign(store, org, actor(), { name: 'Portraits' }));
  must(await addRecipientsFromPaste(store, org, created.id, people));
  return must(
    await updateCampaign(store, org, created.id, {
      subject: 'Your portrait, {{first_name|friend}}',
      body_template:
        'Hi {{first_name|there}},\n\nHere it is: [the gallery](https://tiptop.example/g).',
    }),
  );
}

async function rows(campaignId: string): Promise<CampaignRecipient[]> {
  return must(await getCampaign(harness.store, org, campaignId)).recipients;
}

const byEmail = async (campaignId: string, email: string) =>
  (await rows(campaignId)).find((r) => r.email === email) as CampaignRecipient;

async function uploadPhoto(campaignId: string, name: string, bytes: Buffer = PNG) {
  return addPhotoChunk(
    harness.store,
    storage,
    org,
    campaignId,
    { uploadId: randomUUID(), index: 0, count: 1, name, type: 'image/png', size: bytes.byteLength },
    bytes,
  );
}

async function expectation(campaignId: string, store: DataStore = harness.store) {
  const review = must(await reviewCampaign(store, org, campaignId));
  return {
    version: review.version,
    recipients: review.recipientCount,
    subject: review.campaign.subject,
    from: review.campaign.from_identity,
    track: review.campaign.track_activity,
    unsubscribe: review.campaign.unsubscribe_link,
  };
}

async function confirm(campaignId: string, store: DataStore = harness.store) {
  return must(
    await confirmCampaign(store, org, campaignId, actor(), await expectation(campaignId, store)),
  );
}

describe('photos', () => {
  it('match by file name as they land; a name that fits nobody or two people waits', async () => {
    const campaign = await draft(`${PEOPLE}\nPat One <pat@one.example>\nPat Two <pat@two.example>`);
    const jane = must(await uploadPhoto(campaign.id, 'Jane Doe.png'));
    expect(jane.complete).toBe(true);
    expect(jane.outcome).toMatchObject({ name: 'Jane Doe.png', matchedTo: 'Jane Doe' });
    const group = must(await uploadPhoto(campaign.id, 'group-shot.png'));
    expect(group.outcome?.matchedTo).toBeNull();
    const pat = must(await uploadPhoto(campaign.id, 'pat.png'));
    expect(pat.outcome?.matchedTo).toBeNull();
    // An address as the name works too.
    const sam = must(await uploadPhoto(campaign.id, 'sam@lee.example.png'));
    expect(sam.outcome?.matchedTo).toBe('Sam Lee');

    expect((await byEmail(campaign.id, 'jane@acme.example')).photo_id).toBe(jane.outcome?.photoId);
    expect((await byEmail(campaign.id, 'pat@one.example')).photo_id ?? null).toBeNull();
    const views = must(await listCampaignPhotos(harness.store, org, campaign.id));
    expect(views.map((v) => [v.name, v.recipients.map((r) => r.label), v.unmatched])).toEqual([
      ['Jane Doe.png', ['Jane Doe'], null],
      ['group-shot.png', [], 'No one on the list has this name or address.'],
      ['pat.png', [], 'Matches 2 people (Pat One, Pat Two), so it was left for you to pick.'],
      ['sam@lee.example.png', ['Sam Lee'], null],
    ]);
    // Stored as an image, typed from its bytes.
    expect(
      (await harness.store.list('campaign_photos', org, { eq: { campaign_id: campaign.id } }))[0]
        ?.type,
    ).toBe('image/png');
  });

  it('never moves a photo someone already has', async () => {
    const campaign = await draft();
    const first = must(await uploadPhoto(campaign.id, 'jane_doe.png'));
    const second = must(await uploadPhoto(campaign.id, 'Jane Doe.png'));
    expect(second.outcome?.matchedTo).toBeNull();
    expect((await byEmail(campaign.id, 'jane@acme.example')).photo_id).toBe(first.outcome?.photoId);
    const views = must(await listCampaignPhotos(harness.store, org, campaign.id));
    expect(views[1]?.unmatched).toBe('Matches Jane Doe, who already has jane_doe.png.');
  });

  it('refuses what is not a photo, an oversize photo, and one no email could carry', async () => {
    const campaign = await draft();
    const pdf = await uploadPhoto(campaign.id, 'notes.pdf', Buffer.from('%PDF-1.4'));
    expect(!pdf.ok && pdf.error.code).toBe('unsupported_media_type');
    const renamed = await uploadPhoto(campaign.id, 'renamed.png', Buffer.from('%PDF-1.4'));
    expect(!renamed.ok && renamed.error.code).toBe('unsupported_media_type');
    const huge = await addPhotoChunk(
      harness.store,
      storage,
      org,
      campaign.id,
      {
        uploadId: randomUUID(),
        index: 0,
        count: 3,
        name: 'huge.png',
        type: '',
        size: 11 * 1024 * 1024,
      },
      PNG,
    );
    expect(!huge.ok && huge.error.code).toBe('too_large');
    // Shared attachments already near the limit: no photo can join them.
    await harness.store.update('campaigns', org, campaign.id, {
      attachments: [
        {
          id: randomUUID(),
          name: 'Deck.pdf',
          type: 'application/pdf',
          size: MAX_ATTACHMENT_BYTES - 10,
          parts: [],
        },
      ],
    });
    const over = await uploadPhoto(campaign.id, 'Jane Doe.png');
    expect(!over.ok && over.error.message).toMatch(/would take an email over 20\.0 MB/);
    expect(await harness.store.count('campaign_photos', org, {})).toBe(0);
  });

  it('a photo arrives in pieces and joins when the last one lands', async () => {
    const campaign = await draft();
    const uploadId = randomUUID();
    const meta = {
      uploadId,
      count: 2,
      name: 'wei chen.png',
      type: 'image/png',
      size: PNG.byteLength,
    };
    const one = must(
      await addPhotoChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        { ...meta, index: 0 },
        PNG.subarray(0, 10),
      ),
    );
    expect(one).toEqual({ complete: false });
    const two = must(
      await addPhotoChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        { ...meta, index: 1 },
        PNG.subarray(10),
      ),
    );
    expect(two.outcome?.matchedTo).toBe('Wei Chen');
  });

  it('an upload can never write over a photo or an attachment already there', async () => {
    const campaign = await draft();
    const attachmentId = randomUUID();
    must(
      await addAttachmentChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        { uploadId: attachmentId, index: 0, count: 1, name: 'Letter.pdf', type: '', size: 8 },
        Buffer.from('%PDF-1.4'),
      ),
    );
    const jane = must(await uploadPhoto(campaign.id, 'Jane Doe.png')).outcome!.photoId;
    const [photo] = await harness.store.list('campaign_photos', org, { eq: { id: jane } });
    const [attachment] = must(await getCampaign(harness.store, org, campaign.id)).campaign
      .attachments;
    const other = Buffer.concat([PNG, Buffer.from(' but another one')]);
    const version = must(await reviewCampaign(harness.store, org, campaign.id)).version;

    // The same id again, as a first piece of two or a whole file: refused
    // before anything is written, and the photo's pieces are untouched.
    for (const count of [2, 1]) {
      const again = await addPhotoChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        { uploadId: jane, index: 0, count, name: 'Jane Doe.png', type: 'image/png', size: 40 },
        other,
      );
      expect(!again.ok && again.error.code).toBe('invalid_input');
    }
    const kept = await storage.get(photo!.parts[0]!);
    expect(kept.ok && Buffer.from(kept.value).equals(PNG)).toBe(true);

    // A photo upload named with an attachment's id lands in the photos'
    // own folder, never on the attachment's pieces.
    const odd = must(
      await addPhotoChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        {
          uploadId: attachmentId,
          index: 0,
          count: 1,
          name: 'Sam Lee.png',
          type: 'image/png',
          size: other.byteLength,
        },
        other,
      ),
    );
    expect(odd.complete).toBe(true);
    const letter = await storage.get(attachment!.parts[0]!);
    expect(letter.ok && Buffer.from(letter.value).toString()).toBe('%PDF-1.4');
    // Only the photo that did join moved the version.
    expect(must(await reviewCampaign(harness.store, org, campaign.id)).version).not.toBe(version);
    expect(await harness.store.count('campaign_photos', org, {})).toBe(2);
  });

  it('can be given out by hand, changed, cleared and removed', async () => {
    const campaign = await draft();
    const group = must(await uploadPhoto(campaign.id, 'group-shot.png')).outcome!.photoId;
    const sam = await byEmail(campaign.id, 'sam@lee.example');
    const given = must(
      await assignPhoto(harness.store, org, campaign.id, { recipientId: sam.id, photoId: group }),
    );
    expect(given[0]?.recipients.map((r) => r.label)).toEqual(['Sam Lee']);
    expect((await byEmail(campaign.id, 'sam@lee.example')).photo_id).toBe(group);
    must(
      await assignPhoto(harness.store, org, campaign.id, { recipientId: sam.id, photoId: null }),
    );
    expect((await byEmail(campaign.id, 'sam@lee.example')).photo_id).toBeNull();

    must(
      await assignPhoto(harness.store, org, campaign.id, { recipientId: sam.id, photoId: group }),
    );
    const [photo] = await harness.store.list('campaign_photos', org, { eq: { id: group } });
    expect((await storage.get(photo!.parts[0]!)).ok).toBe(true);
    expect(must(await removePhoto(harness.store, storage, org, campaign.id, group))).toEqual([]);
    expect((await byEmail(campaign.id, 'sam@lee.example')).photo_id).toBeNull();
    expect((await storage.get(photo!.parts[0]!)).ok).toBe(false);
  });

  it('match by file name again picks up people added after their photo', async () => {
    const campaign = await draft('Jane Doe <jane@acme.example>');
    must(await uploadPhoto(campaign.id, 'Wei Chen.png'));
    must(
      await addRecipientsFromPaste(
        harness.store,
        org,
        campaign.id,
        'Wei Chen <wei@harbor.example>',
      ),
    );
    const again = must(await matchPhotosByName(harness.store, org, campaign.id));
    expect(again.matched).toBe(1);
    expect(again.photos[0]?.recipients.map((r) => r.label)).toEqual(['Wei Chen']);
  });
});

describe('review and confirmation', () => {
  it('every change to photos or copies makes an earlier review stale', async () => {
    const campaign = await draft();
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    let photoId = '';
    const changes: [string, () => Promise<unknown>][] = [
      [
        'upload',
        async () => (photoId = must(await uploadPhoto(campaign.id, 'group.png')).outcome!.photoId),
      ],
      [
        'assign',
        () => assignPhoto(harness.store, org, campaign.id, { recipientId: jane.id, photoId }),
      ],
      [
        'clear',
        () => assignPhoto(harness.store, org, campaign.id, { recipientId: jane.id, photoId: null }),
      ],
      ['remove', () => removePhoto(harness.store, storage, org, campaign.id, photoId)],
      [
        'cc',
        () => updateCampaignCopies(harness.store, org, campaign.id, { cc: 'partner@fund.example' }),
      ],
      [
        'bcc',
        () =>
          updateCampaignCopies(harness.store, org, campaign.id, { bcc: 'archive@fund.example' }),
      ],
      ['mode', () => updateCampaignCopies(harness.store, org, campaign.id, { bccMode: 'first' })],
      [
        'own cc',
        () =>
          setRecipientCc(harness.store, org, campaign.id, {
            recipientId: jane.id,
            cc: 'pa@acme.example',
          }),
      ],
    ];
    for (const [what, change] of changes) {
      const seen = await expectation(campaign.id);
      const result = (await change()) as { ok?: boolean } | string;
      if (typeof result === 'object') expect(result.ok, what).toBe(true);
      const stale = await confirmCampaign(harness.store, org, campaign.id, actor(), seen);
      expect(stale.ok, what).toBe(false);
      expect(!stale.ok && stale.error.code, what).toBe('conflict');
    }
    expect((await harness.store.get('campaigns', org, campaign.id))?.status).toBe('draft');
    // Reviewed again, it goes.
    expect((await confirm(campaign.id)).status).toBe('sending');
  });

  it('a photo that cannot go blocks the send, naming the person', async () => {
    const campaign = await draft();
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    await harness.store.update('campaign_recipients', org, jane.id, { photo_id: randomUUID() });
    const review = must(await reviewCampaign(harness.store, org, campaign.id));
    expect(review.issues).toContain('Photo missing for Jane Doe: pick it again or clear it.');
    const refused = await confirmCampaign(
      harness.store,
      org,
      campaign.id,
      actor(),
      await expectation(campaign.id),
    );
    expect(!refused.ok && refused.error.message).toBe(
      'Photo missing for Jane Doe: pick it again or clear it.',
    );
  });

  it('shared attachments added after a photo cannot push that email over the limit', async () => {
    const campaign = await draft();
    must(await uploadPhoto(campaign.id, 'Sam Lee.png'));
    // A big shared file lands afterwards: fine for everyone but Sam.
    await harness.store.update('campaigns', org, campaign.id, {
      attachments: [
        {
          id: randomUUID(),
          name: 'Deck.pdf',
          type: 'application/pdf',
          size: MAX_ATTACHMENT_BYTES - 5,
          parts: [],
        },
      ],
    });
    const review = must(await reviewCampaign(harness.store, org, campaign.id));
    expect(review.issues).toEqual([
      'The photo for Sam Lee is too big to send (a photo can be 10.0 MB, and an email 20.0 MB with its attachments): use a smaller photo or fewer attachments.',
    ]);
    const manifest = must(await campaignManifest(harness.store, org, campaign.id));
    expect(manifest.check.rows.map((r) => [r.to, r.flags.map((f) => f.text)])).toEqual([
      ['jane@acme.example', []],
      ['sam@lee.example', ['Photo too big to send']],
      ['wei@harbor.example', []],
    ]);
    // And giving that photo to someone else is refused at once.
    const wei = await byEmail(campaign.id, 'wei@harbor.example');
    const [photo] = await harness.store.list('campaign_photos', org, {});
    const assign = await assignPhoto(harness.store, org, campaign.id, {
      recipientId: wei.id,
      photoId: photo!.id,
    });
    expect(!assign.ok && assign.error.code).toBe('too_large');
  });

  it('an unsubscribed copy blocks; a copy who is also a recipient only warns', async () => {
    const campaign = await draft();
    // hana@riverlight.example unsubscribed from the Q3 update in the fixtures.
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        cc: 'hana@riverlight.example, sam@lee.example',
      }),
    );
    const blocked = must(await reviewCampaign(harness.store, org, campaign.id));
    expect(blocked.issues).toEqual([
      'hana@riverlight.example unsubscribed, so it cannot be copied: take it off CC.',
    ]);
    must(await updateCampaignCopies(harness.store, org, campaign.id, { cc: 'sam@lee.example' }));
    const warned = must(await reviewCampaign(harness.store, org, campaign.id));
    expect(warned.issues).toEqual([]);
    expect(warned.extras?.warnings[0]).toMatch(
      /^sam@lee\.example is on CC and on the recipient list/,
    );
    // Three emails, each copied to sam@ except Sam's own.
    expect(warned.extras?.effectiveTotal).toBe(5);
  });

  it('copies are checked as addresses, ten at most, and never the recipient themselves', async () => {
    const campaign = await draft();
    const bad = await updateCampaignCopies(harness.store, org, campaign.id, {
      cc: 'ok@fund.example bob',
    });
    expect(!bad.ok && bad.error.message).toBe('CC: Not an email address: bob');
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@fund.example`).join(',');
    expect((await updateCampaignCopies(harness.store, org, campaign.id, { bcc: many })).ok).toBe(
      false,
    );
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    const self = await setRecipientCc(harness.store, org, campaign.id, {
      recipientId: jane.id,
      cc: 'JANE@acme.example',
    });
    expect(self.ok).toBe(false);
    const saved = must(
      await updateCampaignCopies(harness.store, org, campaign.id, { cc: 'Partner@Fund.example' }),
    );
    expect(saved.cc).toEqual(['partner@fund.example']);
  });

  it('a campaign that uses neither has the review it always had', async () => {
    const campaign = await draft();
    const review = must(await reviewCampaign(harness.store, org, campaign.id));
    expect('extras' in review).toBe(false);
    expect(review.issues).toEqual([]);
  });
});

describe('sending with photos and copies', () => {
  async function withSharedPdf(campaignId: string) {
    must(
      await addAttachmentChunk(
        harness.store,
        storage,
        org,
        campaignId,
        {
          uploadId: randomUUID(),
          index: 0,
          count: 1,
          name: 'Letter.pdf',
          type: 'application/pdf',
          size: 8,
        },
        Buffer.from('%PDF-1.4'),
      ),
    );
  }

  it('a photo goes on its person’s email only; everyone else gets the email they always would', async () => {
    const campaign = await draft();
    await withSharedPdf(campaign.id);
    must(await uploadPhoto(campaign.id, 'Jane Doe.png'));
    const confirmed = await confirm(campaign.id);
    const sender = new DemoCampaignSender();
    expect(must(await sendBatch(harness.store, org, confirmed.id, deps(sender))).state).toBe(
      'done',
    );
    const sent = new Map(sender.sent.map((e) => [e.to, e]));
    const jane = sent.get('"Jane Doe" <jane@acme.example>')!;
    expect(jane.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ['Letter.pdf', 'application/pdf'],
      ['Jane Doe.png', 'image/png'],
    ]);
    expect(jane.attachments[1]?.data.equals(PNG)).toBe(true);
    const signatureHtml = (await sender.signature('nick')) as string;
    for (const r of await rows(confirmed.id)) {
      if (r.email === 'jane@acme.example') continue;
      const email = sent.get(`"${r.name}" <${r.email}>`)!;
      expect(email).toStrictEqual(
        masterComposeCampaignEmail(confirmed, r, {
          signatureHtml,
          urls: trackingUrls(APP_URL, { organizationId: org, recipientId: r.id }),
          attachments: [
            { filename: 'Letter.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
          ],
        }),
      );
    }
  });

  it('CC on every email, a person’s own CC on theirs, BCC on every email, To one person', async () => {
    const campaign = await draft();
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        cc: 'partner@fund.example',
        bcc: 'archive@fund.example',
      }),
    );
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    must(
      await setRecipientCc(harness.store, org, campaign.id, {
        recipientId: jane.id,
        cc: 'pa@acme.example',
      }),
    );
    await confirm(campaign.id);
    const sender = new DemoCampaignSender();
    must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
    expect(sender.sent.map((e) => [e.to, e.cc, e.bcc])).toEqual([
      [
        '"Jane Doe" <jane@acme.example>',
        ['partner@fund.example', 'pa@acme.example'],
        ['archive@fund.example'],
      ],
      ['"Sam Lee" <sam@lee.example>', ['partner@fund.example'], ['archive@fund.example']],
      ['"Wei Chen" <wei@harbor.example>', ['partner@fund.example'], ['archive@fund.example']],
    ]);
    // Nobody's address is in anybody else's To, and no copy is named in a body.
    for (const e of sender.sent) {
      expect(e.to.match(/@/g)).toHaveLength(1);
      expect(e.html).not.toContain('archive@fund.example');
      expect(e.text).not.toContain('archive@fund.example');
    }
    expect((await rows(campaign.id)).map((r) => r.copy_count)).toEqual([3, 2, 2]);
    // The cap counts every copy: 3 emails + 7 copies.
    expect(must(await dailyCapNow(harness.store, org)).used).toBe(10);
  });

  it('first-only BCC goes once, with the first email, and never again after a pause and resume', async () => {
    const campaign = await draft();
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        bcc: 'archive@fund.example',
        bccMode: 'first',
      }),
    );
    await confirm(campaign.id);
    const sender = new DemoCampaignSender();
    must(await sendBatch(harness.store, org, campaign.id, deps(sender, { batchMax: 1 })));
    expect(sender.sent.map((e) => e.bcc)).toEqual([['archive@fund.example']]);
    expect((await harness.store.get('campaigns', org, campaign.id))?.bcc_sample_at).toBeTruthy();
    must(await controlCampaign(harness.store, org, campaign.id, actor(), 'pause'));
    must(await controlCampaign(harness.store, org, campaign.id, actor(), 'resume'));
    must(await sendBatch(harness.store, org, campaign.id, deps(sender, { batchMax: 1 })));
    must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
    expect(sender.sent).toHaveLength(3);
    expect(sender.sent.map((e) => 'bcc' in e)).toEqual([true, false, false]);
  });

  /** A first-only BCC campaign whose first email is to first@try.example, then Jane, Sam and Wei. */
  async function firstOnlyWithFirstTry() {
    const campaign = await draft(`First Try <first@try.example>\n${PEOPLE}`);
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        bcc: 'archive@fund.example',
        bccMode: 'first',
      }),
    );
    await confirm(campaign.id);
    return campaign;
  }
  const sampleAt = async (campaignId: string) =>
    (await harness.store.get('campaigns', org, campaignId))?.bcc_sample_at ?? null;
  const carriers = (sender: ScriptedSender) =>
    sender.attempts.filter((e) => e.bcc?.length).map((e) => e.to);

  for (const [what, code, message] of [
    [
      'Gmail answered with a server error',
      'provider_unavailable',
      'Gmail is unavailable right now. Try again.',
    ],
    ['the connection dropped mid-request', 'provider_unavailable', 'Could not reach Gmail.'],
    ['the request timed out', 'timeout', 'Gmail took too long to answer.'],
  ] as const) {
    it(`when ${what}, the email may have gone, so the sample stays used: no later email, nor its retry, carries a second`, async () => {
      const campaign = await firstOnlyWithFirstTry();
      const sender = new ScriptedSender(new Map([['first@try.example', { code, message }]]));
      must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
      expect(await byEmail(campaign.id, 'first@try.example')).toMatchObject({
        status: 'failed',
        error: message,
      });
      const claimed = await sampleAt(campaign.id);
      expect(claimed).toBeTruthy();
      expect(carriers(sender)).toEqual(['"First Try" <first@try.example>']);
      expect(sender.sent.map((e) => 'bcc' in e)).toEqual([false, false, false]);

      // Retrying the failed one sends it again, without the sample.
      must(await controlCampaign(harness.store, org, campaign.id, actor(), 'retry_failed'));
      must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
      expect((await byEmail(campaign.id, 'first@try.example')).status).toBe('sent');
      expect(sender.attempts).toHaveLength(5);
      expect('bcc' in (sender.attempts[4] as OutgoingCampaignEmail)).toBe(false);
      expect(carriers(sender)).toHaveLength(1);
      expect(await sampleAt(campaign.id)).toBe(claimed);
    });
  }

  for (const [code, message] of [
    ['provider_unauthorized', 'Gmail refused. Sending may need to be turned on again.'],
    ['forbidden', 'Sending is not turned on for this mailbox.'],
  ] as const) {
    it(`a refusal that certainly sent nothing (${code}) gives the sample back for the next email`, async () => {
      const campaign = await firstOnlyWithFirstTry();
      const sender = new ScriptedSender(new Map([['first@try.example', { code, message }]]));
      const first = must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
      expect(first).toMatchObject({ state: 'paused', pauseReason: 'refused' });
      expect(await sampleAt(campaign.id)).toBeNull();
      expect(sender.sent).toHaveLength(0);

      must(await controlCampaign(harness.store, org, campaign.id, actor(), 'resume'));
      must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
      expect(sender.sent.map((e) => e.bcc ?? null)).toEqual([['archive@fund.example'], null, null]);
      expect(await sampleAt(campaign.id)).toBeTruthy();
      must(await controlCampaign(harness.store, org, campaign.id, actor(), 'retry_failed'));
      must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
      expect((await byEmail(campaign.id, 'first@try.example')).status).toBe('sent');
      // The refused attempt carried it but went nowhere; Jane's is the one sample sent.
      expect(sender.sent.filter((e) => e.bcc?.length).map((e) => e.to)).toEqual([
        '"Jane Doe" <jane@acme.example>',
      ]);
    });
  }

  it('a photo that cannot be read fails that email with a reason, and the rest still go', async () => {
    const campaign = await draft();
    must(await uploadPhoto(campaign.id, 'Sam Lee.png'));
    await confirm(campaign.id);
    const [photo] = await harness.store.list('campaign_photos', org, {});
    must(await storage.remove(photo!.parts[0]!));
    const sender = new DemoCampaignSender();
    const progress = must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
    expect(progress).toMatchObject({ state: 'done', sentNow: 2, failedNow: 1 });
    const sam = await byEmail(campaign.id, 'sam@lee.example');
    expect(sam).toMatchObject({ status: 'failed', error: PHOTO_UNREADABLE, attempted_at: null });
    expect(PHOTO_UNREADABLE).toBe('Photo could not be read, so this email was not sent.');
    // Never sent without it.
    expect(sender.sent.some((e) => e.to.includes('sam@lee.example'))).toBe(false);
  });

  it('photo failures in a row pause the campaign, as any failures in a row do', async () => {
    const campaign = await draft();
    for (const name of ['Jane Doe.png', 'Sam Lee.png', 'Wei Chen.png']) {
      must(await uploadPhoto(campaign.id, name));
    }
    await confirm(campaign.id);
    for (const p of await harness.store.list('campaign_photos', org, {})) {
      must(await storage.remove(p.parts[0]!));
    }
    const sender = new DemoCampaignSender();
    const progress = must(await sendBatch(harness.store, org, campaign.id, deps(sender)));
    expect(progress).toMatchObject({ state: 'paused', pauseReason: 'failures', failedNow: 3 });
    expect(sender.sent).toHaveLength(0);
  });

  it('the daily cap counts every copy, and pauses before an email whose copies would cross it', async () => {
    const campaign = await draft();
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, { cc: 'partner@fund.example' }),
    );
    await confirm(campaign.id);
    const sender = new DemoCampaignSender();
    const progress = must(
      await sendBatch(harness.store, org, campaign.id, deps(sender, { dailyCap: 5 })),
    );
    // Two emails with one copy each is 4; the third would make 6.
    expect(sender.sent).toHaveLength(2);
    expect(progress).toMatchObject({ state: 'capped', status: 'paused', pauseReason: 'capped' });
    expect(progress.message).toMatch(/counting every CC and BCC copy/);
  });

  it('a test renders as the chosen recipient with their photo, and is never copied to anyone', async () => {
    const campaign = await draft();
    must(await uploadPhoto(campaign.id, 'Jane Doe.png'));
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        cc: 'partner@fund.example',
        bcc: 'archive@fund.example',
        bccMode: 'first',
      }),
    );
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    must(
      await setRecipientCc(harness.store, org, campaign.id, {
        recipientId: jane.id,
        cc: 'pa@acme.example',
      }),
    );
    const sender = new DemoCampaignSender();
    const result = must(
      await sendTest(harness.store, org, campaign.id, {
        sender,
        storage,
        appUrl: APP_URL,
        to: 'me@tiptop.example',
        actor: actor(),
        recipientId: jane.id,
      }),
    );
    expect(result).toEqual({
      to: 'me@tiptop.example',
      as: 'jane@acme.example',
      photo: 'Jane Doe.png',
      wouldCc: ['partner@fund.example', 'pa@acme.example'],
      wouldBcc: ['archive@fund.example'],
      bccMode: 'first',
    });
    expect(sender.sent).toHaveLength(1);
    const email = sender.sent[0]!;
    expect(email.to).toBe('me@tiptop.example');
    expect('cc' in email || 'bcc' in email).toBe(false);
    expect(email.subject).toBe('[Test] Your portrait, Jane');
    expect(email.attachments.map((a) => a.filename)).toEqual(['Jane Doe.png']);
    // Nothing was claimed or counted.
    expect(
      (await harness.store.get('campaigns', org, campaign.id))?.bcc_sample_at ?? null,
    ).toBeNull();
  });
});

/* The synced mailbox: a sent email's Gmail thread, and what lands in it after the send. */

type Landed = Pick<EmailMessage, 'from_address'> &
  Partial<Pick<EmailMessage, 'subject' | 'snippet' | 'body_text'>>;

/** Each message lands a minute after the one before, the first a minute after the send. */
async function landInThread(r: CampaignRecipient, messages: Landed[]): Promise<string[]> {
  const threadId = randomUUID();
  const times = messages.map((_, i) =>
    new Date(Date.parse(r.sent_at as string) + (i + 1) * 60_000).toISOString(),
  );
  const last = times.at(-1) as string;
  const thread: EmailThread = {
    id: threadId,
    organization_id: org,
    provider: 'google',
    provider_thread_id: r.gmail_thread_id as string,
    subject: 'Your portrait',
    last_message_at: last,
    message_count: messages.length + 1,
    created_at: last,
    updated_at: last,
  };
  await harness.store.insert('email_threads', thread);
  for (const [i, m] of messages.entries()) {
    const at = times[i] as string;
    await harness.store.insert('email_messages', {
      id: randomUUID(),
      organization_id: org,
      thread_id: threadId,
      provider: 'google',
      provider_message_id: randomUUID(),
      subject: 'Re: Your portrait',
      snippet: '',
      from_name: null,
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
      ...m,
    } as EmailMessage);
  }
  return times;
}

/** Gmail's own bounce, quoting the returned message's headers (which name everyone on it). */
function gmailBounce(failed: string, original: { to: string; cc?: string }): Landed {
  return {
    from_address: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    snippet: `Address not found Your message wasn&#39;t delivered to ${failed} because the address couldn&#39;t be found, or is unable to receive mail.`,
    body_text: [
      '** Address not found **',
      '',
      `Your message wasn't delivered to ${failed} because the address couldn't be found, or is unable to receive mail.`,
      '',
      'The response was: 550 5.1.1 The email account that you tried to reach does not exist.',
      '',
      '----- Original message -----',
      '',
      'From: nick@tiptop.demo',
      `To: ${original.to}`,
      ...(original.cc ? [`Cc: ${original.cc}`] : []),
      'Subject: Your portrait',
    ].join('\n'),
  };
}

/** A delivery report (RFC 3464) from another mail server: its Final-Recipient says who failed. */
function deliveryReport(finalRecipient: string, words: string): Landed {
  return {
    from_address: 'MAILER-DAEMON@mx.harbor.example',
    subject: 'Undelivered Mail Returned to Sender',
    snippet: 'This is the mail system at host mx.harbor.example. I am sorry to have to inform you',
    body_text: [
      'This is the mail system at host mx.harbor.example.',
      '',
      words,
      '',
      'Reporting-MTA: dns; mx.harbor.example',
      `Final-Recipient: rfc822; ${finalRecipient}`,
      `Original-Recipient: rfc822;${finalRecipient}`,
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    ].join('\n'),
  };
}

/** A mail server's message that names nobody: a bounce, but of whom it does not say. */
const namelessBounce: Landed = {
  from_address: 'postmaster@mail.example',
  subject: 'Delivery incomplete',
  snippet: 'There was a problem delivering your message. See the technical details below.',
};

describe('bounces when an email went with copies', () => {
  it('count against the recipient only when they name the recipient’s own address', async () => {
    const campaign = await draft();
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, { cc: 'partner@fund.example' }),
    );
    await confirm(campaign.id);
    must(await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender())));
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    const sam = await byEmail(campaign.id, 'sam@lee.example');
    const wei = await byEmail(campaign.id, 'wei@harbor.example');
    expect([jane, sam, wei].map((r) => r.copy_count)).toEqual([1, 1, 1]);

    // Jane's address bounced (named in another case: still hers).
    const [janeBounced] = await landInThread(jane, [
      gmailBounce('Jane@Acme.example', { to: jane.email, cc: 'partner@fund.example' }),
    ]);
    // Only Sam's copy bounced, twice over: Gmail's bounce names the copy (the
    // quoted headers name Sam too, as the original's To), and a delivery
    // report's Final-Recipient is the copy though its words mention Sam. Then
    // Sam replies, and that is still read.
    const [, , samReplied] = await landInThread(sam, [
      gmailBounce('partner@fund.example', { to: sam.email, cc: 'partner@fund.example' }),
      deliveryReport(
        'partner@fund.example',
        `Your message to ${sam.email} could not be delivered to one of its recipients.`,
      ),
      { from_address: sam.email, snippet: 'Love it, thank you!' },
    ]);
    // Wei's address bounced, as the delivery report's own field says.
    const [weiBounced] = await landInThread(wei, [
      deliveryReport('WEI@harbor.example', '<wei@harbor.example>: 550 5.1.1 User unknown'),
    ]);

    const checked = must(await checkReplies(harness.store, org, { campaignId: campaign.id }));
    expect(checked).toMatchObject({ bounces: 2, replies: 1 });
    expect((await byEmail(campaign.id, jane.email)).bounced_at).toBe(janeBounced);
    expect((await byEmail(campaign.id, wei.email)).bounced_at).toBe(weiBounced);
    expect(await byEmail(campaign.id, sam.email)).toMatchObject({
      bounced_at: null,
      replied_at: samReplied,
      status: 'sent',
    });
  });

  it('a bounce naming nobody marks no email that carried the first-only sample; the rest keep the rule they always had', async () => {
    const campaign = await draft();
    must(
      await updateCampaignCopies(harness.store, org, campaign.id, {
        bcc: 'archive@fund.example',
        bccMode: 'first',
      }),
    );
    await confirm(campaign.id);
    // A clock that moves a second per reading, so each step of the send has its own time.
    let tick = Date.now();
    const now = () => new Date((tick += 1000));
    must(await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender(), { now })));
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    const sam = await byEmail(campaign.id, 'sam@lee.example');
    const wei = await byEmail(campaign.id, 'wei@harbor.example');
    expect([jane.copy_count, sam.copy_count, wei.copy_count]).toEqual([1, undefined, undefined]);

    // Jane's email carried the sample: the BCC's bounce, and one that names
    // nobody, are not hers to count.
    await landInThread(jane, [
      gmailBounce('archive@fund.example', { to: jane.email }),
      namelessBounce,
    ]);
    // Sam's and Wei's carried no copy: any mail server's message is their
    // bounce, whoever it names, exactly as before copies existed.
    const [samBounced] = await landInThread(sam, [namelessBounce]);
    const [weiBounced] = await landInThread(wei, [
      gmailBounce('archive@fund.example', { to: wei.email }),
    ]);

    const checked = must(await checkReplies(harness.store, org, { campaignId: campaign.id }));
    expect(checked.bounces).toBe(2);
    expect((await byEmail(campaign.id, jane.email)).bounced_at).toBeNull();
    expect((await byEmail(campaign.id, sam.email)).bounced_at).toBe(samBounced);
    expect((await byEmail(campaign.id, wei.email)).bounced_at).toBe(weiBounced);

    // The sample's email settled from Sent after an interruption has no
    // copy_count; it is still known by the claim made just after its attempt.
    await harness.store.update('campaign_recipients', org, jane.id, { copy_count: 0 });
    const again = must(await checkReplies(harness.store, org, { campaignId: campaign.id }));
    expect(again.bounces).toBe(0);
    expect((await byEmail(campaign.id, jane.email)).bounced_at).toBeNull();
  });
});

describe('a campaign that uses no photo and no copies', () => {
  it('reads bounces exactly as before: any mail server’s message in the thread, whoever it names', async () => {
    const campaign = await draft();
    await confirm(campaign.id);
    must(await sendBatch(harness.store, org, campaign.id, deps(new DemoCampaignSender())));
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    const sam = await byEmail(campaign.id, 'sam@lee.example');
    const wei = await byEmail(campaign.id, 'wei@harbor.example');
    const [janeBounced] = await landInThread(jane, [namelessBounce]);
    const [samBounced] = await landInThread(sam, [
      deliveryReport('someone@elsewhere.example', 'Delivery to someone@elsewhere.example failed.'),
    ]);
    const [weiReplied] = await landInThread(wei, [
      { from_address: wei.email, snippet: 'Got it, thanks.' },
    ]);
    const checked = must(await checkReplies(harness.store, org, { campaignId: campaign.id }));
    expect(checked).toMatchObject({ bounces: 2, replies: 1 });
    expect((await byEmail(campaign.id, jane.email)).bounced_at).toBe(janeBounced);
    expect((await byEmail(campaign.id, sam.email)).bounced_at).toBe(samBounced);
    expect((await byEmail(campaign.id, wei.email)).replied_at).toBe(weiReplied);
  });

  it('sends exactly the emails it always did, and writes nothing new', async () => {
    const campaign = await draft();
    must(
      await addAttachmentChunk(
        harness.store,
        storage,
        org,
        campaign.id,
        {
          uploadId: randomUUID(),
          index: 0,
          count: 1,
          name: 'Letter.pdf',
          type: 'application/pdf',
          size: 8,
        },
        Buffer.from('%PDF-1.4'),
      ),
    );
    const confirmed = await confirm(campaign.id);
    const sender = new DemoCampaignSender();
    must(await sendBatch(harness.store, org, confirmed.id, deps(sender)));
    const signatureHtml = (await sender.signature('nick')) as string;
    const sentRows = [...(await rows(confirmed.id))].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
    expect(sender.sent).toStrictEqual(
      sentRows.map((r) =>
        masterComposeCampaignEmail(confirmed, r, {
          signatureHtml,
          urls: trackingUrls(APP_URL, { organizationId: org, recipientId: r.id }),
          attachments: [
            { filename: 'Letter.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
          ],
        }),
      ),
    );
    for (const r of sentRows) {
      expect(r.status).toBe('sent');
      expect('copy_count' in r || 'photo_id' in r || 'cc' in r).toBe(false);
    }
    const after = (await harness.store.get('campaigns', org, confirmed.id)) as Campaign;
    expect('bcc_sample_at' in after || 'cc' in after || 'bcc' in after).toBe(false);
    expect(must(await dailyCapNow(harness.store, org)).used).toBe(3);
  });
});

/**
 * The store as Supabase answers before 20261021001100 is applied: rows come
 * back without the new columns, campaign_photos does not exist, and a write
 * naming a new column is refused.
 */
function storeWithoutExtras(target: DataStore): DataStore {
  const NEW = new Set(['cc', 'bcc', 'bcc_mode', 'bcc_sample_at', 'photo_id', 'copy_count']);
  const strip = (row: unknown) => {
    if (!row || typeof row !== 'object') return row;
    return Object.fromEntries(Object.entries(row).filter(([k]) => !NEW.has(k)));
  };
  const missingTable = () =>
    Object.assign(new Error('Could not find the table public.campaign_photos'), {
      code: 'PGRST205',
    });
  const missingColumn = () =>
    Object.assign(new Error("Could not find the 'cc' column"), { code: 'PGRST204' });
  const writes = new Set(['insert', 'insertMany', 'update', 'updateWhere', 'upsert']);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'kind') return 'supabase';
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (args[0] === 'campaign_photos') throw missingTable();
        if (writes.has(String(prop))) {
          const payload = JSON.stringify(args.slice(1));
          if ([...NEW].some((k) => payload.includes(`"${k}":`))) throw missingColumn();
        }
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
        return Array.isArray(out) ? out.map(strip) : strip(out);
      };
    },
  });
}

describe('before the photos and copies migration is applied', () => {
  it('campaigns review, confirm and send exactly as before, and photos and copies stay hidden', async () => {
    const store = storeWithoutExtras(harness.store);
    const campaign = await draft(PEOPLE, store);
    const review = must(await reviewCampaign(store, org, campaign.id));
    expect(review.issues).toEqual([]);
    expect('extras' in review).toBe(false);
    await confirm(campaign.id, store);
    const sender = new DemoCampaignSender();
    expect(must(await sendBatch(store, org, campaign.id, deps(sender))).state).toBe('done');
    expect(sender.sent).toHaveLength(3);
    expect(sender.sent.every((e) => !('cc' in e) && !('bcc' in e))).toBe(true);

    const other = await draft(PEOPLE, store);
    const recipient = (
      await store.list('campaign_recipients', org, { eq: { campaign_id: other.id } })
    )[0]!;
    for (const attempt of [
      uploadPhotoVia(store, other.id),
      updateCampaignCopies(store, org, other.id, { cc: 'partner@fund.example' }),
      setRecipientCc(store, org, other.id, { recipientId: recipient.id, cc: 'pa@acme.example' }),
      assignPhoto(store, org, other.id, { recipientId: recipient.id, photoId: null }),
      matchPhotosByName(store, org, other.id),
    ]) {
      const result = await attempt;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('not_configured');
      expect(!result.ok && result.error.message).toContain(CAMPAIGN_EXTRAS_MIGRATION_FILE);
    }
    expect(must(await listCampaignPhotos(store, org, other.id))).toEqual([]);
    const manifest = must(await campaignManifest(store, org, other.id));
    expect(manifest.extras).toBe(false);
    expect(manifest.check.rows).toHaveLength(3);
    expect(must(await deleteCampaign(store, storage, org, other.id, actor()))).toBe(true);
  });

  function uploadPhotoVia(store: DataStore, campaignId: string) {
    return addPhotoChunk(
      store,
      storage,
      org,
      campaignId,
      {
        uploadId: randomUUID(),
        index: 0,
        count: 1,
        name: 'Jane Doe.png',
        type: 'image/png',
        size: PNG.byteLength,
      },
      PNG,
    );
  }
});

describe('deleting and tenancy', () => {
  it('deleting a draft takes its photos and their pieces with it', async () => {
    const campaign = await draft();
    must(await uploadPhoto(campaign.id, 'Jane Doe.png'));
    const [photo] = await harness.store.list('campaign_photos', org, {});
    must(await deleteCampaign(harness.store, storage, org, campaign.id, actor()));
    expect(await harness.store.count('campaign_photos', org, {})).toBe(0);
    expect((await storage.get(photo!.parts[0]!)).ok).toBe(false);
  });

  it('another organization can neither read nor change a campaign’s photos and copies', async () => {
    const campaign = await draft();
    const photoId = must(await uploadPhoto(campaign.id, 'Jane Doe.png')).outcome!.photoId;
    const jane = await byEmail(campaign.id, 'jane@acme.example');
    const other = await addSecondOrganization(harness);
    const otherOrg = other.organizationId;
    expect(
      (await assignPhoto(harness.store, otherOrg, campaign.id, { recipientId: jane.id, photoId }))
        .ok,
    ).toBe(false);
    expect((await removePhoto(harness.store, storage, otherOrg, campaign.id, photoId)).ok).toBe(
      false,
    );
    expect(
      (await updateCampaignCopies(harness.store, otherOrg, campaign.id, { cc: 'x@y.example' })).ok,
    ).toBe(false);
    expect((await campaignManifest(harness.store, otherOrg, campaign.id)).ok).toBe(false);
    expect((await byEmail(campaign.id, 'jane@acme.example')).photo_id).toBe(photoId);
  });
});
