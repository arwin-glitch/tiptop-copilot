import type { CampaignBccMode } from '@/lib/types/domain';
import { cleanBccMode, cleanCopyList, copiesFor } from './copies';
import { MAX_ATTACHMENT_BYTES, formatBytes } from './limits';
import { MAX_PHOTO_BYTES } from './photos';

/**
 * "Who gets what": every pending recipient's email as it would go out (To,
 * their photo, the shared attachments, CC and BCC), what is wrong with any of
 * them, and the totals. Pure, and the single source for three readers: the
 * review's blocking issues, the confirmation (which re-runs the review), and
 * the manifest a person reads before tapping Send.
 *
 * A campaign that uses no photo and no copies comes out with no issues and no
 * warnings at all, so its review is exactly what it was before photos and
 * copies existed.
 */

export interface ManifestCampaign {
  cc?: unknown;
  bcc?: unknown;
  bcc_mode?: unknown;
  bcc_sample_at?: string | null;
  attachments: readonly { name: string; size: number }[];
}

export interface ManifestRecipient {
  id: string;
  email: string;
  name: string | null;
  photo_id?: string | null;
  cc?: unknown;
  created_at: string;
}

export interface ManifestPhoto {
  id: string;
  name: string;
  size: number;
  parts: readonly string[];
}

export interface ManifestFlag {
  /** 'block' stops the send until fixed; 'warn' is for the person to know. */
  level: 'block' | 'warn';
  text: string;
}

export interface ManifestRow {
  id: string;
  to: string;
  name: string | null;
  /** The photo on this email; null for none (or one that cannot be found: see flags). */
  photo: { id: string; name: string; size: number } | null;
  attachments: string[];
  /** Everyone copied, as the Cc header will read: the campaign's CC, then theirs. */
  cc: string[];
  /** The part of `cc` that is this person's own. */
  personalCc: string[];
  bcc: string[];
  /**
   * The campaign's one "first email only" BCC copy is expected on this email:
   * the first in send order that can carry it. The send puts it on the first
   * email that actually goes out, so a skip or a failure before this one moves
   * it on; the label says so rather than promising this row.
   */
  bccSample: boolean;
  /** Attachment bytes on this email: the shared ones plus the photo. */
  bytes: number;
  flags: ManifestFlag[];
}

export interface ManifestSummary {
  recipients: number;
  withPhoto: number;
  withoutPhoto: number;
  /** Recipients whose email has a problem that stops the send. */
  problems: number;
  cc: string[];
  bcc: string[];
  bccMode: CampaignBccMode;
  /** The first-only BCC copy was already claimed by an earlier email, so no row carries it. */
  bccSampleUsed: boolean;
  /** People with their own CC. */
  personalCc: number;
  /** Photos in the campaign's set that nobody pending is getting. */
  unmatchedPhotos: number;
  /** Emails plus every CC and BCC copy: what this send counts toward the daily cap. */
  effectiveTotal: number;
}

export interface ExtrasCheck {
  rows: ManifestRow[];
  summary: ManifestSummary;
  /** Problems that stop the send, each naming who it is about. */
  issues: string[];
  /** Worth knowing; nothing stops. */
  warnings: string[];
}

