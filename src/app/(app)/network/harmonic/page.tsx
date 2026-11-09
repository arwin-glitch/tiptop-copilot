import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ExternalLink, Search } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { harmonicLookup, type HarmonicLookupHit } from '@/lib/integrations/harmonic-mcp';
import { getStore } from '@/lib/runtime';
import { single } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/feedback';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Harmonic' };

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const KIND_LABEL: Record<HarmonicLookupHit['kind'], string> = {
  person: 'Person',
  company: 'Company',
  investor: 'Investor',
};

/** Only http(s) links are drawn; anything else from the provider is dropped. */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function harmonicConsoleUrl(hit: HarmonicLookupHit): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(hit.id)) return null;
  const path = hit.kind === 'person' ? 'person' : 'company';
  return `https://console.harmonic.ai/dashboard/${path}/${hit.id}`;
}

/**
 * Ctrl+K's "Search Harmonic" row lands here: one look-up against TipTop's
 * Harmonic seat (its MCP server, 100 free look-ups a day per person, cached a
 * day), run only because someone clicked. People, companies and investors
 * come back as cards with links out. Read-only; nothing is saved in Kraken.
 */
export default async function HarmonicLookupPage({ searchParams }: Props) {
  const auth = await requireAuth();
  const query = await searchParams;
  const q = (single(query.q) ?? '').trim().slice(0, 200);

  // Old profile links (?kind=&id=) from before the look-up page: search the id.
  if (!q) {
    const id = (single(query.id) ?? '').trim();
    if (id) redirect(`/network/harmonic?q=${encodeURIComponent(id)}`);
  }

  const result = q ? await harmonicLookup(getStore(), auth.organizationId, q) : null;
  const code: string | null = result && !result.ok ? result.error.code : null;
  const hits = result && result.ok ? result.value : [];

  return (
    <PageShell>
      <Link
        href="/network?tab=people"
        className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Network
      </Link>
      <PageHeader
        title={q ? `Harmonic: ${q}` : 'Harmonic'}
        subtitle="People and companies from TipTop’s Harmonic seat"
      />
      {!q ? (
        <Notice>Search with Ctrl+K, then pick “Search Harmonic”.</Notice>
      ) : code === 'not_configured' ? (
        <Notice tone="warn">
          Harmonic isn&apos;t connected yet. An admin connects it in Settings → Integrations.{' '}
          <Link href="/settings?tab=integrations" className="text-[var(--accent)] hover:underline">
            Open Integrations
          </Link>
        </Notice>
      ) : code === 'rate_limited' ? (
        <Notice tone="warn">
          Today&apos;s 100 free Harmonic look-ups are used up. They reset tomorrow.
        </Notice>
      ) : code ? (
        <Notice tone="warn">Harmonic couldn&apos;t answer just now.</Notice>
      ) : hits.length === 0 ? (
        <Notice>Harmonic found nobody matching “{q}”.</Notice>
      ) : (
        <ul className="max-w-3xl space-y-3">
          {hits.map((hit) => (
            <HitCard key={hit.urn} hit={hit} />
          ))}
        </ul>
      )}
      {q ? (
        <p className="mt-6 text-xs text-[var(--fg-subtle)]">
          Uses TipTop’s free Harmonic look-ups (100 a day). Nothing is saved in Kraken.
        </p>
      ) : null}
    </PageShell>
  );
}

const linkClass = 'inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline';

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children} <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}

function HitCard({ hit }: { hit: HarmonicLookupHit }) {
  const linkedin = safeHttpUrl(hit.linkedin);
  const website = safeHttpUrl(hit.website);
  const harmonic = harmonicConsoleUrl(hit);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-base font-semibold">{hit.name}</p>
        <span className="text-xs text-[var(--fg-muted)]">{KIND_LABEL[hit.kind]}</span>
      </div>
      {hit.headline ? <p className="mt-1 text-sm text-[var(--fg-muted)]">{hit.headline}</p> : null}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {linkedin ? <OutLink href={linkedin}>LinkedIn</OutLink> : null}
        {website ? <OutLink href={website}>Website</OutLink> : null}
        {harmonic ? <OutLink href={harmonic}>Open in Harmonic</OutLink> : null}
        {hit.kind === 'person' ? (
          <Link
            href={`/network?tab=people&source=mail&q=${encodeURIComponent(hit.name)}`}
            className={linkClass}
          >
            <Search className="size-3.5" aria-hidden="true" /> Search Kraken
          </Link>
        ) : null}
      </div>
    </li>
  );
}
