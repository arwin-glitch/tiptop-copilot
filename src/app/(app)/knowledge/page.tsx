import type { Metadata } from 'next';
import { FileText, Search } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import {
  hitExcerpt,
  listDocuments,
  listNetworkContacts,
  searchKnowledge,
} from '@/lib/services/knowledge';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, Notice } from '@/components/ui/feedback';
import { Input } from '@/components/ui/form';
import {
  DeleteDocumentButton,
  ImportNetworkButton,
  UploadDocumentButton,
} from '@/components/knowledge/knowledge-client';
import { formatDate } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = single(params.q) ?? '';

  const auth = await requireAuth();
  const [documents, contacts, hits] = await Promise.all([
    listDocuments(auth.organizationId),
    listNetworkContacts(auth.organizationId),
    q ? searchKnowledge(auth.organizationId, q, 12) : Promise.resolve([]),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Knowledge"
        subtitle="Thesis documents, memos, pass notes, market maps and your network. Retrieval is full-text over Postgres, with page-level citations."
        actions={
          <>
            <ImportNetworkButton />
            <UploadDocumentButton />
          </>
        }
      />

      <form className="relative mb-6 max-w-lg" action="/knowledge">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"
          aria-hidden="true"
        />
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search across every uploaded document"
          aria-label="Search knowledge base"
          className="pl-8"
        />
      </form>

      {q ? (
        <section className="mb-8">
          <SectionHeading count={hits.length}>Results for “{q}”</SectionHeading>
          {hits.length === 0 ? (
            <EmptyState
              title="Nothing matched"
              description="Try fewer or more general words. Search covers the full text of every uploaded document."
            />
          ) : (
            <ul className="space-y-3">
              {hits.map((hit) => (
                <li key={hit.chunkId}>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <FileText className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
                        {hit.documentTitle}
                        <Badge tone="outline">{hit.docType.replace(/_/g, ' ')}</Badge>
                        {hit.page ? <Badge tone="neutral">page {hit.page}</Badge> : null}
                      </p>
                      {hit.section ? (
                        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">{hit.section}</p>
                      ) : null}
                      <p className="mt-2 text-sm text-[var(--fg-muted)]">{hitExcerpt(hit)}</p>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="mb-8">
        <SectionHeading count={documents.length}>Documents</SectionHeading>
        {documents.length === 0 ? (
          <EmptyState
            title="No documents uploaded"
            description="Upload your thesis, past memos and pass notes. They become searchable and are cited when they inform an answer."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {doc.title}
                    <Badge tone="outline">{doc.doc_type.replace(/_/g, ' ')}</Badge>
                    {doc.needs_review ? <Badge tone="warn">Needs review</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                    {[
                      doc.filename,
                      `${(doc.size_bytes / 1024).toFixed(0)} KB`,
                      doc.page_count ? `${doc.page_count} pages` : null,
                      `${doc.chunk_count} passages`,
                      `${doc.extraction_confidence ?? 'unknown'} extraction confidence`,
                      formatDate(doc.created_at, auth.profile.timezone),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {doc.extraction_error ? (
                    <p className="mt-1 text-xs text-[var(--warn)]">{doc.extraction_error}</p>
                  ) : null}
                </div>
                <DeleteDocumentButton documentId={doc.id} title={doc.title} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading count={contacts.length}>Network</SectionHeading>
        {contacts.length === 0 ? (
          <Notice>
            No network contacts imported. Introduction suggestions will stay empty rather than
            naming someone the data does not show.
          </Notice>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Network contacts</caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Company
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Relationship
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Expertise
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{c.full_name}</span>
                      {c.title ? (
                        <p className="text-xs text-[var(--fg-subtle)]">{c.title}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--fg-muted)]">{c.company ?? '—'}</td>
                    <td className="px-4 py-2.5 text-[var(--fg-muted)]">{c.relationship ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {c.expertise.length === 0 ? (
                          <span className="text-[var(--fg-subtle)]">—</span>
                        ) : (
                          c.expertise.map((e) => (
                            <Badge key={e} tone="neutral">
                              {e}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageShell>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
