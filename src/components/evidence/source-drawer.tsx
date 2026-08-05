'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, FileText, Quote } from 'lucide-react';
import { Dialog, DialogTrigger, Drawer } from '@/components/ui/dialog';
import { Badge, ProvenanceBadge } from '@/components/ui/badge';
import { PlainText } from '@/components/ui/feedback';
import { citationHref, citationLabel, citationProvenance } from '@/lib/ai/citations';
import type { Citation } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/**
 * The evidence surface.
 *
 * Every generated claim in the product is rendered next to the citations it
 * rests on, and each citation opens this drawer showing where the text came
 * from, when, and who said it. Clicking through goes to the underlying record.
 */

export function CitationChip({
  citation,
  citations,
  className,
}: {
  citation: Citation;
  citations: Citation[];
  className?: string;
}) {
  return (
    <SourceDrawer citations={citations} focusId={citation.id}>
      <button
        type="button"
        className={cn(
          'inline-flex max-w-[220px] items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)]',
          className,
        )}
      >
        <Quote className="size-2.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{citationLabel(citation)}</span>
      </button>
    </SourceDrawer>
  );
}

export function CitationList({
  ids,
  citations,
  className,
  emptyLabel = 'No source',
}: {
  ids: readonly string[];
  citations: Citation[];
  className?: string;
  emptyLabel?: string;
}) {
  const resolved = ids
    .map((id) => citations.find((c) => c.id === id))
    .filter((c): c is Citation => Boolean(c));

  if (resolved.length === 0) {
    return (
      <span className={cn('text-[11px] text-[var(--fg-subtle)] italic', className)}>
        {emptyLabel}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {resolved.map((c) => (
        <CitationChip key={c.id} citation={c} citations={citations} />
      ))}
    </span>
  );
}

export function SourceDrawer({
  citations,
  focusId,
  children,
  title = 'Sources',
}: {
  citations: Citation[];
  focusId?: string;
  children: React.ReactNode;
  title?: string;
}) {
  const ordered = React.useMemo(() => {
    if (!focusId) return citations;
    const focused = citations.find((c) => c.id === focusId);
    if (!focused) return citations;
    return [focused, ...citations.filter((c) => c.id !== focusId)];
  }, [citations, focusId]);

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <Drawer
        title={title}
        description={
          citations.length === 0
            ? 'Nothing was cited for this item.'
            : `${citations.length} source${citations.length === 1 ? '' : 's'}. Every claim above points at one of these.`
        }
      >
        {ordered.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">
            No sources were attached. Treat anything above as an unsupported statement.
          </p>
        ) : (
          <ol className="space-y-4">
            {ordered.map((citation, index) => {
              const href = citationHref(citation);
              const external = citation.kind === 'web';
              return (
                <li
                  key={`${citation.id}-${index}`}
                  className={cn(
                    'rounded-md border border-[var(--border)] p-3',
                    citation.id === focusId && 'border-[var(--accent)]',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <FileText
                          className="size-3.5 shrink-0 text-[var(--fg-subtle)]"
                          aria-hidden="true"
                        />
                        <span className="truncate">{citation.label}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                        {citationProvenance(citation)}
                      </p>
                    </div>
                    <ProvenanceBadge kind={kindToProvenance(citation.kind)} />
                  </div>

                  {citation.excerpt ? (
                    <blockquote className="mt-2.5 border-l-2 border-[var(--border-strong)] pl-3">
                      <PlainText
                        text={citation.excerpt}
                        className="text-[13px] text-[var(--fg-muted)]"
                      />
                    </blockquote>
                  ) : null}

                  {href ? (
                    external ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        Open source <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    ) : (
                      <Link
                        href={href}
                        className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                      >
                        Open source
                      </Link>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <p className="mt-6 border-t border-[var(--border)] pt-4 text-xs text-[var(--fg-subtle)]">
          Sources are recorded when a result is generated. A claim shown without a source is either
          the model&rsquo;s inference or your own note — both are labelled as such.
        </p>
      </Drawer>
    </Dialog>
  );
}

function kindToProvenance(
  kind: Citation['kind'],
): React.ComponentProps<typeof ProvenanceBadge>['kind'] {
  switch (kind) {
    case 'attachment':
    case 'document':
      return 'document';
    case 'email':
    case 'email_thread':
      return 'founder_claim';
    case 'web':
      return 'web';
    case 'note':
      return 'nick_note';
    case 'deal':
    case 'calendar_event':
    case 'portfolio_update':
      return 'fact';
    case 'prior_decision':
      return 'human';
    default:
      return 'unknown';
  }
}

/** Small banner shown above any generated block. */
export function GeneratedMeta({
  model,
  promptVersion,
  generatedAt,
  className,
}: {
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 text-[11px] text-[var(--fg-subtle)]',
        className,
      )}
    >
      <Badge tone="outline">
        <span aria-hidden="true">✦</span> AI-generated
      </Badge>
      {model ? <span className="font-mono">{model}</span> : null}
      {promptVersion ? <span className="font-mono">{promptVersion}</span> : null}
      {generatedAt ? <span>{new Date(generatedAt).toLocaleString()}</span> : null}
    </div>
  );
}
