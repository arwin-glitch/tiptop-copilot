import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, Globe, Mail } from 'lucide-react';
import { hasRole, requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { statusFieldOf } from '@/lib/crm/fields';
import { formatCrmValue } from '@/lib/crm/view';
import { gmailSearchUrl, websiteHref } from '@/lib/deals/links';
import {
  CRM_MIGRATION_FILE,
  findCopilotLinks,
  getRecord,
  isCrmNotSetUp,
  type CrmCopilotLink,
} from '@/lib/services/crm';
import { getPrimaryIntegration } from '@/lib/services/inbox';
import { getActiveThesis } from '@/lib/services/thesis';
import { CrmNoteList } from '@/components/lists/crm-note-list';
import { ExportNotesLink } from '@/components/lists/export-notes-link';
import { CrmValueView } from '@/components/lists/crm-value';
import { DataRow, PageHeader, PageShell, SectionHeading } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/feedback';
import { NotConfigured } from '@/components/ui/not-configured';
import type { CrmValue } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const auth = await requireAuth();
  const profile = await getRecord(getStore(), auth.organizationId, id, { noteLimit: 1 });
  return { title: profile.ok ? profile.value.record.name : 'Profile' };
}

/**
 * A company's or person's profile: who they are, every list they are on and
 * where they stand on each, every note, and — for a company Copilot already
 * tracks as a deal or a portfolio company — a link across to it. Read-only
 * apart from the links out; the lists are where things are changed.
 */
