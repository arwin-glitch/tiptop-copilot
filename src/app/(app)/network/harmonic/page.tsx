import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import {
  harmonicConfigured,
  harmonicProfile,
  type HarmonicKind,
} from '@/lib/integrations/harmonic';
import { single } from '@/lib/util/page-tabs';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { Notice } from '@/components/ui/feedback';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'From Harmonic' };

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * A person or company from Harmonic that nobody at the fund has met yet,
 * opened from Ctrl+K's "Harmonic · not met yet" group: who they are, where
 * they work, and links out (LinkedIn, their website). Read-only; nothing is
 * saved in Kraken.
 */
export default async function HarmonicProfilePage({ searchParams }: Props) {
  await requireAuth();
  const query = await searchParams;
  const kind: HarmonicKind = single(query.kind) === 'company' ? 'company' : 'person';
  const id = single(query.id) ?? '';
  const profile = harmonicConfigured() ? await harmonicProfile(kind, id) : null;

  return (
    <PageShell>
      <Link
        href="/network?tab=people"
        className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Network
      </Link>
      {!harmonicConfigured() ? (
        <>
          <PageHeader title="From Harmonic" />
          <Notice tone="warn">
            Harmonic is not connected yet. An admin adds HARMONIC_API_KEY in Render.
          </Notice>
        </>
      ) : !profile ? (
        <>
          <PageHeader title="From Harmonic" />
          <Notice tone="warn">Harmonic could not show this {kind} just now.</Notice>
        </>
      ) : (
        <>
          <PageHeader
            title={profile.name}
            subtitle={`${kind === 'person' ? 'Person' : 'Company'} from Harmonic · not met yet`}
          />
          <div className="max-w-2xl space-y-4 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-5">
            {profile.headline ? <p className="text-base">{profile.headline}</p> : null}
            {profile.lines.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {profile.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            {profile.location ? (
              <p className="text-sm text-[var(--fg-muted)]">{profile.location}</p>
            ) : null}
            {profile.description ? (
              <p className="text-sm whitespace-pre-line text-[var(--fg-muted)]">
                {profile.description.length > 600
                  ? `${profile.description.slice(0, 599)}…`
                  : profile.description}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3 pt-1">
              {profile.linkedin ? (
                <a
                  href={profile.linkedin}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
                >
                  LinkedIn <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              ) : null}
              {profile.website ? (
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
                >
                  Website <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
