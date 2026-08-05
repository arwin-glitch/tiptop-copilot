import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAuth } from '@/lib/auth/session';
import { envLimits, isDemoMode } from '@/lib/config/env';
import { getStore } from '@/lib/runtime';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { configuredCriteria, getActiveThesis } from '@/lib/services/thesis';
import { googleConfigured } from '@/lib/google/oauth';
import { PageHeader, PageShell, DataRow } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThesisEditor, TimezoneSetting } from '@/components/settings/settings-client';
import { IntegrationControls } from '@/components/settings/integration-controls';
import { formatDateTime } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = await requireAuth();
  const store = getStore();
  const [thesis, integration] = await Promise.all([
    getActiveThesis(store, auth.organizationId, auth.userId),
    getPrimaryIntegration(store, auth.organizationId),
  ]);
  const limits = envLimits();
  const criteria = configuredCriteria(thesis);
  const demo = isDemoMode();

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        subtitle="Your thesis, your thresholds, your integrations. Nothing here is inferred on your behalf."
      />

      <Tabs defaultValue="thesis">
        <TabsList>
          <TabsTrigger value="thesis">Thesis &amp; scoring</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
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
                  Read-only Gmail and Calendar. This app requests no send permission and cannot send
                  email.
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
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preferences">
          <Card>
            <CardContent className="space-y-5 pt-4">
              <TimezoneSetting current={auth.profile.timezone} />
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
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
