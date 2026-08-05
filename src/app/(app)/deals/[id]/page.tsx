import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, Mail, Paperclip } from 'lucide-react';
import { requireAuth } from '@/lib/auth/session';
import { getDealDetail, factHistory } from '@/lib/services/deals';
import { effectiveRecommendation } from '@/lib/services/deal-analysis';
import { PageHeader, PageShell, DataRow } from '@/components/shell/page-header';
import { Badge, ProvenanceBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Notice, PlainText } from '@/components/ui/feedback';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CitationList, GeneratedMeta, SourceDrawer } from '@/components/evidence/source-drawer';
import {
  AddNoteButton,
  CorrectFieldButton,
  DecisionButtons,
  DraftButtons,
  ExportMemoButton,
  OverrideRecommendationButton,
  ReanalyzeButton,
  RecommendationHeadline,
  ResolveFlagButton,
  StageSelect,
} from '@/components/deals/deal-actions';
import { CreateFollowUpButton, TaskControls } from '@/components/today/today-actions';
import { formatDate, relativeTime } from '@/lib/util/time';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const auth = await requireAuth();
  const detail = await getDealDetail(auth.organizationId, id);
  return { title: detail?.deal.company_name ?? 'Deal' };
}

const FACT_FIELDS: { field: string; label: string }[] = [
  { field: 'website', label: 'Website' },
  { field: 'industry', label: 'Industry' },
  { field: 'vertical', label: 'Vertical' },
  { field: 'geography', label: 'Geography' },
  { field: 'funding_stage', label: 'Funding stage' },
  { field: 'round_size', label: 'Round size' },
  { field: 'amount_raised', label: 'Amount raised' },
  { field: 'valuation_or_cap', label: 'Valuation / cap' },
  { field: 'requested_check', label: 'Requested check' },
  { field: 'revenue', label: 'Revenue' },
  { field: 'growth', label: 'Growth' },
  { field: 'customer_count', label: 'Customer count' },
  { field: 'traction', label: 'Traction' },
  { field: 'pipeline', label: 'Pipeline' },
  { field: 'business_model', label: 'Business model' },
  { field: 'pricing', label: 'Pricing' },
  { field: 'customer', label: 'Customer' },
  { field: 'problem', label: 'Problem' },
  { field: 'solution', label: 'Solution' },
  { field: 'ai_usage', label: 'AI usage' },
  { field: 'market', label: 'Market' },
  { field: 'competition', label: 'Competition' },
  { field: 'team', label: 'Team' },
  { field: 'founder_market_fit', label: 'Founder-market fit' },
  { field: 'gtm_motion', label: 'GTM motion' },
  { field: 'defensibility', label: 'Defensibility' },
  { field: 'data_advantage', label: 'Data advantage' },
  { field: 'referral_source', label: 'Referral source' },
];

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAuth();
  const detail = await getDealDetail(auth.organizationId, id);
  if (!detail) notFound();

  const {
    deal,
    analysis,
    analyses,
    people,
    decisions,
    notes,
    tasks,
    messages,
    attachments,
    facts,
    drafts,
    stages,
  } = detail;
  const recommendation = analysis ? effectiveRecommendation(analysis) : null;
  const citations = analysis?.citations ?? [];
  const openTasks = tasks.filter((t) => t.status === 'open');

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Received ${formatDate(deal.received_at, auth.profile.timezone)}`}
        title={deal.company_name}
        subtitle={
          deal.product_summary ?? 'No product summary has been extracted from the sources yet.'
        }
        actions={
          <>
            <StageSelect dealId={deal.id} stage={deal.stage} stages={stages} />
            <Button asChild variant="secondary" size="sm">
              <Link href={`/ask?deal=${deal.id}`}>Ask about this deal</Link>
            </Button>
            <ExportMemoButton dealId={deal.id} companyName={deal.company_name} />
            <ReanalyzeButton dealId={deal.id} />
          </>
        }
      />

      {deal.website ? (
        <p className="-mt-3 mb-5 text-sm">
          <a
            href={deal.website}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {deal.domain ?? deal.website}
          </a>
        </p>
      ) : null}

      {analysis ? (
        <Card className="mb-6">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle as="h2">Thirty-second overview</CardTitle>
              <GeneratedMeta
                className="mt-1.5"
                model={analysis.model}
                promptVersion={analysis.prompt_version}
                generatedAt={analysis.generated_at}
              />
            </div>
            <div className="flex items-center gap-2">
              <RecommendationHeadline
                recommendation={recommendation!}
                overridden={Boolean(analysis.human_override)}
              />
              <OverrideRecommendationButton
                analysisId={analysis.id}
                dealId={deal.id}
                current={recommendation!}
              />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-[15px] leading-relaxed">{analysis.thirty_second_overview}</p>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Quality"
                value={`${analysis.quality_score}/100`}
                hint={`of ${analysis.attempted_weight} pts attempted`}
              />
              <Metric
                label="Data completeness"
                value={`${analysis.data_completeness}%`}
                hint="of the scorecard evidenced"
              />
              <Metric
                label="Evidence quality"
                value={`${analysis.evidence_quality}%`}
                hint="weighted by source type"
              />
              <Metric
                label="Confidence"
                value={`${analysis.confidence}%`}
                hint="in this recommendation"
              />
            </div>

            <div className="mt-4 rounded-md bg-[var(--bg-sunken)] p-3.5">
              <p className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Recommended next step
              </p>
              <p className="mt-1 text-sm">{analysis.recommended_next_step}</p>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">{analysis.rationale}</p>
            </div>

            {analysis.human_override ? (
              <Notice tone="info" className="mt-4">
                <p className="font-medium">
                  You overrode this from {analysis.recommendation.replace(/_/g, ' ')} to{' '}
                  {analysis.human_override.recommendation.replace(/_/g, ' ')}.
                </p>
                <p className="mt-1 text-[var(--fg-muted)]">{analysis.human_override.note}</p>
              </Notice>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <SourceDrawer citations={citations}>
                <Button variant="secondary" size="sm">
                  View evidence
                  <span className="tabular ml-1 text-[var(--fg-subtle)]">{citations.length}</span>
                </Button>
              </SourceDrawer>
              <AddNoteButton dealId={deal.id} />
              <CreateFollowUpButton dealId={deal.id} />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-6">
          <CardContent className="pt-5">
            <EmptyState
              title="This deal has not been analysed yet"
              description={
                detail.sources.length === 0
                  ? 'Attach an email or a document to this deal first — an analysis with no sources would be a guess.'
                  : 'Run an analysis to score it against your thesis and get diligence questions.'
              }
            />
            <div className="mt-4 flex justify-center">
              <ReanalyzeButton dealId={deal.id} />
            </div>
          </CardContent>
        </Card>
      )}

      {analysis && analysis.red_flags.length > 0 ? (
        <Card className="mb-6 border-[var(--danger)]/30">
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-[var(--danger)]" aria-hidden="true" />
              Red flags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {analysis.red_flags.map((flag) => (
                <li
                  key={flag.label}
                  className="border-b border-[var(--border)] pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Badge tone={flag.severity === 'hard' ? 'danger' : 'warn'}>
                        {flag.severity === 'hard' ? 'Hard' : 'Soft'}
                      </Badge>
                      {flag.label}
                      {flag.resolved ? <Badge tone="ok">Resolved</Badge> : null}
                    </p>
                    {!flag.resolved && flag.severity === 'hard' ? (
                      <ResolveFlagButton
                        analysisId={analysis.id}
                        dealId={deal.id}
                        label={flag.label}
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-[var(--fg-muted)]">{flag.detail}</p>
                  <div className="mt-1.5">
                    <CitationList ids={flag.citation_ids} citations={citations} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[var(--fg-subtle)]">
              An unresolved hard flag caps the recommendation. It does not change the underlying
              score, so resolving it restores the original recommendation without re-analysing.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="scorecard">
        <TabsList>
          <TabsTrigger value="scorecard">Scorecard</TabsTrigger>
          <TabsTrigger value="facts">Key facts</TabsTrigger>
          <TabsTrigger value="diligence">Diligence</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
          <TabsTrigger value="notes">Notes &amp; tasks</TabsTrigger>
          <TabsTrigger value="history">Analysis history</TabsTrigger>
        </TabsList>

        <TabsContent value="scorecard">
          {analysis ? (
            <Card>
              <CardContent className="pt-4">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <caption className="sr-only">Thesis scorecard by category</caption>
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left">
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Category
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Weight
                        </th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">
                          Score
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          Basis
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.categories.map((c) => (
                        <tr key={c.key} className="border-b border-[var(--border)] align-top">
                          <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                            {c.label}
                          </th>
                          <td className="tabular py-2.5 pr-3 text-right text-[var(--fg-muted)]">
                            {c.weight}
                          </td>
                          <td className="tabular py-2.5 pr-3 text-right">
                            {c.score === null ? (
                              <span className="text-[var(--fg-subtle)] italic">unscored</span>
                            ) : (
                              c.score
                            )}
                          </td>
                          <td className="py-2.5">
                            <p className="text-[13px] text-[var(--fg-muted)]">{c.rationale}</p>
                            <div className="mt-1">
                              <CitationList ids={c.citation_ids} citations={citations} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Notice className="mt-4">
                  Scored on {analysis.attempted_weight} of{' '}
                  {analysis.categories.reduce((s, c) => s + c.weight, 0)} available points. A
                  category with no evidence is recorded as <strong>unscored</strong>, not zero — it
                  lowers confidence and completeness rather than dragging the quality score down.
                </Notice>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                      Strongest evidence
                    </h3>
                    <p className="mt-1.5 text-sm">{analysis.strongest_evidence}</p>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                      Biggest concern
                    </h3>
                    <p className="mt-1.5 text-sm">{analysis.biggest_concern}</p>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                      Upside case
                    </h3>
                    <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{analysis.upside_case}</p>
                  </div>
                  <div>
                    <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                      Downside case
                    </h3>
                    <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
                      {analysis.downside_case}
                    </p>
                  </div>
                </div>

                {analysis.competitive_context ? (
                  <div className="mt-5">
                    <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                      Competitive context
                    </h3>
                    <p className="mt-1.5 text-sm text-[var(--fg-muted)]">
                      {analysis.competitive_context}
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">Run an analysis to see the scorecard.</p>
          )}
        </TabsContent>

        <TabsContent value="facts">
          <Card>
            <CardContent className="pt-4">
              <p className="mb-3 text-sm text-[var(--fg-muted)]">
                Extracted from the sources. A field the sources do not state stays{' '}
                <em>Not stated</em> — nothing is inferred to fill a gap. Use the pencil to correct
                anything; both values are kept.
              </p>
              <dl className="divide-y divide-[var(--border)]">
                {FACT_FIELDS.map(({ field, label }) => {
                  const value = (deal as unknown as Record<string, unknown>)[field];
                  const stringValue = typeof value === 'string' ? value : null;
                  const history = factHistory(facts, field);
                  const current = history[0];
                  return (
                    <DataRow key={field} label={label}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {stringValue ? (
                            <span>{stringValue}</span>
                          ) : (
                            <span className="text-[var(--fg-subtle)] italic">Not stated</span>
                          )}
                          {current ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <ProvenanceBadge kind={current.source_type} />
                              {current.evidence_quote ? (
                                <span className="text-[11px] text-[var(--fg-subtle)]">
                                  “{current.evidence_quote.slice(0, 90)}”
                                </span>
                              ) : null}
                              {history.length > 1 ? (
                                <span className="text-[11px] text-[var(--fg-subtle)]">
                                  · {history.length} versions
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          {history.length > 1 ? (
                            <details className="mt-1.5">
                              <summary className="cursor-pointer text-[11px] text-[var(--fg-subtle)]">
                                Show correction history
                              </summary>
                              <ul className="mt-1 space-y-1">
                                {history.map((f) => (
                                  <li key={f.id} className="text-[11px] text-[var(--fg-muted)]">
                                    v{f.version} · {f.source_type} · {f.value ?? <em>unknown</em>}
                                    {f.superseded_by ? ' (superseded)' : ' (current)'}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </div>
                        <CorrectFieldButton
                          dealId={deal.id}
                          field={field}
                          label={label}
                          currentValue={stringValue}
                        />
                      </div>
                    </DataRow>
                  );
                })}
              </dl>

              {people.length > 0 ? (
                <div className="mt-5 border-t border-[var(--border)] pt-4">
                  <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                    People
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {people.map((p) => (
                      <li key={p.id} className="text-sm">
                        <span className="font-medium">{p.name}</span>
                        {p.role ? (
                          <span className="text-[var(--fg-muted)]"> — {p.role}</span>
                        ) : null}
                        {p.email ? (
                          <span className="ml-2 text-xs text-[var(--fg-subtle)]">{p.email}</span>
                        ) : null}
                        {p.background ? (
                          <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
                            {p.background}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="diligence">
          <Card>
            <CardContent className="pt-4">
              {analysis ? (
                <>
                  <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                    Priority diligence questions
                  </h3>
                  {analysis.diligence_questions.length > 0 ? (
                    <ol className="mt-2 space-y-2">
                      {analysis.diligence_questions.map((q, i) => (
                        <li key={i} className="flex gap-3 text-sm">
                          <span className="tabular text-[var(--fg-subtle)]">{i + 1}.</span>
                          <span className="flex-1">{q}</span>
                          <CreateFollowUpButton
                            dealId={deal.id}
                            defaultTitle={q}
                            label="Task"
                            variant="ghost"
                          />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-[var(--fg-muted)]">
                      No questions were generated — usually because there is not yet enough material
                      to ask something specific.
                    </p>
                  )}

                  <h3 className="mt-5 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                    Missing information
                  </h3>
                  {analysis.missing_information.length > 0 ? (
                    <ul className="mt-2 space-y-1.5">
                      {analysis.missing_information.map((m, i) => (
                        <li key={i} className="text-sm text-[var(--fg-muted)]">
                          • {m}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-[var(--fg-muted)]">
                      Every scorecard category had at least some supporting evidence.
                    </p>
                  )}

                  {deal.open_questions.length > 0 ? (
                    <>
                      <h3 className="mt-5 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                        Open questions from the sources
                      </h3>
                      <ul className="mt-2 space-y-1.5">
                        {deal.open_questions.map((q, i) => (
                          <li key={i} className="text-sm text-[var(--fg-muted)]">
                            • {q}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-[var(--fg-muted)]">
                  Run an analysis to generate diligence questions.
                </p>
              )}

              <div className="mt-6 border-t border-[var(--border)] pt-4">
                <h3 className="mb-2 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                  Draft a reply
                </h3>
                <DraftButtons dealId={deal.id} recommendation={recommendation} />
                <p className="mt-2 text-xs text-[var(--fg-subtle)]">
                  Drafts are created for you to review and send yourself. This product has no send
                  capability and requests no send permission.
                </p>
              </div>

              {drafts.length > 0 ? (
                <div className="mt-5">
                  <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                    Saved drafts
                  </h3>
                  <ul className="mt-2 space-y-3">
                    {drafts.map((d) => (
                      <li key={d.id} className="rounded-md border border-[var(--border)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">{d.subject}</p>
                          <Badge tone="outline">{d.kind.replace(/_/g, ' ')} · not sent</Badge>
                        </div>
                        <PlainText
                          text={d.body}
                          className="mt-2 text-[var(--fg-muted)]"
                          maxLines={6}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sources">
          <Card>
            <CardContent className="pt-4">
              {messages.length === 0 && attachments.length === 0 ? (
                <EmptyState
                  title="No sources attached"
                  description="Attach an email from the Inbox to give this deal something to analyse."
                  action={{ label: 'Go to Inbox', href: '/inbox' }}
                />
              ) : (
                <>
                  <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                    Source emails
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {messages.map((m) => (
                      <li key={m.id} className="rounded-md border border-[var(--border)] p-3">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <Mail className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
                          <Link
                            href={`/inbox?message=${m.id}`}
                            className="underline-offset-2 hover:underline"
                          >
                            {m.subject ?? '(no subject)'}
                          </Link>
                          {m.injection_flagged ? <Badge tone="danger">Flagged</Badge> : null}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                          {m.from_name ?? m.from_address} · {relativeTime(m.sent_at)}
                        </p>
                        <PlainText
                          text={m.body_text ?? m.snippet}
                          className="mt-2 text-[var(--fg-muted)]"
                          maxLines={4}
                        />
                      </li>
                    ))}
                  </ul>

                  {attachments.length > 0 ? (
                    <>
                      <h3 className="mt-5 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                        Attachments
                      </h3>
                      <ul className="mt-2 space-y-2">
                        {attachments.map((a) => (
                          <li key={a.id} className="rounded-md border border-[var(--border)] p-3">
                            <p className="flex items-center gap-2 text-sm font-medium">
                              <Paperclip
                                className="size-3.5 text-[var(--fg-subtle)]"
                                aria-hidden="true"
                              />
                              {a.filename}
                              {a.needs_review ? <Badge tone="warn">Needs review</Badge> : null}
                            </p>
                            <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                              {a.page_count ? `${a.page_count} pages · ` : ''}
                              {a.extraction_confidence ?? 'not extracted'} confidence
                            </p>
                            {a.extraction_error ? (
                              <p className="mt-1 text-xs text-[var(--warn)]">
                                {a.extraction_error}
                              </p>
                            ) : null}
                            {a.extracted_text ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-[var(--fg-subtle)]">
                                  Show extracted text
                                </summary>
                                <PlainText
                                  text={a.extracted_text}
                                  className="mt-2 max-h-72 overflow-y-auto text-[var(--fg-muted)]"
                                />
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="decisions">
          <Card>
            <CardContent className="pt-4">
              <h3 className="text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Record a decision
              </h3>
              <p className="mt-1.5 mb-3 text-sm text-[var(--fg-muted)]">
                Only you can record a decision. The assistant recommends; it never decides, and it
                cannot mark a deal invested.
              </p>
              <DecisionButtons dealId={deal.id} />

              {decisions.length > 0 ? (
                <ol className="mt-6 space-y-3 border-t border-[var(--border)] pt-4">
                  {decisions.map((d) => (
                    <li
                      key={d.id}
                      className="border-b border-[var(--border)] pb-3 last:border-b-0 last:pb-0"
                    >
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <Badge
                          tone={
                            d.decision === 'pass'
                              ? 'danger'
                              : d.decision === 'invest'
                                ? 'ok'
                                : 'info'
                          }
                        >
                          {d.decision.replace(/_/g, ' ')}
                        </Badge>
                        <span className="text-[var(--fg-subtle)]">
                          {formatDate(d.decided_at, auth.profile.timezone)}
                        </span>
                        <Badge tone="outline">Human decision</Badge>
                      </p>
                      <p className="mt-1.5 text-sm text-[var(--fg-muted)]">{d.rationale}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-6 text-sm text-[var(--fg-subtle)]">No decisions recorded yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes">
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-2">
                <AddNoteButton dealId={deal.id} />
                <CreateFollowUpButton dealId={deal.id} />
              </div>

              <h3 className="mt-5 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Tasks
              </h3>
              {openTasks.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-subtle)]">No open tasks.</p>
              ) : (
                <ul className="mt-2">
                  {openTasks.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-start justify-between gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t.title}</p>
                        {t.detail ? (
                          <p className="mt-0.5 text-sm text-[var(--fg-muted)]">{t.detail}</p>
                        ) : null}
                        {t.due_at ? (
                          <p className="mt-1 text-xs text-[var(--fg-subtle)]">
                            Due {relativeTime(t.due_at)}
                          </p>
                        ) : null}
                      </div>
                      <TaskControls taskId={t.id} />
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="mt-5 text-[11px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
                Notes
              </h3>
              {notes.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--fg-subtle)]">No notes yet.</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {notes.map((n) => (
                    <li key={n.id} className="rounded-md border border-[var(--border)] p-3">
                      <p className="text-xs text-[var(--fg-subtle)]">
                        {formatDate(n.created_at, auth.profile.timezone)}
                      </p>
                      <PlainText text={n.body} className="mt-1" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardContent className="pt-4">
              {analyses.length === 0 ? (
                <p className="text-sm text-[var(--fg-subtle)]">No analyses yet.</p>
              ) : (
                <ol className="space-y-3">
                  {analyses.map((a) => (
                    <li key={a.id} className="rounded-md border border-[var(--border)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          Version {a.version} ·{' '}
                          {a.human_override?.recommendation ?? a.recommendation}
                        </p>
                        <span className="tabular text-xs text-[var(--fg-subtle)]">
                          {a.quality_score}/100 · {a.data_completeness}% · {a.confidence}%
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-[var(--fg-muted)]">{a.headline}</p>
                      <GeneratedMeta
                        className="mt-2"
                        model={a.model}
                        promptVersion={a.prompt_version}
                        generatedAt={a.generated_at}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-2.5">
      <p className="text-[10px] font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
        {label}
      </p>
      <p className="tabular mt-0.5 font-serif text-lg font-semibold">{value}</p>
      <p className="text-[10px] text-[var(--fg-subtle)]">{hint}</p>
    </div>
  );
}