export default async function RecordProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAuth();
  const store = getStore();
  const org = auth.organizationId;
  const timezone = auth.profile.timezone;

  const found = await getRecord(store, org, id, { noteLimit: 200 });
  if (isCrmNotSetUp(found)) {
    return (
      <PageShell>
        <BackLink />
        <PageHeader title="Profile" />
        <NotConfigured
          title="Lists are not set up yet"
          description={`The CRM tables have not been created in the database. Run ${CRM_MIGRATION_FILE} in the Supabase SQL editor, then reload this page.`}
          stillWorks="Everything else in Copilot works as before."
          action={null}
        />
      </PageShell>
    );
  }
  if (!found.ok && found.error.code === 'not_found') notFound();
  if (!found.ok) {
    return (
      <PageShell>
        <BackLink />
        <PageHeader title="Profile" />
        <ErrorState
          title="This profile could not be loaded"
          message={found.error.message}
          stillUsable="Lists, and everything outside them."
        />
      </PageShell>
    );
  }

  const { record, memberships, notes, related } = found.value;
  const [links, integration] = await Promise.all([
    findCopilotLinks(store, org, record),
    getPrimaryIntegration(store, org).catch(() => null),
  ]);
  const copilot = links.ok ? links.value : [];
  const stageLabels = copilot.some((l) => l.kind === 'deal')
    ? new Map(
        (await getActiveThesis(store, org, auth.userId)).deal_stages.map((s) => [s.key, s.label]),
      )
    : new Map<string, string>();

  const isCompany = record.kind === 'company';
  const site = isCompany ? websiteHref(record.domain) : null;
  const gmail = gmailSearchUrl(
    { domain: isCompany ? record.domain : null, emails: record.emails },
    integration?.account_email,
  );
  const details = Object.entries(record.fields).filter(([, v]) => !isEmpty(v));

  return (
    <PageShell>
      <BackLink />
      <PageHeader
        eyebrow={`${isCompany ? 'Company' : 'Person'} · ${record.source === 'affinity' ? 'from Affinity' : 'added in Copilot'}`}
        title={record.name}
        meta={
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            {isCompany && record.domain ? (
              <li className="inline-flex items-center gap-1.5">
                <Globe className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
                {site ? (
                  <a
                    href={site}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-[var(--accent)] underline-offset-2 hover:underline"
                  >
                    {record.domain}
                  </a>
                ) : (
                  <span className="text-[var(--fg-muted)]">{record.domain}</span>
                )}
              </li>
            ) : null}
            {!isCompany
              ? record.emails.slice(0, 4).map((email) => (
                  <li key={email} className="inline-flex items-center gap-1.5">
                    <Mail className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
                    <a
                      href={`mailto:${email}`}
                      className="text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      {email}
                    </a>
                    {email === record.primary_email && record.emails.length > 1 ? (
                      <Badge tone="outline">primary</Badge>
                    ) : null}
                  </li>
                ))
              : null}
            {gmail ? (
              <li>
                <a
                  href={gmail}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline"
                >
                  Search Gmail
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
              </li>
            ) : null}
          </ul>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby="profile-lists">
            <SectionHeading count={memberships.length}>
              <span id="profile-lists">Lists</span>
            </SectionHeading>
            {memberships.length === 0 ? (
              <p className="text-sm text-[var(--fg-subtle)]">
                Not on any list. {isCompany ? 'Companies' : 'People'} arrive on lists through an
                Affinity import or “Add entry” on a list.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
                {memberships.map(({ entry, list }) => {
                  const status = statusFieldOf(list);
                  const value = status ? entry.values[status.key] : undefined;
                  // The entry's own name when it differs (a deal's "Seed
                  // extension"), then its first two filled-in fields.
                  const facts = [
                    entry.title !== record.name ? entry.title : null,
                    ...list.fields
                      .filter((f) => f.key !== status?.key && !isEmpty(entry.values[f.key]))
                      .slice(0, 2)
                      .map((f) => `${f.name}: ${formatCrmValue(f, entry.values[f.key], timezone)}`),
                    list.archived ? 'archived list' : null,
                  ].filter(Boolean);
                  return (
                    <li key={entry.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <Link
                          href={`/lists/${list.id}?q=${encodeURIComponent(entry.title)}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {list.name}
                        </Link>
                        {status ? (
                          <span className="flex items-center gap-2">
                            <span className="text-mini text-[var(--fg-subtle)]">{status.name}</span>
                            <CrmValueView field={status} value={value} timezone={timezone} />
                          </span>
                        ) : null}
                      </div>
                      {facts.length ? (
                        <p className="text-mini mt-0.5 text-[var(--fg-muted)]">
                          {facts.join(' · ')}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="profile-notes">
            <SectionHeading
              count={notes.length}
              action={
                // The export route serves members and above.
                notes.length > 0 && hasRole(auth, 'member') ? (
                  <ExportNotesLink recordId={record.id} recordName={record.name} />
                ) : null
              }
            >
              <span id="profile-notes">Notes</span>
            </SectionHeading>
            <CrmNoteList
              notes={notes}
              timezone={timezone}
              empty="No notes yet. Notes come across with an Affinity notes export, or are added from a list entry."
            />
          </section>
        </div>

        <aside className="min-w-0 space-y-6">
          {isCompany ? (
            <section aria-labelledby="profile-copilot">
              <SectionHeading>
                <span id="profile-copilot">In Copilot</span>
              </SectionHeading>
              {copilot.length === 0 ? (
                <p className="text-sm text-[var(--fg-subtle)]">
                  {links.ok
                    ? 'Not in Deals or Portfolio under this domain or name.'
                    : 'Deals and Portfolio could not be checked just now.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {copilot.map((link) => (
                    <li key={`${link.kind}-${link.id}`}>
                      <CopilotLinkCard link={link} stageLabels={stageLabels} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {related.length > 0 ? (
            <section aria-labelledby="profile-related">
              <SectionHeading count={related.length}>
                <span id="profile-related">{isCompany ? 'People' : 'Companies'}</span>
              </SectionHeading>
              <ul className="space-y-1">
                {related.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/lists/records/${r.id}`}
                      className="block rounded-md px-2 py-1.5 text-sm hover:bg-[var(--bg-hover)]"
                    >
                      <span className="font-medium">{r.name}</span>
                      {r.primary_email || r.domain ? (
                        <span className="text-mini block truncate text-[var(--fg-muted)]">
                          {r.primary_email ?? r.domain}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {details.length > 0 ? (
            <section aria-labelledby="profile-details">
              <SectionHeading>
                <span id="profile-details">Details</span>
              </SectionHeading>
              <Card>
                <CardContent className="pt-2 pb-2">
                  <dl className="divide-y divide-[var(--border)]">
                    {details.map(([label, value]) => (
                      <DataRow key={label} label={label} className="sm:grid-cols-[120px_1fr]">
                        <CrmValueView field={{ type: 'text' }} value={value} timezone={timezone} />
                      </DataRow>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </section>
          ) : null}
        </aside>
      </div>
    </PageShell>
  );
}

function isEmpty(value: CrmValue | undefined): boolean {
  return (
    value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
  );
}

function CopilotLinkCard({
  link,
  stageLabels,
}: {
  link: CrmCopilotLink;
  stageLabels: Map<string, string>;
}) {
  const stage =
    link.kind === 'deal'
      ? link.stage
        ? (stageLabels.get(link.stage) ?? link.stage)
        : null
      : link.stage;
  return (
    <Link
      href={link.kind === 'deal' ? `/deals/${link.id}` : `/portfolio/${link.id}`}
      className="block rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-3 transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{link.name}</span>
        <Badge tone={link.kind === 'portfolio' ? 'ok' : 'info'}>
          {link.kind === 'portfolio' ? 'Portfolio' : 'Deal'}
        </Badge>
      </span>
      <span className="text-mini mt-1 block text-[var(--fg-muted)]">
        {[
          stage,
          link.archived ? 'archived' : null,
          link.matchedBy === 'domain' ? 'same domain' : 'same name',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </Link>
  );
}

function BackLink() {
  return (
    <Link
      href="/lists"
      className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="size-4" aria-hidden /> All lists
    </Link>
  );
}
