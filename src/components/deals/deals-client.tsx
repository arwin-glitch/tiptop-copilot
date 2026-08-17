'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { GitCompare, Search } from 'lucide-react';
import { compareDealsAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, FieldLabel } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { PlainText } from '@/components/ui/feedback';
import { FilterChip, FilterChipRow } from '@/components/ui/toolbar';
import type { DealStage } from '@/lib/types/domain';

export function DealsFilterBar({
  stages,
  counts,
  stage,
  q,
}: {
  stages: DealStage[];
  counts: Record<string, number>;
  stage: string;
  q: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = React.useState(q);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    router.push(`/deals?${next.toString()}`);
  };

  return (
    <div className="space-y-3">
      <form
        className="relative max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', query);
        }}
      >
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, product, team"
          aria-label="Search deals"
          className="pl-8"
        />
      </form>

      <FilterChipRow aria-label="Filter by stage">
        <FilterChip
          pressed={!stage}
          label="All"
          count={Object.values(counts).reduce((a, b) => a + b, 0)}
          onToggle={() => setParam('stage', null)}
        />
        {stages.map((s) => (
          <FilterChip
            key={s.key}
            pressed={stage === s.key}
            label={s.label}
            count={counts[s.key] ?? 0}
            onToggle={() => setParam('stage', s.key)}
          />
        ))}
      </FilterChipRow>
    </div>
  );
}

interface Dimension {
  dimension: string;
  assessments: { deal_id: string; assessment: string; stronger: boolean | null }[];
}

export function ComparePanel({ deals }: { deals: { id: string; company_name: string }[] }) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<{
    answer: string;
    whatWouldChange: string[];
    dimensions: Dimension[];
  } | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 4 ? prev : [...prev, id],
    );

  const nameFor = (id: string) => deals.find((d) => d.id === id)?.company_name ?? id;

  return (
    <div className="mt-5">
      <details className="group rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)]">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium">
          <GitCompare className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
          Compare deals
          <span className="text-[var(--fg-subtle)]">
            {selected.length > 0 ? `${selected.length} selected` : 'pick two to four'}
          </span>
        </summary>
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {deals.map((d) => (
              <FilterChip
                key={d.id}
                label={d.company_name}
                pressed={selected.includes(d.id)}
                onToggle={() => toggle(d.id)}
              />
            ))}
          </div>

          <Button
            className="mt-3"
            size="sm"
            variant="primary"
            disabled={selected.length < 2}
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const response = await compareDealsAction(selected);
                if (response.ok && response.data) {
                  setResult({
                    answer: response.data.answer,
                    whatWouldChange: response.data.whatWouldChange,
                    dimensions: response.data.dimensions as Dimension[],
                  });
                } else {
                  toast.error(response.error?.message ?? 'Comparison failed');
                }
              })
            }
          >
            Compare {selected.length > 0 ? `(${selected.length})` : ''}
          </Button>

          {result ? (
            <Card className="mt-4">
              <CardContent className="pt-4">
                <Badge tone="outline" className="mb-2">
                  <span aria-hidden="true">✦</span> AI-generated
                </Badge>
                <PlainText text={result.answer} className="text-[15px]" />

                {result.dimensions.length > 0 ? (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <caption className="sr-only">Deal comparison by dimension</caption>
                      <thead>
                        <tr className="border-b border-[var(--border)] text-left">
                          <th scope="col" className="py-2 pr-3 font-medium">
                            Dimension
                          </th>
                          {selected.map((id) => (
                            <th key={id} scope="col" className="py-2 pr-3 font-medium">
                              {nameFor(id)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.dimensions.map((dim) => (
                          <tr
                            key={dim.dimension}
                            className="border-b border-[var(--border)] align-top"
                          >
                            <th
                              scope="row"
                              className="py-2.5 pr-3 text-left font-normal text-[var(--fg-muted)]"
                            >
                              {dim.dimension}
                            </th>
                            {selected.map((id) => {
                              const cell = dim.assessments.find((a) => a.deal_id === id);
                              return (
                                <td key={id} className="py-2.5 pr-3">
                                  {cell ? (
                                    <>
                                      {cell.stronger ? (
                                        <Badge tone="ok" className="mb-1">
                                          Stronger
                                        </Badge>
                                      ) : cell.stronger === null ? (
                                        <Badge tone="neutral" className="mb-1">
                                          Unknown
                                        </Badge>
                                      ) : null}
                                      <p className="text-[13px]">{cell.assessment}</p>
                                    </>
                                  ) : (
                                    <span className="text-[var(--fg-subtle)] italic">—</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {result.whatWouldChange.length > 0 ? (
                  <div className="mt-4">
                    <FieldLabel as="h4">What would change the answer</FieldLabel>
                    <ul className="mt-1.5 space-y-1">
                      {result.whatWouldChange.map((item, i) => (
                        <li key={i} className="text-sm text-[var(--fg-muted)]">
                          • {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </details>
    </div>
  );
}
