import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { cleanCopyList } from '@/lib/campaigns/copies';
import { PHASE_LABEL, campaignPhase } from '@/lib/campaigns/status';
import { statusFieldOf } from '@/lib/crm/fields';
import { getStore } from '@/lib/runtime';
import {
  CAMPAIGNS_MIGRATION_FILE,
  checkReplies,
  copySettingsOf,
  dailyCapNow,
  extrasAvailable,
  getCampaign,
  isCampaignsNotSetUp,
  listCampaignPhotos,
  recipientState,
} from '@/lib/services/campaigns';
import { isCrmNotSetUp, listCrmLists } from '@/lib/services/crm';
import { FUND_II_TABS } from '@/lib/records-tabs';
import { tabHref } from '@/lib/util/page-tabs';
import { formatDateTime } from '@/lib/util/time';
import { DEFAULT_MAILBOX } from '@/lib/services/task-close';
import type { CampaignRecipient } from '@/lib/types/domain';
import { CampaignComposer, type ListOption } from '@/components/campaigns/campaign-composer';
import { PHASE_TONE } from '@/components/campaigns/campaign-list';
import { CampaignProgress } from '@/components/campaigns/campaign-progress';
import { CampaignReport, type ReportRow } from '@/components/campaigns/campaign-report';
import { DeleteDraftButton } from '@/components/campaigns/delete-draft-button';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';

export const metadata: Metadata = { title: 'Campaign' };
export const dynamic = 'force-dynamic';

const CAMPAIGNS_HREF = tabHref(FUND_II_TABS.path, 'campaigns', FUND_II_TABS.defaultKey);

