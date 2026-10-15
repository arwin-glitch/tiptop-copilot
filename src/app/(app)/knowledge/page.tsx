import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FileText } from 'lucide-react';
import { requireAuth, type AuthContext } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import {
  hitExcerpt,
  listDocuments,
  listNetworkContacts,
  searchKnowledge,
} from '@/lib/services/knowledge';
import { KNOWLEDGE_TABS, resolvePageTab } from '@/lib/records-tabs';
import { SHOW_PARAM, showMoreHref, shownCount, single } from '@/lib/util/page-tabs';
import { PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState, Notice, SkeletonText } from '@/components/ui/feedback';
import { LiveSearch } from '@/components/ui/live-search';
import { PageTabs } from '@/components/ui/page-tabs';
import { ShowMore } from '@/components/ui/show-more';
import {
  DeleteDocumentButton,
  ImportNetworkButton,
  UploadDocumentButton,
} from '@/components/knowledge/knowledge-client';
import { AffinityImportTab } from '@/components/knowledge/affinity-import-tab';
import { AffinityLists } from '@/components/knowledge/affinity-lists';
import { formatDate } from '@/lib/util/time';

export const metadata: Metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

/** Contact rows rendered per page; an imported network can run to hundreds. */
const CONTACTS_STEP = 50;
/** The contacts box stays on its tab, and a new search starts from page one. */
const CONTACTS_KEEP = { tab: 'contacts' } as const;
const CONTACTS_RESET = [SHOW_PARAM] as const;

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = resolvePageTab(KNOWLEDGE_TABS, params);
  const q = single(params.q) ?? '';

  const auth = await requireAuth();
  const store = getStore();
  // Head counts for the tab badges; a fault only drops the badge. A missing
  // CRM table can read as zero here (a HEAD request), which is what it holds.
  const [documentCount, contactCount, listCount] = await Promise.all([
    store.count('knowledge_documents', auth.organizationId).catch(() => undefined),
    store.count('network_contacts', auth.organizationId).catch(() => undefined),
    store
      .count('crm_lists', auth.organizationId, { eq: { archived: false } })
      .catch(() => undefined),
  ]);
  const counts: Partial<Record<string, number>> = {
    documents: documentCount,
    contacts: contactCount,
    lists: listCount,
  };

  return (
    <PageShell>
      <PageHeader
        title="Knowledge"
        subtitle="Thesis documents, memos, pass notes, market maps, your network, and everything carried over from Affinity. Retrieval is full-text over Postgres, with page-level citations."
        actions={
          <>
            <ImportNetworkButton />
            <UploadDocumentButton />
          </>
        }
      />
      <PageTabs
        label={KNOWLEDGE_TABS.navLabel}
        path={KNOWLEDGE_TABS.path}
        tabs={KNOWLEDGE_TABS.tabs.map((t) => ({
          key: t.key,
          label: t.label,
          count: counts[t.key],
        }))}
        active={tab}
        defaultKey={KNOWLEDGE_TABS.defaultKey}
      />
      <Suspense key={tab} fallback={<SkeletonText lines={8} />}>
        {tab === 'contacts' ? (
          <ContactsTab auth={auth} q={q} shownRaw={params[SHOW_PARAM]} />
        ) : tab === 'lists' ? (
          <AffinityLists auth={auth} q={q} />
        ) : tab === 'import' ? (
          <AffinityImportTab auth={auth} />
        ) : (
          <DocumentsTab auth={auth} q={q} />
        )}
      </Suspense>
    </PageShell>
  );
}

/** Search sits with the documents: it covers their full text, and nothing else. */
async function DocumentsTab({ auth, q }: { auth: AuthContext; q: string }) {
  const [documents, hits] = await Promise.all([
    listDocuments(auth.organizationId),
    q ? searchKnowledge(auth.organizationId, q, 12) : Promise.resolve([]),
  ]);

  return (
    <>
      <LiveSearch
        path="/knowledge"
        value={q}
        placeholder="Search across every uploaded document"
        label="Search knowledge base"
        className="mb-6 max-w-lg"
      />

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

      <section className="mb-8" data-tour="knowledge-documents">
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
    </>
  );
}

async function ContactsTab({
  auth,
  q,
  shownRaw,
}: {
  auth: AuthContext;
  q: string;
  shownRaw: string | string[] | undefined;
}) {
  const contacts = await listNetworkContacts(auth.organizationId, q || undefined);
  const shown = shownCount(shownRaw, CONTACTS_STEP, Math.max(contacts.length, CONTACTS_STEP));
  return (
    <section>
      <SectionHeading count={contacts.length}>
        {q ? `Contacts matching “${q}”` : 'Network'}
      </SectionHeading>
      <LiveSearch
        path="/knowledge"
        keep={CONTACTS_KEEP}
        reset={CONTACTS_RESET}
        value={q}
        placeholder="Search name, company or role"
        label="Search contacts"
        className="mb-4 max-w-sm"
      />
      {contacts.length === 0 && q ? (
        <EmptyState
          title="No contact matches"
          description="Clear the search, or try part of a name, a company or a role."
          action={{ label: 'Clear search', href: '/knowledge?tab=contacts' }}
        />
      ) : contacts.length === 0 ? (
        <Notice>
          No network contacts imported. Introduction suggestions will stay empty rather than naming
          someone the data does not show.
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
              {contacts.slice(0, shown).map((c) => (
                <tr key={c.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{c.full_name}</span>
                    {c.title ? <p className="text-xs text-[var(--fg-subtle)]">{c.title}</p> : null}
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
      <ShowMore
        shown={shown}
        total={contacts.length}
        step={CONTACTS_STEP}
        href={showMoreHref('/knowledge', { tab: 'contacts', q }, shown, CONTACTS_STEP)}
      />
    </section>
  );
}
