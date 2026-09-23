import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/feedback';
import { IconChip, sourceStyle, statusBadge } from '@/components/updates/style';
import { cn } from '@/lib/util/cn';
import { relativeTime } from '@/lib/util/time';
import { channelLabel } from '@/lib/updates/sources';
import type { SetupProblem, UpdateSourceView } from '@/lib/updates/types';

/**
 * Whether each channel can be read, and when it cannot, the exact fix. A
 * missing scope or a bad token is one app-wide banner; a missing invite is
 * per channel.
 */

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-[var(--bg-sunken)] px-1 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">
      {children}
    </code>
  );
}

function botName(handle: string | null): string {
  return handle ? `@${handle}` : "the Copilot's Slack bot";
}

function InviteCommand({ handle }: { handle: string | null }) {
  return handle ? (
    <Code>/invite @{handle}</Code>
  ) : (
    <>
      <Code>/invite</Code> followed by the Copilot&apos;s Slack bot&apos;s name
    </>
  );
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

const TOKEN_STEPS = (
  <>
    update <Code>ASK_RELAY_SLACK_TOKEN</Code> on Render (plus the Vercel standby and the{' '}
    <Code>SLACK_BOT_TOKEN</Code> GitHub secret)
  </>
);

export function SetupBanner({
  setup,
  botHandle,
  views,
}: {
  setup: SetupProblem;
  botHandle: string | null;
  views: UpdateSourceView[];
}) {
  if (setup.kind === 'no_token') {
    return (
      <Notice tone="warn">
        <p className="font-medium">Slack isn&apos;t connected.</p>
        <p className="mt-1">
          Set <Code>ASK_RELAY_SLACK_TOKEN</Code> on Render (the bot token the Today briefing cards
          already use), then redeploy.
        </p>
      </Notice>
    );
  }
  if (setup.kind === 'token_rejected') {
    return (
      <Notice tone="warn">
        <p className="font-medium">
          Slack rejected the bot token (<Code>{setup.code}</Code>).
        </p>
        <p className="mt-1">
          Copy the Bot User OAuth Token from api.slack.com/apps → the app behind{' '}
          {botName(botHandle)} → OAuth &amp; Permissions, and {TOKEN_STEPS}. Today&apos;s briefing
          cards use the same token.
        </p>
      </Notice>
    );
  }
  return (
    <Notice tone="warn">
      <p className="font-medium">Slack needs one more permission</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5">
        <li>
          Open <External href="https://api.slack.com/apps">api.slack.com/apps</External> → the app
          behind {botName(botHandle)} → OAuth &amp; Permissions → Bot Token Scopes → Add an OAuth
          Scope → <Code>{setup.needed}</Code>.
        </li>
        <li>
          Reinstall the app to the workspace and click Allow. If the button says Request to Install,
          a workspace owner has to approve it.
        </li>
        <li>If the Bot User OAuth Token changed, {TOKEN_STEPS}.</li>
        <li>
          Invite the bot to each channel: <InviteCommand handle={botHandle} /> in{' '}
          {views.map((v, i) => (
            <span key={v.source.key}>
              {i > 0 ? (i === views.length - 1 ? ' and ' : ', ') : null}
              {v.channelUrl ? (
                <External href={v.channelUrl}>{channelLabel(v.source)}</External>
              ) : (
                channelLabel(v.source)
              )}
            </span>
          ))}
          .
        </li>
      </ol>
      <p className="mt-2 text-[var(--fg-muted)]">
        Press Refresh after each step — Slack is re-checked at most once every 20 seconds.
      </p>
    </Notice>
  );
}

/** Problems the setup banner already explains are not repeated per channel. */
function coveredByBanner(view: UpdateSourceView, setup: SetupProblem | null): boolean {
  if (!setup) return false;
  const s = view.access.state;
  return s === 'no_token' || s === 'token_rejected' || s === 'missing_scope';
}

export function SourceAccessNotice({
  view,
  botHandle,
  now,
}: {
  view: UpdateSourceView;
  botHandle: string | null;
  now: Date;
}) {
  const label = channelLabel(view.source);
  const staleAgo = view.stale ? relativeTime(view.stale.since, now) : null;
  const a = view.access;
  let body: ReactNode;
  switch (a.state) {
    case 'ok':
      return null;
    case 'not_invited':
      body = (
        <>
          Invite the bot to {label}: open the channel in Slack and send{' '}
          <InviteCommand handle={botHandle} /> (Slack posts a &lsquo;joined&rsquo; notice). If
          it&apos;s already a member, the channel ID <Code>{view.source.channelId}</Code> in{' '}
          <Code>src/lib/updates/sources.ts</Code> is wrong.
          {view.channelUrl ? (
            <span className="mt-1.5 block">
              <External href={view.channelUrl}>Open {label} in Slack</External>
            </span>
          ) : null}
        </>
      );
      break;
    case 'rate_limited':
      body = (
        <>
          Slack asked us to slow down. {staleAgo ? `Showing the copy from ${staleAgo}; ` : ''}next
          check in {a.retryAfterSec}s.
        </>
      );
      break;
    case 'unreachable':
      body = (
        <>
          Slack didn&apos;t answer.{' '}
          {staleAgo ? `Showing the copy from ${staleAgo}.` : 'Try Refresh in a minute.'}
        </>
      );
      break;
    case 'error':
      body = (
        <>
          Slack returned <Code>{a.code}</Code> for {label}.
        </>
      );
      break;
    case 'missing_scope':
      body = (
        <>
          The bot needs the <Code>{a.needed}</Code> scope to read {label}.
        </>
      );
      break;
    case 'token_rejected':
      body = (
        <>
          Slack rejected the bot token (<Code>{a.code}</Code>).
        </>
      );
      break;
    case 'no_token':
      body = (
        <>
          Slack isn&apos;t connected. Set <Code>ASK_RELAY_SLACK_TOKEN</Code>.
        </>
      );
      break;
  }
  return (
    <Notice tone={a.state === 'rate_limited' || a.state === 'unreachable' ? 'info' : 'warn'}>
      <p>
        <span className="font-medium">{view.source.label}</span> — {body}
      </p>
    </Notice>
  );
}

export function SourceStatusStrip({
  views,
  now,
  botHandle,
  setup,
}: {
  views: UpdateSourceView[];
  now: Date;
  botHandle: string | null;
  setup: SetupProblem | null;
}) {
  const problems = views.filter((v) => v.access.state !== 'ok' && !coveredByBanner(v, setup));
  return (
    <section aria-label="Sources" className="space-y-2">
      {/* Two compact columns on phones, so the first report is not pushed below the fold. */}
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {views.map((v) => {
          const style = sourceStyle(v.source);
          const badge = statusBadge(v);
          return (
            <li
              key={v.source.key}
              className="min-w-0 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-2.5 sm:p-3"
            >
              <div className="flex items-start gap-2.5">
                <IconChip icon={style.icon} className={cn(style.chip, 'max-sm:hidden')} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <p className="text-sm font-medium [overflow-wrap:break-word]">
                      {v.source.label}
                    </p>
                    <Badge tone={badge.tone} className="whitespace-normal">
                      {badge.label}
                    </Badge>
                  </div>
                  <p className="text-mini hidden font-mono [overflow-wrap:anywhere] text-[var(--fg-subtle)] sm:block">
                    {channelLabel(v.source)}
                  </p>
                  <p className="text-mini mt-0.5 text-[var(--fg-muted)]">
                    <span className="hidden sm:inline">{v.source.cadence} · </span>
                    {v.lastPostAt ? `Last post ${relativeTime(v.lastPostAt, now)}` : 'No posts yet'}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {problems.map((v) => (
        <SourceAccessNotice key={v.source.key} view={v} botHandle={botHandle} now={now} />
      ))}
    </section>
  );
}
