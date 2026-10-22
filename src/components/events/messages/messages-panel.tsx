import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import { filterChipClassName } from '@/components/ui/toolbar';
import { PHASE_TONE } from '@/components/campaigns/campaign-list';
import { campaignHref } from '@/components/events/events-client';
import { DraftButton } from '@/components/events/messages/draft-button';
import { MessageComposer } from '@/components/events/messages/message-composer';
import { ReminderSchedule } from '@/components/events/messages/reminder-schedule';
import { PHASE_LABEL, campaignPhase } from '@/lib/campaigns/status';
import type { EventPanelProps } from '@/lib/events/contracts';
import { NOTIFY_LABELS, formatMoment, type Funnel } from '@/lib/events/tab-view';
import { getStore } from '@/lib/runtime';
import { eventMessagesView, type EventMessagesView } from '@/lib/services/event-comms';
import type { EventCampaignKind } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';
import { formatDate } from '@/lib/util/time';

export const MESSAGE_VIEWS = ['drafts', 'notify', 'reminders', 'funnel'] as const;
export type MessageView = (typeof MESSAGE_VIEWS)[number];

const KIND_LABEL: Record<EventCampaignKind, string> = {
  invite: 'Invite',
  reminder: 'Reminder',
  notice: 'Notice',
  update: 'Update',
  cancellation: 'Cancellation',
  blast: 'Message',
  nudge: 'Nudge',
};

/**
 * Messages: every email to this event's guests, each one a campaign draft a
 * person reviews and sends in the campaign review (Fund II → Campaigns uses
 * the same one). One screen at a time: the composer on top, then one of four
 * views: drafts and sends, the "Needs notifying" queue, reminders, and the
 * invite funnel. Nothing on this tab sends anything.
 */
