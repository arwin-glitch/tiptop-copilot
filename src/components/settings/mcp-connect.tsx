'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { createMcpTokenAction, listMcpTokensAction, revokeMcpTokenAction } from '@/app/actions/mcp';
import type { McpTokenSummary } from '@/lib/services/mcp-tokens';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/form';
import { formatDateTime } from '@/lib/util/time';

/**
 * Settings → Integrations → Connect Claude (MCP).
 *
 * An owner names a client and gets a token, shown once: as a connector URL for
 * claude.ai (which adds a server by URL alone) and as a bare token for clients
 * that send `Authorization: Bearer` (Claude Code, the cloud routines). Below,
 * every token with when it was last used, and a two-step Revoke.
 */
export function McpConnectCard({
  endpoint,
  initialTokens,
  setupMessage,
  canManage,
  timeZone,
}: {
  /** The endpoint without a token, e.g. https://copilot.example/api/mcp. */
  endpoint: string;
  initialTokens: McpTokenSummary[];
  /** Set when the tokens table does not exist yet: what to run. */
  setupMessage: string | null;
  canManage: boolean;
  timeZone: string;
}) {
  const [tokens, setTokens] = React.useState(initialTokens);
  const [name, setName] = React.useState('');
  const [created, setCreated] = React.useState<{ token: string; name: string } | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const refresh = async () => {
    const result = await listMcpTokensAction();
    if (result.ok && result.data) setTokens(result.data);
  };

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await createMcpTokenAction(name);
      if (!result.ok || !result.data) {
        toast.error(result.error?.message ?? 'Could not create the token');
        return;
      }
      setCreated({ token: result.data.token, name: result.data.summary.name });
      setName('');
      await refresh();
    });
  };

  const revoke = (token: McpTokenSummary) => {
    startTransition(async () => {
      const result = await revokeMcpTokenAction(token.id);
      setConfirming(null);
      if (!result.ok) {
        toast.error(result.error?.message ?? 'Could not revoke the token');
        return;
      }
      toast.success(`${token.name} can no longer connect`);
      await refresh();
    });
  };

  if (!canManage) {
    return (
      <Notice>Only an owner of this organization can create or revoke Claude connections.</Notice>
    );
  }
  if (setupMessage) {
    return (
      <Notice tone="warn">
        <p>{setupMessage}</p>
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      {created ? (
        <NewToken
          endpoint={endpoint}
          token={created.token}
          name={created.name}
          onDone={() => setCreated(null)}
        />
      ) : null}

      <form onSubmit={create} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="mcp-token-name">Connection name</Label>
          <Input
            id="mcp-token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="claude.ai, Deal-sorter routine, …"
            maxLength={80}
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="primary" size="md" loading={pending} disabled={!name.trim()}>
          <Plus aria-hidden="true" />
          Create token
        </Button>
      </form>

      {tokens.length ? (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
              aria-label={t.name}
            >
              <KeyRound className="size-4 shrink-0 text-[var(--fg-subtle)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">
                  {t.name}{' '}
                  <span className="font-mono text-[11px] font-normal text-[var(--fg-subtle)]">
                    …{t.hint}
                  </span>
                </p>
                <p className="text-xs text-[var(--fg-muted)]">
                  Created {formatDateTime(t.created_at, timeZone)} ·{' '}
                  {t.last_used_at
                    ? `last used ${formatDateTime(t.last_used_at, timeZone)}`
                    : 'never used'}
                </p>
              </div>
              {t.revoked_at ? (
                <Badge tone="neutral">Revoked</Badge>
              ) : confirming === t.id ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={pending}
                    onClick={() => revoke(t)}
                    aria-label={`Confirm revoking ${t.name}`}
                  >
                    Revoke for good
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <>
                  <Badge tone="ok">Live</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setConfirming(t.id)}
                    aria-label={`Revoke ${t.name}`}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--fg-subtle)]">No connections yet.</p>
      )}
    </div>
  );
}

function NewToken({
  endpoint,
  token,
  name,
  onDone,
}: {
  endpoint: string;
  token: string;
  name: string;
  onDone: () => void;
}) {
  const url = `${endpoint.replace(/\/+$/, '')}/${token}`;
  return (
    <div
      role="region"
      aria-label="New token"
      className="space-y-3 rounded-md border border-l-2 border-[var(--border-strong)] border-l-[var(--gold)] bg-[var(--note-soft)] p-3"
    >
      <p className="text-sm font-medium">
        {name} is ready. Copy it now: it is not stored and will not be shown again.
      </p>
      <SecretRow
        label="Connector URL"
        hint="claude.ai → Settings → Connectors → Add custom connector: paste this as the URL."
        value={url}
      />
      <SecretRow
        label="Token"
        hint="For Claude Code and routines: send it as “Authorization: Bearer <token>” to the endpoint above."
        value={token}
      />
      <Button size="sm" variant="secondary" onClick={onDone}>
        Done, I have copied it
      </Button>
    </div>
  );
}

function SecretRow({ label, hint, value }: { label: string; hint: string; value: string }) {
  const [copied, setCopied] = React.useState(false);
  const id = `mcp-secret-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy: select the text and copy it by hand');
    }
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-9"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-[var(--fg-muted)]">{hint}</p>
    </div>
  );
}
