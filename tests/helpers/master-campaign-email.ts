import { MAX_ATTACHMENT_BYTES, MAX_RECIPIENTS, formatBytes } from '@/lib/campaigns/limits';
import type { OutgoingCampaignEmail } from '@/lib/campaigns/sender-types';
import {
  escapeHtml,
  mergeFieldsUsed,
  missingMergeFields,
  parseTemplate,
  renderHtml,
  renderSubject,
  renderText,
  subjectIssues,
  type MergeField,
  type ParsedTemplate,
} from '@/lib/campaigns/template';
import { LOCAL_ORIGIN_MESSAGE, type TrackingUrls } from '@/lib/campaigns/tokens';
import { encodeHeaderValue, type MimeAttachment } from '@/lib/google/gmail-send';
import { formatAddress } from '@/lib/services/campaigns';
import type { Campaign, CampaignMerge, CampaignRecipient } from '@/lib/types/domain';
import { htmlToPlainText } from '@/lib/util/text';

/**
 * Frozen copies of the campaign email as it was before photos and copies
 * existed (origin/master 54a12c9): buildCampaignMime from
 * lib/google/gmail-send.ts, and composeCampaignEmail and reviewIssues from
 * lib/services/campaigns.ts, verbatim but for their names. Tests hold the
 * live code to these for a campaign that uses no photo and no copies: same
 * MIME bytes, same email, same review. Do not "fix" these to match the live
 * code; if they disagree, the live code changed behaviour.
 */

export function masterBuildCampaignMime(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MimeAttachment[];
  listUnsubscribe?: string | null;
}): string {
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const alt = `a_${stamp}`;
  const mixed = `m_${stamp}`;
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  const quoted = (v: string) => v.replace(/[\r\n"]+/g, ' ').trim();
  const wrap = (data: Buffer) => (data.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const alternative = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(input.text, 'utf8')),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(input.html, 'utf8')),
    `--${alt}--`,
  ];
  const headers = [
    `From: ${clean(input.from)}`,
    `To: ${clean(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    input.listUnsubscribe ? `List-Unsubscribe: <${clean(input.listUnsubscribe)}>` : '',
    input.listUnsubscribe ? 'List-Unsubscribe-Post: List-Unsubscribe=One-Click' : '',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  if (!input.attachments?.length) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      ...alternative,
      '',
    ].join('\r\n');
  }
  const parts = input.attachments.flatMap((a) => [
    `--${mixed}`,
    `Content-Type: ${quoted(a.mimeType) || 'application/octet-stream'}; name="${quoted(a.filename)}"`,
    `Content-Disposition: attachment; filename="${quoted(a.filename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap(a.data),
  ]);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    ...alternative,
    ...parts,
    `--${mixed}--`,
    '',
  ].join('\r\n');
}

function mergeFor(r: Pick<CampaignRecipient, 'merge' | 'name'>): CampaignMerge {
  return { ...(r.name && !r.merge?.name ? { name: r.name } : {}), ...(r.merge ?? {}) };
}

export function masterComposeCampaignEmail(
  campaign: Pick<Campaign, 'subject' | 'body_template' | 'track_activity' | 'unsubscribe_link'>,
  recipient: Pick<CampaignRecipient, 'email' | 'name' | 'merge'>,
  options: {
    signatureHtml: string;
    urls: TrackingUrls | null;
    parsed?: ParsedTemplate;
    attachments?: OutgoingCampaignEmail['attachments'];
    subjectPrefix?: string;
  },
): OutgoingCampaignEmail {
  const parsed = options.parsed ?? parseTemplate(campaign.body_template);
  const merge = mergeFor(recipient);
  const tracking = campaign.track_activity ? options.urls : null;
  const unsubscribe = campaign.unsubscribe_link ? (options.urls?.unsubscribe ?? null) : null;
  const subject = `${options.subjectPrefix ?? ''}${renderSubject(campaign.subject, merge) || '(no subject)'}`;
  const bodyHtml = renderHtml(parsed.blocks, { merge, trackHref: tracking?.click });
  const bodyText = renderText(parsed.blocks, { merge });
  const footerHtml = unsubscribe
    ? `<div style="margin-top:24px;font-size:12px;color:#888888">If you would rather not get these emails, <a href="${escapeHtml(unsubscribe)}" target="_blank" style="color:#888888">unsubscribe</a>.</div>`
    : '';
  const pixel = tracking
    ? `<img src="${escapeHtml(tracking.open)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    : '';
  const html = `<div dir="ltr">${bodyHtml}<br><div class="gmail_signature">${options.signatureHtml}</div>${footerHtml}${pixel}</div>`;
  const signatureText = htmlToPlainText(options.signatureHtml);
  const text = [
    bodyText,
    signatureText ? `--\n${signatureText}` : '',
    unsubscribe ? `Unsubscribe: ${unsubscribe}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    to: formatAddress(recipient.name, recipient.email),
    subject,
    html,
    text,
    attachments: options.attachments ?? [],
    listUnsubscribe: unsubscribe,
  };
}

const usesAppLinks = (c: Pick<Campaign, 'track_activity' | 'unsubscribe_link'>) =>
  c.track_activity || c.unsubscribe_link;

export function masterReviewIssues(
  campaign: Campaign,
  recipients: readonly CampaignRecipient[],
  options: { appUrl?: string | null } = {},
): {
  recipientCount: number;
  issues: string[];
  fallbacks: { field: MergeField; count: number }[];
  attachmentBytes: number;
} {
  const issues: string[] = [];
  const pending = recipients.filter((r) => r.status === 'pending');
  if (!pending.length) issues.push('Add at least one recipient.');
  if (pending.length > MAX_RECIPIENTS) {
    issues.push(`A campaign can go to ${MAX_RECIPIENTS} people at most.`);
  }
  if (!campaign.subject.trim()) issues.push('Write a subject.');
  issues.push(...subjectIssues(campaign.subject));
  if (!campaign.body_template.trim()) issues.push('Write the email.');
  const parsed = parseTemplate(campaign.body_template);
  issues.push(...parsed.issues);
  const attachmentBytes = campaign.attachments.reduce((sum, a) => sum + a.size, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    issues.push(`Attachments are over ${formatBytes(MAX_ATTACHMENT_BYTES)} together.`);
  }
  if (options.appUrl === null && usesAppLinks(campaign)) issues.push(LOCAL_ORIGIN_MESSAGE);
  const used = mergeFieldsUsed(campaign.subject, campaign.body_template);
  const fallbacks = used
    .map((field) => ({
      field,
      count: pending.filter((r) => missingMergeFields([field], mergeFor(r)).length > 0).length,
    }))
    .filter((f) => f.count > 0);
  return { recipientCount: pending.length, issues, fallbacks, attachmentBytes };
}