function lastActivity(r: CampaignRecipient): string | null {
  const times = [r.replied_at, r.clicked_at, r.opened_at, r.bounced_at, r.sent_at].filter(
    (t): t is string => Boolean(t),
  );
  return times.sort().at(-1) ?? null;
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAuth();
  const store = getStore();

  // Replies first, so the report is current when it renders. Reads only.
  await checkReplies(store, auth.organizationId, { campaignId: id });
  const detail = await getCampaign(store, auth.organizationId, id);

  const back = (
    <Link
      href={CAMPAIGNS_HREF}
      // `dark`: it sits on the page header's band, like the email session's back link.
      className="dark mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Campaigns
    </Link>
  );

  if (isCampaignsNotSetUp(detail)) {
    return (
      <PageShell>
        {back}
        <NotConfigured
          title="Campaigns are not set up yet"
          description={`The campaign tables have not been created in the database. Run ${CAMPAIGNS_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
          stillWorks="Everything else in Copilot works as before."
          action={null}
        />
      </PageShell>
    );
  }
  if (!detail.ok && detail.error.code === 'not_found') notFound();
  if (!detail.ok) {
    return (
      <PageShell>
        {back}
        <ErrorState title="This campaign could not be loaded" message={detail.error.message} />
      </PageShell>
    );
  }

  const { campaign, recipients, counts } = detail.value;
  // An event message (Events → Messages, D-075) leads back to its event.
  const eventBack = campaign.event_id ? (
    <Link
      href={`/events/${encodeURIComponent(campaign.event_id)}?tab=messages`}
      className="dark mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Event messages
    </Link>
  ) : null;
  const eyebrow = campaign.event_id ? 'Event message · Campaign' : 'Fund II · Campaign';
  const tz = auth.profile.timezone;

  if (campaign.status === 'draft') {
    const listsResult = await listCrmLists(store, auth.organizationId);
    const lists: ListOption[] = listsResult.ok
      ? listsResult.value.map((l) => ({
          id: l.id,
          name: l.name,
          entityType: l.entity_type,
          entryCount: l.entry_count,
          statusOptions: statusFieldOf(l)?.options ?? [],
        }))
      : [];
    const listsNote = isCrmNotSetUp(listsResult)
      ? 'Lists are not set up yet, so paste addresses instead.'
      : listsResult.ok
        ? null
        : 'Lists could not be read just now. Paste addresses, or reload.';
    // Photos and copies only once their migration is applied (and readable):
    // otherwise the composer shows exactly what it showed before them.
    const photosResult = extrasAvailable(store, campaign)
      ? await listCampaignPhotos(store, auth.organizationId, campaign.id)
      : null;
    const photos = photosResult?.ok ? photosResult.value : null;
    const photoNames = new Map((photos ?? []).map((p) => [p.id, p.name] as const));
    const copies = copySettingsOf(campaign);
    return (
      <PageShell>
        {eventBack ?? back}
        <PageHeader
          eyebrow={eyebrow}
          title={campaign.name}
          subtitle="One personal email per person from your mailbox, with replies tracked (and, if you like, opens and clicks). Nothing is sent until you review it and tap Send."
          actions={<DeleteDraftButton campaignId={campaign.id} />}
        />
        <CampaignComposer
          campaign={{
            id: campaign.id,
            name: campaign.name,
            subject: campaign.subject,
            body_template: campaign.body_template,
            from_identity: campaign.from_identity,
            attachments: campaign.attachments,
            track_activity: campaign.track_activity,
            unsubscribe_link: campaign.unsubscribe_link,
          }}
          recipients={recipients.map((r) => ({
            id: r.id,
            email: r.email,
            name: r.name,
            merge: r.merge,
            ...(photos
              ? {
                  photoId: r.photo_id ?? null,
                  photoName: r.photo_id ? (photoNames.get(r.photo_id) ?? null) : null,
                  cc: cleanCopyList(r.cc),
                }
              : {}),
          }))}
          lists={lists}
          listsNote={listsNote}
          me={auth.profile.email}
          timezone={tz}
          extras={
            photos
              ? {
                  photos,
                  copies: { cc: copies.cc, bcc: copies.bcc, bccMode: copies.bccMode },
                  sharedBytes: campaign.attachments.reduce((sum, a) => sum + a.size, 0),
                }
              : null
          }
        />
      </PageShell>
    );
  }

  const rows: ReportRow[] = recipients.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    state: recipientState(r),
    openCount: r.open_count,
    clickCount: r.click_count,
    lastAt: lastActivity(r),
    error:
      r.status === 'failed' || r.status === 'skipped' || r.status === 'unconfirmed'
        ? r.error
        : null,
    replyThreadId: r.gmail_thread_id,
  }));
  const when = campaign.sent_at ?? campaign.confirmed_at;
  const phase = campaignPhase(campaign);
  const cap = phase === 'capped' ? await dailyCapNow(store, auth.organizationId) : null;
  const showProgress =
    campaign.status === 'sending' ||
    campaign.status === 'paused' ||
    counts.failed > 0 ||
    counts.unconfirmed > 0;
  // The receipt is for a send that is over: finished, or cancelled after some
  // went out. A paused one can still resume, so its live card says where it is.
  const now = new Date().toISOString();
  const receipt =
    campaign.status === 'sent'
      ? { variant: 'sent' as const, at: campaign.sent_at ?? campaign.last_sent_at, now }
      : campaign.status === 'cancelled' && counts.sent > 0
        ? { variant: 'stopped' as const, at: campaign.last_sent_at, now }
        : null;

  return (
    <PageShell>
      {eventBack ?? back}
      <PageHeader
        eyebrow={eyebrow}
        title={campaign.name}
        subtitle={`${campaign.subject}${when ? ` · ${campaign.status === 'sent' ? 'sent' : 'started'} ${formatDateTime(when, tz)}` : ''}`}
        meta={<Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>}
      />
      <CampaignReport
        counts={counts}
        rows={rows}
        timezone={tz}
        mailbox={DEFAULT_MAILBOX}
        tracking={campaign.track_activity}
        receipt={receipt}
        progress={
          showProgress ? (
            <CampaignProgress
              campaignId={campaign.id}
              initialStatus={campaign.status}
              initialPauseReason={campaign.pause_reason}
              initialStalled={phase === 'stalled'}
              initialCapResetsAt={cap?.ok ? cap.value.resetsAt : null}
              timezone={tz}
              unconfirmedRecipients={recipients
                .filter((r) => r.status === 'unconfirmed')
                .map((r) => ({ id: r.id, name: r.name, email: r.email }))}
              initialCounts={{
                total: counts.total,
                pending: counts.pending,
                sent: counts.sent,
                failed: counts.failed,
                unconfirmed: counts.unconfirmed,
                skipped: counts.skipped,
                bounced: counts.bounced,
              }}
            />
          ) : null
        }
      />
    </PageShell>
  );
}
