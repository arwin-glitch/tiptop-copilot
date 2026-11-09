import { Loader2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/shell/page-header';

/** Shown at once while Harmonic looks the name up (about ten seconds). */
export default function HarmonicLoading() {
  return (
    <PageShell>
      <PageHeader title="Harmonic" subtitle="People and companies from TipTop’s Harmonic seat" />
      <p className="inline-flex items-center gap-2 text-sm text-[var(--fg-muted)]">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Searching Harmonic… this takes about ten seconds.
      </p>
    </PageShell>
  );
}