export async function MessagesPanel({
  event,
  sessions,
  viewer,
  view,
}: EventPanelProps & { view: MessageView }) {
  const data = await eventMessagesView(getStore(), viewer.organizationId, event, sessions);
  if (data.notSetUp) {
    return (
      <NotConfigured
        title="Event messages are not set up yet"
        description={data.notSetUp}
        stillWorks="The guest list, the page and the rest of Events work as before."
        action={null}
      />
    );
  }
  const notifyCount = data.queue.reduce((sum, g) => sum + g.open.length, 0);
  const href = (v: MessageView) =>
    `/events/${event.id}?tab=messages${v === 'drafts' ? '' : `&view=${v}`}`;
  const views: { key: MessageView; label: string; count?: number }[] = [
    { key: 'drafts', label: 'Drafts and sent', count: data.campaigns.length },
    { key: 'notify', label: 'Needs notifying', count: notifyCount },
    { key: 'reminders', label: 'Reminders', count: data.remindersReady || undefined },
    { key: 'funnel', label: 'Invite funnel' },
  ];
  const sessionsLite = sessions.map((s) => ({ id: s.id, name: s.name }));

  return (
    <div data-panel="messages" className="space-y-5">
      {data.cancellationFor !== null ? (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              This event is cancelled. Let {data.cancellationFor}{' '}
              {data.cancellationFor === 1 ? 'guest' : 'guests'} know.
            </p>
            <DraftButton eventId={event.id} body={{ kind: 'cancellation' }}>
              Draft the cancellation notice
            </DraftButton>
          </div>
        </Notice>
      ) : null}
      {data.updateFor !== null ? (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              The time or place changed. Draft an update to {data.updateFor} going{' '}
              {data.updateFor === 1 ? 'guest' : 'guests'}; their calendar file updates too.
            </p>
            <DraftButton eventId={event.id} body={{ kind: 'update' }}>
              Draft the update
            </DraftButton>
          </div>
        </Notice>
      ) : null}

      <Card aria-labelledby="messages-new-title">
        <CardHeader>
          <div>
            <CardTitle as="h2" id="messages-new-title">
              New message
            </CardTitle>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              Every email starts as a draft. Nothing goes until you tap Send in the review.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <MessageComposer
            eventId={event.id}
            audience={data.audience}
            sessions={sessionsLite}
            defaultSender={data.sender}
          />
        </CardContent>
      </Card>

      <nav aria-label="Message views" className="flex flex-wrap gap-1.5">
        {views.map((v) => (
          <Link
            key={v.key}
            href={href(v.key)}
            scroll={false}
            aria-current={v.key === view ? 'page' : undefined}
            className={filterChipClassName(v.key === view)}
          >
            {v.label}
            {v.count !== undefined ? (
              <span className="tabular ml-1.5 text-[var(--fg-subtle)]">{v.count}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      {view === 'notify' ? (
        <NotifyView eventId={event.id} data={data} />
      ) : view === 'reminders' ? (
        <RemindersView
          eventId={event.id}
          data={data}
          timeZone={event.time_zone}
          live={event.status === 'published'}
        />
      ) : view === 'funnel' ? (
        <FunnelView eventId={event.id} funnel={data.funnel} />
      ) : (
        <DraftsView data={data} timeZone={viewer.timeZone} />
      )}
    </div>
  );
}

function DraftsView({ data, timeZone }: { data: EventMessagesView; timeZone: string }) {
  if (!data.campaigns.length) {
    return (
      <EmptyState
        title="No messages yet"
        description="Draft the invite above. Reminders, notices and updates show here too, each one waiting for your review."
      />
    );
  }
  return (
    <ul aria-label="Drafts and sent messages" className="space-y-2">
      {data.campaigns.map((c) => {
        const phase = campaignPhase(c.campaign);
        const draft = c.status === 'draft';
        return (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {c.kind ? <Badge tone="accent">{KIND_LABEL[c.kind]}</Badge> : null}
                <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>
              </div>
              <p className="mt-1 truncate text-sm font-medium">{c.name}</p>
              <p className="text-xs text-[var(--fg-muted)]">
                {[
                  c.audienceLabel,
                  `${c.recipients} ${c.recipients === 1 ? 'recipient' : 'recipients'}`,
                  c.sent ? `${c.sent} sent · ${c.opened} opened · ${c.replied} replied` : null,
                  c.sentAt
                    ? `sent ${formatDate(c.sentAt, timeZone)}`
                    : `drafted ${formatDate(c.createdAt, timeZone)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <Button asChild size="sm" variant={draft ? 'primary' : 'secondary'}>
              <Link href={campaignHref(c.id)}>
                {draft ? 'Review and send' : 'Open report'}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function NotifyView({ eventId, data }: { eventId: string; data: EventMessagesView }) {
  if (!data.queue.length) {
    return (
      <EmptyState
        title="Everyone is up to date"
        description="When you approve, decline or promote someone, or a new registration comes in, they wait here until a message tells them."
      />
    );
  }
  return (
    <ul aria-label="Needs notifying" className="space-y-2">
      {data.queue.map((group) => (
        <li
          key={group.kind}
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{NOTIFY_LABELS[group.kind].title}</p>
            <p className="text-xs text-[var(--fg-muted)]">
              {group.open.length
                ? `${group.open.length} ${group.open.length === 1 ? 'guest has' : 'guests have'} not been told yet.`
                : 'A draft covers everyone here.'}
              {group.draft ? ` A draft for ${group.draft.count} is waiting.` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {group.draft ? (
              <Button asChild size="sm" variant="primary">
                <Link href={campaignHref(group.draft.campaignId)}>Review and send</Link>
              </Button>
            ) : null}
            {group.open.length ? (
              <DraftButton eventId={eventId} body={{ kind: 'notice', notifyKind: group.kind }}>
                {NOTIFY_LABELS[group.kind].draft}
              </DraftButton>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

const REMINDER_STATE: Record<string, { label: string; tone: 'neutral' | 'warn' | 'ok' | 'info' }> =
  {
    scheduled: { label: 'Scheduled', tone: 'neutral' },
    due: { label: 'Due now', tone: 'warn' },
    drafted: { label: 'Draft ready', tone: 'info' },
    sent: { label: 'Sent', tone: 'ok' },
  };

function RemindersView({
  eventId,
  data,
  timeZone,
  live,
}: {
  eventId: string;
  data: EventMessagesView;
  timeZone: string;
  live: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card aria-labelledby="reminders-schedule-title">
        <CardHeader>
          <div>
            <CardTitle as="h2" id="reminders-schedule-title">
              Schedule
            </CardTitle>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              Before each session, to going guests. When one is due, Today and your alerts say so.
              It is never sent for you.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <ReminderSchedule eventId={eventId} offsets={data.reminderOffsets} />
        </CardContent>
      </Card>
      <section aria-labelledby="reminders-list-title">
        <h2 id="reminders-list-title" className="mb-2 text-base font-semibold">
          Coming up
        </h2>
        {!live ? (
          <p className="text-sm text-[var(--fg-muted)]">
            Reminders start once the page is published.
          </p>
        ) : !data.reminders.length ? (
          <p className="text-sm text-[var(--fg-muted)]">
            No reminders left to send: the sessions have started or none are scheduled.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.reminders.map((slot) => {
              const state = REMINDER_STATE[slot.state] ?? REMINDER_STATE.scheduled!;
              return (
                <li
                  key={slot.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={state.tone}>{state.label}</Badge>
                      <span className="text-sm font-medium">{slot.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                      {slot.sessionName} · due {formatMoment(slot.dueAt, timeZone)}
                    </p>
                  </div>
                  {slot.campaignId ? (
                    <Button
                      asChild
                      size="sm"
                      variant={slot.state === 'drafted' ? 'primary' : 'secondary'}
                    >
                      <Link href={campaignHref(slot.campaignId)}>
                        {slot.state === 'drafted' ? 'Review and send' : 'Open report'}
                      </Link>
                    </Button>
                  ) : (
                    <DraftButton
                      eventId={eventId}
                      variant={slot.state === 'due' ? 'primary' : 'secondary'}
                      body={{
                        kind: 'reminder',
                        sessionId: slot.sessionId,
                        offsetMinutes: slot.offsetMinutes,
                      }}
                    >
                      {slot.state === 'due' ? 'Draft it now' : 'Prepare the draft'}
                    </DraftButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function FunnelView({ eventId, funnel }: { eventId: string; funnel: Funnel }) {
  if (!funnel.invited) {
    return (
      <EmptyState
        title="No invites sent yet"
        description="Once an invite goes out, this shows who got it, opened it, looked at the page, answered and is coming."
      />
    );
  }
  const steps: { label: string; value: number }[] = [
    { label: 'Invited', value: funnel.invited },
    { label: 'Delivered', value: funnel.delivered },
    { label: 'Opened', value: funnel.opened },
    { label: 'Viewed the page', value: funnel.viewed },
    { label: 'Answered', value: funnel.responded },
    { label: 'Going', value: funnel.going },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card aria-labelledby="funnel-title">
        <CardHeader>
          <CardTitle as="h2" id="funnel-title">
            From invite to going
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2">
            {steps.map((step) => {
              const pct = Math.round((step.value / funnel.invited) * 100);
              return (
                <li key={step.label}>
                  <div className="flex justify-between text-sm">
                    <span>{step.label}</span>
                    <span className="tabular text-[var(--fg-muted)]">
                      {step.value} · {pct}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--bg-sunken)]">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        step.label === 'Going' ? 'bg-[var(--gold)]' : 'bg-[var(--accent)]',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card aria-labelledby="funnel-nudge-title">
          <CardHeader>
            <div>
              <CardTitle as="h2" id="funnel-nudge-title">
                Nudge who has not answered
              </CardTitle>
              <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
                A short follow-up, as a draft.
              </p>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <DraftButton
              eventId={eventId}
              body={{ kind: 'nudge', segment: 'opened_no_reply' }}
              disabled={!funnel.segments.openedNoReply.length}
            >
              Opened, no reply ({funnel.segments.openedNoReply.length})
            </DraftButton>
            <DraftButton
              eventId={eventId}
              body={{ kind: 'nudge', segment: 'never_opened' }}
              disabled={!funnel.segments.neverOpened.length}
            >
              Never opened ({funnel.segments.neverOpened.length})
            </DraftButton>
          </CardContent>
        </Card>
        {funnel.perSession.length > 1 ? (
          <Card aria-labelledby="funnel-sessions-title">
            <CardHeader>
              <CardTitle as="h2" id="funnel-sessions-title">
                By session
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {funnel.perSession.map((s) => (
                  <li key={s.sessionId} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span className="tabular shrink-0 text-[var(--fg-muted)]">
                      {s.going} going · {s.responded} of {s.invited} answered
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