/** "Jane Doe, Sam Lee and 3 more". */
function who(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

const label = (r: Pick<ManifestRecipient, 'name' | 'email'>) => r.name?.trim() || r.email;

/** Send order: the order batches take recipients in (created, then id). */
export function sendOrder<T extends Pick<ManifestRecipient, 'id' | 'created_at'>>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function checkExtras(input: {
  campaign: ManifestCampaign;
  /** The recipients still to be sent to. */
  pending: readonly ManifestRecipient[];
  /** The campaign's photo set, by id. */
  photos: ReadonlyMap<string, ManifestPhoto>;
  /** Of every address copied anywhere, those currently unsubscribed. */
  suppressed: ReadonlySet<string>;
}): ExtrasCheck {
  const { campaign, photos, suppressed } = input;
  const campaignCc = cleanCopyList(campaign.cc);
  const bcc = cleanCopyList(campaign.bcc);
  const bccMode = cleanBccMode(campaign.bcc_mode);
  const bccSampleUsed = bccMode === 'first' && Boolean(campaign.bcc_sample_at);
  const sharedBytes = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
  const attachments = campaign.attachments.map((a) => a.name);
  const ordered = sendOrder(input.pending);
  const recipientEmails = new Set(ordered.map((r) => r.email.toLowerCase()));

  const missing: string[] = [];
  const incomplete: string[] = [];
  const oversize: string[] = [];
  const personalSuppressed: string[] = [];
  const personalOverlap: string[] = [];
  const assigned = new Set<string>();
  // The first-only copy goes with the first email that can carry it (one to
  // somebody other than the BCC address itself), as sendBatch does.
  let sampleOpen = bccMode === 'first' && !bccSampleUsed;

  const rows: ManifestRow[] = ordered.map((r) => {
    const flags: ManifestFlag[] = [];
    const personalCc = cleanCopyList(r.cc);
    let photo: ManifestRow['photo'] = null;
    if (r.photo_id) {
      assigned.add(r.photo_id);
      const found = photos.get(r.photo_id);
      if (!found) {
        missing.push(label(r));
        flags.push({ level: 'block', text: 'Photo missing' });
      } else {
        photo = { id: found.id, name: found.name, size: found.size };
        if (!found.parts.length || found.size <= 0) {
          incomplete.push(label(r));
          flags.push({ level: 'block', text: 'Photo did not upload properly' });
        } else if (
          found.size > MAX_PHOTO_BYTES ||
          sharedBytes + found.size > MAX_ATTACHMENT_BYTES
        ) {
          oversize.push(label(r));
          flags.push({ level: 'block', text: 'Photo too big to send' });
        }
      }
    }
    const copies = copiesFor(r.email, {
      campaignCc,
      personalCc,
      bcc: bccMode === 'every' || sampleOpen ? bcc : [],
    });
    if (bccMode === 'first' && copies.bcc.length) sampleOpen = false;
    const own = personalCc.filter((e) => copies.cc.includes(e));
    const ownSuppressed = own.filter((e) => suppressed.has(e));
    if (ownSuppressed.length) {
      personalSuppressed.push(label(r));
      flags.push({ level: 'block', text: `Unsubscribed on CC: ${ownSuppressed.join(', ')}` });
    }
    const ownOverlap = own.filter((e) => recipientEmails.has(e) && !suppressed.has(e));
    if (ownOverlap.length) {
      personalOverlap.push(label(r));
      flags.push({ level: 'warn', text: `Also a recipient: ${ownOverlap.join(', ')}` });
    }
    return {
      id: r.id,
      to: r.email,
      name: r.name,
      photo,
      attachments,
      cc: copies.cc,
      personalCc: own,
      bcc: copies.bcc,
      bccSample: bccMode === 'first' && copies.bcc.length > 0,
      bytes: sharedBytes + (photo?.size ?? 0),
      flags,
    };
  });

  const issues: string[] = [];
  if (missing.length) {
    issues.push(`Photo missing for ${who(missing)}: pick it again or clear it.`);
  }
  if (incomplete.length) {
    issues.push(`The photo for ${who(incomplete)} did not upload properly: upload it again.`);
  }
  if (oversize.length) {
    issues.push(
      `The photo for ${who(oversize)} is too big to send (a photo can be ${formatBytes(MAX_PHOTO_BYTES)}, and an email ${formatBytes(MAX_ATTACHMENT_BYTES)} with its attachments): use a smaller photo or fewer attachments.`,
    );
  }
  for (const [list, name] of [
    [campaignCc, 'CC'],
    [bcc, 'BCC'],
  ] as const) {
    const off = list.filter((e) => suppressed.has(e));
    if (off.length) {
      issues.push(
        `${who(off)} unsubscribed, so ${off.length === 1 ? 'it' : 'they'} cannot be copied: take ${off.length === 1 ? 'it' : 'them'} off ${name}.`,
      );
    }
  }
  if (personalSuppressed.length) {
    issues.push(
      `An unsubscribed address is on the CC of ${who(personalSuppressed)}: take it off their CC.`,
    );
  }

  const warnings: string[] = [];
  for (const [list, name] of [
    [campaignCc, 'CC'],
    [bcc, 'BCC'],
  ] as const) {
    const both = list.filter((e) => recipientEmails.has(e) && !suppressed.has(e));
    if (!both.length) continue;
    const copyOf =
      name === 'BCC' && bccMode === 'first' ? 'the first email' : "everyone else's email";
    warnings.push(
      `${who(both)} ${both.length === 1 ? 'is' : 'are'} on ${name} and on the recipient list: ${both.length === 1 ? 'they get their' : 'each gets their'} own email and a copy of ${copyOf}.`,
    );
  }
  if (personalOverlap.length) {
    warnings.push(
      `The CC of ${who(personalOverlap)} names someone who is also a recipient: they get a copy of that email as well as their own.`,
    );
  }
  const unmatchedPhotos = [...photos.keys()].filter((id) => !assigned.has(id)).length;
  if (unmatchedPhotos) {
    warnings.push(
      `${unmatchedPhotos} ${unmatchedPhotos === 1 ? 'photo is' : 'photos are'} not given to anyone, so ${unmatchedPhotos === 1 ? 'it goes' : 'they go'} nowhere.`,
    );
  }

  const withPhoto = rows.filter((r) => r.photo).length;
  return {
    rows,
    issues,
    warnings,
    summary: {
      recipients: rows.length,
      withPhoto,
      withoutPhoto: rows.length - withPhoto,
      problems: rows.filter((r) => r.flags.some((f) => f.level === 'block')).length,
      cc: campaignCc,
      bcc,
      bccMode,
      bccSampleUsed,
      personalCc: rows.filter((r) => r.personalCc.length).length,
      unmatchedPhotos,
      effectiveTotal: rows.reduce((sum, r) => sum + 1 + r.cc.length + r.bcc.length, 0),
    },
  };
}

/** What a row marks as carrying the first-only BCC sample: where it is expected, not promised. */
export const BCC_SAMPLE_MARK =
  'BCC sample: goes on the first email actually sent (normally this one)';

/** How the summary line says where a BCC goes. */
function bccWhere(s: ManifestSummary): string {
  if (s.bccMode !== 'first') return 'every email';
  return s.bccSampleUsed
    ? 'one sample, already used by an earlier email'
    : 'one sample, on the first email that actually goes out';
}

/** The summary as one line: what the top of "Who gets what" says. */
export function describeManifest(s: ManifestSummary): string {
  const parts = [
    `${s.withPhoto} with photo, ${s.withoutPhoto} without, ${s.problems} ${s.problems === 1 ? 'problem' : 'problems'}`,
    `CC: ${s.cc.length ? s.cc.join(', ') : 'none'}`,
    `BCC: ${s.bcc.length ? `${s.bcc.join(', ')} (${bccWhere(s)})` : 'none'}`,
    `${s.personalCc} ${s.personalCc === 1 ? 'person has' : 'people have'} their own CC`,
  ];
  return parts.join('; ');
}

/**
 * The manifest as spreadsheet rows, header first, for "Download CSV".
 * Without photos and copies set up (`extras` false), their columns are left
 * out, as they are on the page.
 */
export function manifestTable(rows: readonly ManifestRow[], extras = true): string[][] {
  const flags = (r: ManifestRow) =>
    r.flags.map((f) => `${f.level === 'block' ? 'Problem' : 'Note'}: ${f.text}`).join('; ');
  if (!extras) {
    return [
      ['To', 'Name', 'Shared attachments', 'Flags'],
      ...rows.map((r) => [r.to, r.name ?? '', r.attachments.join('; '), flags(r)]),
    ];
  }
  return [
    ['To', 'Name', 'Photo', 'Shared attachments', 'CC', 'BCC', 'Flags'],
    ...rows.map((r) => [
      r.to,
      r.name ?? '',
      r.photo?.name ?? 'none',
      r.attachments.join('; '),
      r.cc.join('; '),
      r.bcc.length ? `${r.bcc.join('; ')}${r.bccSample ? ` (${BCC_SAMPLE_MARK})` : ''}` : '',
      flags(r),
    ]),
  ];
}
