import { describe, expect, it } from 'vitest';
import {
  chooseColumnMode,
  FIT_FILTERS,
  filterRows,
  fitCounts,
  readPipelineView,
  sameViewParams,
  sortRows,
  stageCounts,
  viewParams,
  withViewParams,
  type DealRow,
  type FitFilter,
} from '@/lib/deals/pipeline-view';

/** The pipeline table's column choice, ordering, filters and chip counts. */

const row = (
  companyName: string,
  stageLabel: string,
  stageOrder: number,
  extra: Partial<DealRow> = {},
): DealRow => ({
  id: companyName,
  companyName,
  stageKey: stageLabel.toLowerCase().replace(/ /g, '_'),
  stageLabel,
  stageOrder,
  vertical: null,
  productSummary: null,
  receivedAt: '2026-09-01T00:00:00.000Z',
  recommendation: null,
  qualityScore: null,
  dataCompleteness: null,
  confidence: null,
  facts: '',
  fit: null,
  source: null,
  lastActivity: null,
  nextStep: null,
  evidence: null,
  suggestedStageLabel: null,
  isRoutine: false,
  ...extra,
});

describe('the pipeline table', () => {
  it('shows routine columns only when nothing can score', () => {
    expect(chooseColumnMode({ aiAvailable: false, anyAnalysis: false })).toBe('routine');
    expect(chooseColumnMode({ aiAvailable: false, anyAnalysis: true })).toBe('scores');
    expect(chooseColumnMode({ aiAvailable: true, anyAnalysis: false })).toBe('scores');
  });

  it('sorts by pipeline order, not by label', () => {
    const rows = [
      row('A', 'Passed', 6),
      row('B', 'Diligence', 4),
      row('C', 'Founder meeting', 3),
      row('D', 'New', 0),
    ];
    expect(sortRows(rows, 'stage', 'asc').map((r) => r.stageLabel)).toEqual([
      'New',
      'Founder meeting',
      'Diligence',
      'Passed',
    ]);
  });

  it('sorts by last activity, falling back to when the deal arrived', () => {
    const rows = [
      row('A', 'New', 0, { lastActivity: '2026-09-10' }),
      row('B', 'New', 0, { receivedAt: '2026-09-15T00:00:00.000Z' }),
      row('C', 'New', 0, { lastActivity: '2026-08-01' }),
    ];
    expect(sortRows(rows, 'activity', 'desc').map((r) => r.companyName)).toEqual(['B', 'A', 'C']);
  });
});

describe('the stage and fit filters, applied in the browser', () => {
  const rows = [
    row('Alder', 'New', 0, { fit: 'likely' }),
    row('Birch', 'New', 0, { fit: 'unlikely' }),
    row('Cedar', 'New', 0),
    row('Dogwood', 'Diligence', 4, { fit: 'likely' }),
    row('Elm', 'Diligence', 4, { fit: 'possible' }),
    // A stage the thesis no longer lists: no chip, but still counted in All.
    row('Fir', 'Legacy', Number.MAX_SAFE_INTEGER, { fit: 'likely' }),
  ];

  /** What the server page computed before the filters moved to the browser. */
  function serverView(stage: string, fit: FitFilter | null) {
    const counts = new Map<string, number>();
    for (const d of rows) {
      if (fit && d.fit !== fit) continue;
      counts.set(d.stageKey, (counts.get(d.stageKey) ?? 0) + 1);
    }
    const byFit: Record<string, number> = {};
    for (const d of rows) {
      if (stage && d.stageKey !== stage) continue;
      if (d.fit) byFit[d.fit] = (byFit[d.fit] ?? 0) + 1;
    }
    return {
      counts: Object.fromEntries(counts),
      fits: FIT_FILTERS.map((f) => byFit[f] ?? 0),
      ids: rows
        .filter((d) => (!stage || d.stageKey === stage) && (!fit || d.fit === fit))
        .map((d) => d.id),
    };
  }

  const stages = ['', 'new', 'diligence', 'legacy', 'passed'];
  const fits: (FitFilter | null)[] = [null, ...FIT_FILTERS];
  const combos = stages.flatMap((stage) => fits.map((fit) => [stage, fit] as const));

  it.each(combos)('matches the old server counts for stage %j and fit %j', (stage, fit) => {
    const expected = serverView(stage, fit);
    expect(stageCounts(rows, fit)).toEqual(expected.counts);
    const byFit = fitCounts(rows, stage);
    expect(FIT_FILTERS.map((f) => byFit[f])).toEqual(expected.fits);
    expect(filterRows(rows, { stage, fit }).map((r) => r.id)).toEqual(expected.ids);
  });

  it('counts stages within the fit filter, and fits within the stage filter', () => {
    const counts = stageCounts(rows, 'likely');
    expect(counts).toEqual({ new: 1, diligence: 1, legacy: 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(3);
    expect(fitCounts(rows, 'new')).toEqual({ likely: 1, possible: 0, unlikely: 1 });
    expect(filterRows(rows, { stage: 'diligence', fit: 'likely' }).map((r) => r.id)).toEqual([
      'Dogwood',
    ]);
  });

  it('reads the view from the URL, falling back like the server did', () => {
    expect(readPipelineView(new URLSearchParams(''))).toEqual({
      stage: '',
      fit: null,
      sort: 'received',
      direction: 'desc',
    });
    expect(
      readPipelineView(new URLSearchParams('stage=diligence&fit=likely&sort=company&dir=asc')),
    ).toEqual({ stage: 'diligence', fit: 'likely', sort: 'company', direction: 'asc' });
    expect(readPipelineView(new URLSearchParams('fit=maybe&sort=size&dir=up'))).toEqual({
      stage: '',
      fit: null,
      sort: 'received',
      direction: 'desc',
    });
  });

  it('writes a chosen view into the URL and keeps the search and archived keys', () => {
    const inUrl = viewParams(new URLSearchParams('q=kiln&stage=&archived=1&sort=company&dir=asc'));
    // An empty value is the same as none, so a written URL reads back equal.
    expect(inUrl).toEqual({ stage: null, fit: null, sort: 'company', dir: 'asc' });

    const chosen = { ...inUrl, stage: 'diligence', sort: null, dir: null };
    const written = withViewParams('?q=kiln&stage=&archived=1&sort=company&dir=asc', chosen);
    expect(written.toString()).toBe('q=kiln&stage=diligence&archived=1');
    expect(sameViewParams(viewParams(written), chosen)).toBe(true);
    expect(sameViewParams(viewParams(written), inUrl)).toBe(false);

    const cleared = { stage: null, fit: null, sort: null, dir: null };
    expect(withViewParams(written.toString(), cleared).toString()).toBe('q=kiln&archived=1');
  });
});
