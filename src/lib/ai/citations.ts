import type { Citation } from '@/lib/types/domain';
import type { CitationRef } from './schemas';

/**
 * Citation registry and validation.
 *
 * A model can emit a source id that does not exist — that is a fabricated
 * citation, and it is the failure mode most likely to make a wrong answer look
 * trustworthy. Every structured result passes through here: unknown ids are
 * stripped and reported, and the caller decides whether the surviving evidence
 * still supports the claim.
 */

export class CitationRegistry {
  private readonly byId = new Map<string, Citation>();

  add(citation: Citation): string {
    this.byId.set(citation.id, citation);
    return citation.id;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Citation | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  all(): Citation[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve model-supplied refs into real citations.
   *
   * `page` from the model is only trusted when the source has no page of its
   * own — an email cannot suddenly acquire page 4.
   */
  resolve(refs: readonly (CitationRef | null | undefined)[]): {
    citations: Citation[];
    invalid: string[];
  } {
    const citations: Citation[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    for (const ref of refs) {
      if (!ref?.source_id) continue;
      const base = this.byId.get(ref.source_id);
      if (!base) {
        invalid.push(ref.source_id);
        continue;
      }
      const key = `${base.id}#${ref.page ?? base.page ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      citations.push({
        ...base,
        page: base.page ?? (isPagedKind(base.kind) ? (ref.page ?? null) : null),
        excerpt: ref.quote ?? base.excerpt,
      });
    }

    return { citations, invalid };
  }

  /** Filter a list of refs down to the ones that resolve, returning ids. */
  validIds(refs: readonly (CitationRef | null | undefined)[]): string[] {
    return this.resolve(refs).citations.map((c) => c.id);
  }
}

function isPagedKind(kind: Citation['kind']): boolean {
  return kind === 'attachment' || kind === 'document';
}

/** In-app route that opens the record a citation points at. */
export function citationHref(citation: Citation): string | null {
  switch (citation.kind) {
    case 'email':
      return `/inbox?message=${encodeURIComponent(citation.ref_id)}`;
    case 'email_thread':
      return `/inbox?thread=${encodeURIComponent(citation.ref_id)}`;
    case 'attachment':
      return `/inbox?attachment=${encodeURIComponent(citation.ref_id)}`;
    case 'document':
      return `/knowledge?document=${encodeURIComponent(citation.ref_id)}${
        citation.page ? `&page=${citation.page}` : ''
      }`;
    case 'calendar_event':
      return `/today?event=${encodeURIComponent(citation.ref_id)}`;
    case 'deal':
      return `/deals/${encodeURIComponent(citation.ref_id)}`;
    case 'prior_decision':
      return `/deals/${encodeURIComponent(citation.ref_id)}?tab=decisions`;
    case 'portfolio_update':
      return `/portfolio?update=${encodeURIComponent(citation.ref_id)}`;
    case 'note':
      return `/deals/${encodeURIComponent(citation.ref_id)}?tab=notes`;
    case 'web':
      return citation.url;
  }
}

export function citationLabel(citation: Citation): string {
  const parts = [citation.label];
  if (citation.page) parts.push(`p.${citation.page}`);
  if (citation.section) parts.push(citation.section);
  return parts.join(' · ');
}

/** Short provenance line: who said it and when, for the source drawer. */
export function citationProvenance(citation: Citation): string {
  switch (citation.kind) {
    case 'email':
    case 'email_thread':
      return citation.occurred_at
        ? `Email received ${new Date(citation.occurred_at).toISOString().slice(0, 10)}`
        : 'Email';
    case 'attachment':
      return `Attachment${citation.page ? `, page ${citation.page}` : ''}`;
    case 'document':
      return `Uploaded document${citation.page ? `, page ${citation.page}` : ''}`;
    case 'calendar_event':
      return 'Calendar event';
    case 'deal':
      return 'Deal record';
    case 'prior_decision':
      return citation.occurred_at
        ? `Prior decision, ${new Date(citation.occurred_at).toISOString().slice(0, 10)}`
        : 'Prior decision';
    case 'portfolio_update':
      return 'Portfolio update';
    case 'note':
      return 'Nick’s note';
    case 'web':
      return [
        citation.publisher ?? 'Public web',
        citation.occurred_at
          ? `published ${new Date(citation.occurred_at).toISOString().slice(0, 10)}`
          : 'publication date unknown',
        citation.retrieved_at
          ? `retrieved ${new Date(citation.retrieved_at).toISOString().slice(0, 10)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
  }
}
