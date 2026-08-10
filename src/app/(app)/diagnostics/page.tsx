import type { Metadata } from 'next';
import { CheckCircle2, CircleAlert, CircleDashed, FlaskConical } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { capabilityReport, envLimits, type CapabilityStatus } from '@/lib/config/env';
import { getAI, getResearchProvider, getStore } from '@/lib/runtime';
import { getUsageWindow } from '@/lib/security/limits';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { TOOL_NAMES } from '@/lib/ai/tools/registry';
import { PROMPT_VERSIONS } from '@/lib/ai/prompts';

export const metadata: Metadata = { title: 'Diagnostics' };
export const dynamic = 'force-dynamic';

/**
 * Configuration diagnostics.
 *
 * Reports presence and shape only. No environment variable *value* is read into
 * this page — a screenshot of it is safe to paste into a support thread.
 */
export default async function DiagnosticsPage() {
  const auth = await requireAuth();
  const checks = capabilityReport();
  const limits = envLimits();
  const store = getStore();
  const ai = getAI();
  const research = getResearchProvider();
  const usage = await getUsageWindow(store, auth.organizationId, auth.userId);

  const blocking = checks.filter((c) => c.required && c.status === 'missing');

  return (
    <PageShell>
      <PageHeader
        title="Diagnostics"
        subtitle="What is configured and what is missing. Values are never shown — only whether a variable is present and correctly shaped."
      />

      {blocking.length > 0 ? (
        <Notice tone="warn" className="mb-5">
          <p className="font-medium">
            {blocking.length} required setting{blocking.length === 1 ? '' : 's'} missing.
          </p>
          <p className="mt-1 text-[var(--fg-muted)]">
            The app runs, but the affected capability is unavailable. PUBLISH_CHECKLIST.md lists the
            exact steps.
          </p>
        </Notice>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle as="h2">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[var(--border)]">
            {checks.map((check) => (
              <li key={check.key} className="flex items-start gap-3 py-3">
                <StatusIcon status={check.status} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {check.label}
                    <StatusBadge status={check.status} />
                    {check.required ? <Badge tone="outline">Required</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{check.detail}</p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {check.variables.map((v) => (
                      <code
                        key={v}
                        className="rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-subtle)]"
                      >
                        {v}
                      </code>
                    ))}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">Active providers</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <Row label="Data store" value={store.kind} />
              <Row
                label="AI provider"
                value={`${ai.kind}${ai.available() ? '' : ' (unavailable)'}`}
              />
              <Row
                label="Research provider"
                value={`${research.kind}${research.available() ? '' : ' (unavailable)'}`}
              />
              <Row label="Retrieval" value="postgres full-text search" />
            </dl>
            {research.unavailableReason() ? (
              <p className="mt-3 text-xs text-[var(--fg-subtle)]">{research.unavailableReason()}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Usage this window</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <Row
                label="AI requests (last hour)"
                value={`${usage.requestsThisHour} / ${limits.maxAiRequestsPerUserPerHour}`}
              />
              <Row
                label="Estimated spend (24h)"
                value={`$${usage.spendTodayUsd.toFixed(4)} / $${limits.dailyAiBudgetUsd.toFixed(2)}`}
              />
            </dl>
            <p className="mt-3 text-xs text-[var(--fg-subtle)]">
              Spend is estimated from published per-token pricing and the usage the provider
              reports. Unknown models are priced at the most expensive tier so the budget is never
              accidentally permissive.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Prompt versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {Object.entries(PROMPT_VERSIONS).map(([name, version]) => (
                <li key={name} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-[var(--fg-muted)]">{name}</span>
                  <code className="font-mono text-[11px]">{version}</code>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">
              <span className="flex items-center gap-2">
                <FlaskConical className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
                Allowlisted tools
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-sm text-[var(--fg-muted)]">
              The assistant can call these and nothing else. There is no database, shell or
              arbitrary-URL access.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {TOOL_NAMES.map((name) => (
                <li key={name}>
                  <code className="rounded bg-[var(--bg-sunken)] px-1.5 py-0.5 font-mono text-[11px]">
                    {name}
                  </code>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle as="h2">Health endpoints</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <Row label="Public liveness" value="GET /api/live" />
            <Row label="Authenticated health" value="GET /api/health" />
          </dl>
          <p className="mt-3 text-xs text-[var(--fg-subtle)]">
            The public endpoint returns only that the process is running. Anything that could reveal
            configuration requires a session.
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="font-mono text-[12px]">{value}</dd>
    </div>
  );
}

function StatusIcon({ status }: { status: CapabilityStatus }) {
  if (status === 'ready') {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" aria-hidden="true" />;
  }
  if (status === 'missing') {
    return (
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
    );
  }
  return (
    <CircleDashed className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
  );
}

function StatusBadge({ status }: { status: CapabilityStatus }) {
  const map: Record<
    CapabilityStatus,
    { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }
  > = {
    ready: { tone: 'ok', label: 'Ready' },
    demo: { tone: 'warn', label: 'Demo' },
    missing: { tone: 'danger', label: 'Missing' },
    'optional-missing': { tone: 'neutral', label: 'Optional' },
  };
  const entry = map[status];
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}
