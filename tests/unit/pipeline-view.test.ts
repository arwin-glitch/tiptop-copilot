import { describe, expect, it } from 'vitest';
import { chooseColumnMode, sortRows, type DealRow } from '@/lib/deals/pipeline-view';

/** The pipeline table's column choice and ordering. */

describe('the pipeline table', () => {
  it('shows routine columns only when nothing can score', () => {
    expect(chooseColumnMode({ aiAvailable: false, anyAnalysis: false })).toBe('routine');
    expect(chooseColumnMode({ aiAvailable: false, anyAnalysis: true })).toBe('scores');
    expect(chooseColumnMode({ aiAvailable: true, anyAnalysis: false })).toBe('scores');
  });

  const row = (
    companyName: string,
    stageLabel: string,
    stageOrder: number,
    extra: Partial<DealRow> = {},
  ): DealRow => ({
    id: companyName,
    companyName,
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
