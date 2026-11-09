import { harmonicConnection } from '@/lib/integrations/harmonic-mcp';
import { log } from '@/lib/security/redact';
import { getStore } from '@/lib/runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Reads the organization's Harmonic connection and renders the card. A fault
 * (a missing table, a store error) leaves the card out instead of taking
 * Settings down with it.
 */
export async function HarmonicSetting({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  let state: Awaited<ReturnType<typeof harmonicConnection>>;
  try {
    state = await harmonicConnection(getStore(), organizationId);
  } catch (error) {
    log.warn('Harmonic connection could not be read', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
  return (
    <HarmonicCard
      connected={state.connected}
      connectedAt={state.connectedAt}
      canManage={canManage}
    />
  );
}

/**
 * Settings → Integrations: TipTop's Harmonic seat, one per organization.
 * Admins connect and disconnect; everyone else sees the status only.
 */
export function HarmonicCard({
  connected,
  connectedAt,
  canManage,
}: {
  connected: boolean;
  connectedAt: string | null;
  canManage: boolean;
}) {
  const since = connectedAt ? formatDay(connectedAt) : null;
  return (
    <Card className="mt-4">
      <CardHeader>
        <div>
          <CardTitle as="h2">Harmonic</CardTitle>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            Connect TipTop&apos;s Harmonic seat so Kraken search can look up people and companies
            nobody has met yet. Uses Harmonic&apos;s free 100 look-ups a day; nothing is written to
            Harmonic.
          </p>
        </div>
        <Badge tone={connected ? 'ok' : 'neutral'}>
          {connected ? 'Connected' : 'Not connected'}
        </Badge>
      </CardHeader>
      <CardContent>
        {connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">
              Connected
              {since ? <span className="text-[var(--fg-muted)]"> · since {since}</span> : null}
            </p>
            {canManage ? (
              <form action="/api/integrations/harmonic/disconnect" method="post">
                <Button type="submit" variant="secondary" size="sm">
                  Disconnect
                </Button>
              </form>
            ) : null}
          </div>
        ) : canManage ? (
          <Button asChild variant="primary" size="sm">
            {/* A plain link: the route redirects to Harmonic's sign-in. */}
            <a href="/api/integrations/harmonic/start">Connect Harmonic</a>
          </Button>
        ) : (
          <p className="text-sm text-[var(--fg-muted)]">An admin can connect it.</p>
        )}
      </CardContent>
    </Card>
  );
}

function formatDay(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
