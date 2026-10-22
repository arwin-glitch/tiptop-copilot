import type { Metadata } from 'next';
import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { hasRole, requireAuth } from '@/lib/auth/session';
import { env, envLimits, isDemoMode } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { listMcpTokens } from '@/lib/services/mcp-tokens';
import { err } from '@/lib/util/result';
import { vapidPublicKey } from '@/lib/services/push-alerts';
import { listDesktopDevices } from '@/lib/services/desktop-alerts';
import { configuredCriteria, getActiveThesis } from '@/lib/services/thesis';
import { googleConfigured } from '@/lib/google/oauth';
import { canSend } from '@/lib/google/gmail-send';
import { canEditCalendar } from '@/lib/calendar/edit-access';
import { PageHeader, PageShell, DataRow } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThesisEditor, TimezoneSetting } from '@/components/settings/settings-client';
import { IntegrationControls } from '@/components/settings/integration-controls';
import { PushAlertsSetting } from '@/components/settings/push-alerts';
import { DesktopAlertsSetting } from '@/components/settings/desktop-alerts';
import { DesktopAppSetting } from '@/components/settings/desktop-app';
import { WebOnly } from '@/components/desktop/desktop-only';
import { latestDesktopRelease } from '@/lib/desktop/releases';
import { desktopVersionHint } from '@/lib/desktop/server';
import { updatesItself } from '@/lib/desktop/shared';
import { McpConnectCard } from '@/components/settings/mcp-connect';
import { BookingSettings } from '@/components/booking/booking-settings';
import { BOOKING_NOT_SET_UP, readBookingSettings } from '@/lib/services/booking';
import { DEFAULT_BOOKING_CONFIG } from '@/lib/booking/config';
import { principalTimeZone } from '@/lib/services/push-alerts';
import { log } from '@/lib/security/redact';
import { formatDateTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SETTINGS_TABS = [
  'thesis',
  'integrations',
  'preferences',
  'booking',
  'limits',
  'data',
] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requireAuth();
  const params = await searchParams;
  const asked = typeof params.tab === 'string' ? params.tab : null;
  const tab = (SETTINGS_TABS as readonly string[]).includes(asked ?? '') ? asked! : 'thesis';
  const store = getStore();
  const [thesis, integration] = await Promise.all([
    getActiveThesis(store, auth.organizationId, auth.userId),
    getPrimaryIntegration(store, auth.organizationId),
  ]);
  const limits = envLimits();
  const criteria = configuredCriteria(thesis);
  const demo = isDemoMode();
  const canManageMcp = hasRole(auth, 'owner');
  const mcpTokens = canManageMcp
    ? await listMcpTokens(store, auth.organizationId)
    : err('forbidden', 'Owners only.');
  const mcpEndpoint = `${env().appUrl.replace(/\/+$/, '')}/api/mcp`;
  const desktopVersion = await desktopVersionHint();
  // Only an app too old to update itself is told the newest version, so a
  // browser or a self-updating app never waits on the release lookup.
  const newestDesktop =
    desktopVersion && !updatesItself(desktopVersion) ? await latestDesktopRelease() : null;
  const newestDesktopVersion =
    newestDesktop && newestDesktop.state !== 'none' ? newestDesktop.version : null;
  // Null, not an empty list, when it cannot be read: the card then neither
  // shows a list nor concludes this computer was turned off elsewhere.
  const desktopComputers = await listDesktopDevices(store, auth.organizationId, {
    userId: auth.userId,
    admin: hasRole(auth, 'admin'),
  }).catch(() => null);
  // The booking link (D-074). A fault reading it shows the "run the
  // migration" note rather than taking Settings down with it.
  const [booking, hostZone] = await Promise.all([
    readBookingSettings(store, auth.organizationId).catch((error: unknown) => {
      log.warn('Booking settings could not be read', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }),
    principalTimeZone(store, auth.organizationId),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        subtitle="Your thesis, your thresholds, your integrations. Nothing here is inferred on your behalf."
      />

      {/* One row, above the tabs, so it is there whichever tab is open. */}
      <Card className="mb-6" data-tour="settings-help">
        <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
          >
            <LifeBuoy className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-serif font-semibold">Help &amp; tours</h2>
            <p className="text-sm text-[var(--fg-muted)]">
              What every page holds, where to click, and a short guided tour of each.
            </p>
          </div>
          <Button asChild variant="primary" size="sm">
            <Link href="/help">Open Help</Link>
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue={tab}>
        <TabsList data-tour="settings-tabs">
          <TabsTrigger value="thesis">Thesis &amp; scoring</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="booking">Booking link</TabsTrigger>
          <TabsTrigger value="limits">Limits &amp; cost</TabsTrigger>
          <TabsTrigger value="data">Data &amp; privacy</TabsTrigger>
        </TabsList>

        <TabsContent value="thesis">
          {criteria.unconfigured.length > 0 ? (
            <Notice className="mb-4">
              Not configured: {criteria.unconfigured.join(', ')}. These are excluded from scoring
              until you set them — the product will not assume a value.
            </Notice>
          ) : null}
          <ThesisEditor thesis={thesis} />
        </TabsContent>

        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <div>
                <CardTitle as="h2">Google Workspace</CardTitle>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  Gmail and Calendar, read-only by default. Sending is a separate switch below: once
                  it is on, the email session can send a reply from this mailbox when someone taps
                  Send. Nothing ever sends on its own. Calendar editing is another, for changing
                  events from the Calendar tab.
                </p>
              </div>
              {integration ? (
                <Badge
                  tone={
                    integration.status === 'connected'
                      ? 'ok'
                      : integration.status === 'needs_reauth'
                        ? 'warn'
                        : 'neutral'
                  }
                >
                  {integration.status.replace(/_/g, ' ')}
                </Badge>
              ) : (
                <Badge tone="neutral">Not connected</Badge>
              )}
            </CardHeader>
            <CardContent>
              {demo ? (
                <Notice className="mb-4">
                  Demo mode is on. The mailbox and calendar are served from fictional fixtures; no
                  Google account is or can be connected.
                </Notice>
              ) : !googleConfigured() ? (
                <Notice tone="warn" className="mb-4">
                  <p className="font-medium">Google OAuth is not configured.</p>
                  <p className="mt-1 text-[var(--fg-muted)]">
                    Set <code className="font-mono text-[11px]">GOOGLE_CLIENT_ID</code> and{' '}
                    <code className="font-mono text-[11px]">GOOGLE_CLIENT_SECRET</code>. See{' '}
                    <Link href="/diagnostics" className="underline">
                      diagnostics
                    </Link>{' '}
                    for the full list.
                  </p>
                </Notice>
              ) : null}

              {integration && !demo ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Send from the email session</p>
                    <p className="text-sm text-[var(--fg-muted)]">
                      {canSend(integration)
                        ? 'On. Replies send from this mailbox only when someone taps Send.'
                        : 'Off. The mailbox owner turns it on once; Google asks to approve sending and organizing mail.'}
                    </p>
                  </div>
                  {canSend(integration) ? (
                    <Badge tone="ok">On</Badge>
                  ) : (
                    // Google's consent screen will not open in the desktop app.
                    <WebOnly
                      serverVersion={desktopVersion}
                      fallback={
                        <span className="text-sm text-[var(--fg-muted)]">
                          Turn this on from Copilot in your web browser.
                        </span>
                      }
                    >
                      <a
                        href="/api/integrations/google/start?send=1"
                        className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
                      >
                        Turn on sending
                      </a>
                    </WebOnly>
                  )}
                </div>
              ) : null}

              {integration && !demo ? (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Edit the calendar from Copilot</p>
                    <p className="text-sm text-[var(--fg-muted)]">
                      {canEditCalendar(integration)
                        ? 'On. Events change from the Calendar tab only when someone saves, moves or deletes one; guests are emailed only when they choose Send.'
                        : 'Off. The calendar is view-only here. The mailbox owner turns it on once; Google asks to approve changing calendar events.'}
                    </p>
                  </div>
                  {canEditCalendar(integration) ? (
                    <Badge tone="ok">On</Badge>
                  ) : (
                    <WebOnly
                      serverVersion={desktopVersion}
                      fallback={
                        <span className="text-sm text-[var(--fg-muted)]">
                          Turn this on from Copilot in your web browser.
                        </span>
                      }
                    >
                      <a
                        href="/api/integrations/google/start?calendar=1&from=settings"
                        className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
                      >
                        Turn on calendar editing
                      </a>
                    </WebOnly>
                  )}
                </div>
              ) : null}

              <dl className="divide-y divide-[var(--border)]">
                <DataRow label="Account">
                  {integration?.account_email ?? (
                    <span className="text-[var(--fg-subtle)] italic">None</span>
                  )}
                </DataRow>
                <DataRow label="Scopes">
                  {integration?.scopes.length ? (
                    <ul className="space-y-0.5">
                      {integration.scopes.map((s) => (
                        <li key={s} className="font-mono text-[11px] text-[var(--fg-muted)]">
                          {s}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-[var(--fg-subtle)] italic">None</span>
                  )}
                </DataRow>
                <DataRow label="Last sync">
                  {integration?.last_sync_at ? (
                    formatDateTime(integration.last_sync_at, auth.profile.timezone)
                  ) : (
                    <span className="text-[var(--fg-subtle)] italic">Never</span>
                  )}
                </DataRow>
                {integration?.status_detail ? (
                  <DataRow label="Status detail">{integration.status_detail}</DataRow>
                ) : null}
                {integration?.last_sync_error ? (
                  <DataRow label="Last error">
                    <span className="text-[var(--danger)]">{integration.last_sync_error}</span>
                  </DataRow>
                ) : null}
              </dl>

              <div className="mt-4">
                <IntegrationControls
                  connected={Boolean(integration && integration.status !== 'disconnected')}
                  canConnect={!demo && googleConfigured()}
                  desktopVersion={desktopVersion}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <div>
                <CardTitle as="h2">Import from Affinity</CardTitle>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  Bring your Affinity lists into Copilot: export each list (Export → Export view as
                  CSV) and its notes (Export → Export all notes in view), then drop the files in.
                  Importing a file again updates what is here instead of duplicating it. It lives
                  under Knowledge, with the imported lists.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <Button asChild variant="secondary" size="sm">
                <Link href="/knowledge?tab=import">Import from Affinity</Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <div>
                <CardTitle as="h2">Connect Claude (MCP)</CardTitle>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  Let Claude read the CRM, the deal and LP pipelines, the portfolio and open tasks:
                  claude.ai as a custom connector, Claude Code and the cloud routines with a token.
                  Read-only, LP stages without amounts, and each connection has its own token you
                  can revoke.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <McpConnectCard
                endpoint={mcpEndpoint}
                initialTokens={mcpTokens.ok ? mcpTokens.value : []}
                setupMessage={
                  !mcpTokens.ok && mcpTokens.error.code !== 'forbidden'
                    ? mcpTokens.error.message
                    : null
                }
                canManage={canManageMcp}
                timeZone={auth.profile.timezone}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preferences">
          <Card>
            <CardContent className="space-y-5 pt-4">
              <TimezoneSetting current={auth.profile.timezone} />
              <PushAlertsSetting publicKey={vapidPublicKey()} desktopHint={desktopVersion} />
              <DesktopAlertsSetting
                computers={desktopComputers}
                desktopHint={desktopVersion}
                timeZone={auth.profile.timezone}
              />
              <DesktopAppSetting
                serverVersion={desktopVersion}
                newestVersion={newestDesktopVersion}
              />
              <div>
                <p className="text-sm font-medium">Account</p>
                <dl className="mt-2 divide-y divide-[var(--border)]">
                  <DataRow label="Name">{auth.profile.full_name ?? '—'}</DataRow>
                  <DataRow label="Email">{auth.profile.email}</DataRow>
                  <DataRow label="Organization">{auth.organization.name}</DataRow>
                  <DataRow label="Role">{auth.role}</DataRow>
                </dl>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="booking">
          <Card data-tour="settings-booking">
            <CardHeader>
              <div>
                <CardTitle as="h2">Booking link</CardTitle>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  A public page where people ask for a 30-minute call or an hour in person. Open
                  times come from the calendar; every request waits on the Calendar tab until
                  someone approves it. Off until you turn it on.
                </p>
              </div>
              {booking?.available ? (
                <Badge tone={booking.enabled ? 'ok' : 'neutral'}>
                  {booking.enabled ? 'On' : 'Off'}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <BookingSettings
                available={Boolean(booking?.available)}
                enabled={booking?.enabled ?? false}
                slug={booking?.slug ?? 'meet'}
                config={booking?.config ?? DEFAULT_BOOKING_CONFIG}
                linkBase={`${env().appUrl.replace(/\/+$/, '')}/meet/`}
                canEdit={hasRole(auth, 'admin')}
                hostZone={hostZone}
                demo={demo}
                notSetUpMessage={BOOKING_NOT_SET_UP}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="limits">
          <Card>
            <CardHeader>
              <div>
                <CardTitle as="h2">Cost and usage ceilings</CardTitle>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  Set by environment variable so they cannot be raised from the interface. See{' '}
                  <code className="font-mono text-[11px]">ENVIRONMENT_VARIABLES.md</code>.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-[var(--border)]">
                <DataRow label="Max emails per sync">{limits.maxEmailsPerSync}</DataRow>
                <DataRow label="Default lookback">{limits.defaultLookbackDays} days</DataRow>
                <DataRow label="Max attachments per analysis">
                  {limits.maxAttachmentsPerAnalysis}
                </DataRow>
                <DataRow label="Max attachment size">
                  {(limits.maxAttachmentBytes / 1_048_576).toFixed(0)} MB
                </DataRow>
                <DataRow label="Max pages per document">{limits.maxAttachmentPages}</DataRow>
                <DataRow label="Max document characters">
                  {limits.maxDocumentChars.toLocaleString()}
                </DataRow>
                <DataRow label="AI requests per user per hour">
                  {limits.maxAiRequestsPerUserPerHour}
                </DataRow>
                <DataRow label="Daily AI budget">${limits.dailyAiBudgetUsd.toFixed(2)}</DataRow>
                <DataRow label="Automatic analysis">
                  {limits.autoAnalyzeEnabled ? 'On' : 'Off'}
                </DataRow>
                <DataRow label="Deep automatic analysis">
                  {limits.deepAutoAnalysis ? 'On' : 'Off'}
                </DataRow>
              </dl>
              <p className="mt-4 text-xs text-[var(--fg-subtle)]">
                Extraction and analysis results are content-hashed and reused, so re-opening a deal
                does not re-spend. Use “Reanalyse” on a deal to force a fresh run.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="data">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Your data</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-[var(--fg-muted)]">
                Email metadata is synced by default. Full message bodies and attachments are fetched
                only when you open a message, when the classifier flags it as consequential, or when
                automatic deep analysis is enabled.
              </p>
              <p className="text-sm text-[var(--fg-muted)]">
                Provider refresh tokens are encrypted with AES-256-GCM before storage and are never
                written to logs. Attachments live in a private bucket and are served only through
                short-lived signed URLs.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="secondary" size="sm">
                  <Link href="/privacy">Privacy notice</Link>
                </Button>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/diagnostics">Diagnostics</Link>
                </Button>
              </div>
              <IntegrationControls
                connected={Boolean(integration && integration.status !== 'disconnected')}
                canConnect={!demo && googleConfigured()}
                showDataDeletion
                desktopVersion={desktopVersion}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
