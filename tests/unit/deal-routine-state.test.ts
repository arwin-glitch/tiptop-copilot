import { describe, expect, it } from 'vitest';
import {
  canArchiveOnRetract,
  contentHash,
  DealIndex,
  foldObservations,
  matchName,
  mergeWithSidecar,
  parseSidecar,
  planColumnWrites,
  planRoutineMove,
  routineColumnValues,
  routineOwnsStage,
  stageUntouched,
  type MatchCandidate,
  type RelayObservation,
  type RoutineSidecar,
} from '@/lib/deals/routine-state';
import type { RelayDeal } from '@/lib/services/deal-relay';
import { DEFAULT_DEAL_STAGES } from '@/lib/types/domain';

/** The deal-sorter's pure rules. Every company here is invented. */

const KEYS = DEFAULT_DEAL_STAGES.map((s) => s.key);
let seq = 0;
const obs = (deal: Partial<RelayDeal> & { key?: string }, batch = 'b1'): RelayObservation => ({
  seq: seq++,
  ts: new Date(1_790_000_000_000 + seq * 1000).toISOString(),
  batch,
  part: 1,
  deal: { key: 'zz-quill', name: 'ZZ Quill', ...deal } as RelayDeal,
});

function sidecar(extra: Partial<RoutineSidecar> = {}): RoutineSidecar {
  return {
    v: 1,
    keys: ['zz-quill'],
    aka: [],
    created_by_routine: true,
    view: null,
    stage_set: 'new',
    stage_set_at: '2026-09-10T10:00:00.000Z',
    stage_evidence_date: null,
    fit: null,
    source: null,
    next_step: null,
    first_seen: null,
    last_activity: null,
    threads: [],
    wrote: {},
    retract: null,
    batch: null,
    content_hash: '',
    ...extra,
  };
}

describe('fold', () => {
  it('lets the latest evidence date win, not the latest message', () => {
    const folded = foldObservations([
      obs({ stage: 'diligence', evidence_date: '2026-09-05', evidence: 'data room' }),
      obs({ stage: 'reviewing', evidence_date: '2026-08-20', evidence: 'older phase' }),
    ]);
    expect(folded.view?.stage).toBe('diligence');
    expect(folded.view?.evidence).toBe('data room');
  });

  it('breaks an evidence-date tie in favour of the later message', () => {
    const folded = foldObservations([
      obs({ stage: 'reviewing', evidence_date: '2026-09-05' }),
      obs({ stage: 'founder_meeting', evidence_date: '2026-09-05' }),
    ]);
    expect(folded.view?.stage).toBe('founder_meeting');
  });

  it('unions aliases, founders and threads, and takes min/max dates', () => {
    const folded = foldObservations([
      obs({
        aka: ['Quill CPQ'],
        founders: [{ name: 'Ana Zed' }],
        threads: [{ id: 'abcdef0123' }],
        first_seen: '2026-08-01',
        last_activity: '2026-08-03',
      }),
      obs({
        aka: ['quill cpq', 'ZZ Quill'],
        founders: [{ name: 'ana zed', title: 'CEO' }, { name: 'Bo Yin' }],
        threads: [{ id: 'ABCDEF0123', subject: 'Intro' }, { id: '0123abcdef' }],
        first_seen: '2026-07-15',
        last_activity: '2026-09-01',
      }),
    ]);
    expect(folded.aka).toEqual(['Quill CPQ']);
    expect(folded.founders).toEqual([{ name: 'Ana Zed', title: 'CEO' }, { name: 'Bo Yin' }]);
    expect(folded.threads).toEqual([{ id: 'abcdef0123', subject: 'Intro' }, { id: '0123abcdef' }]);
    expect(folded.first_seen).toBe('2026-07-15');
    expect(folded.last_activity).toBe('2026-09-01');
  });

  it('keeps later non-empty scalars and takes next_step from the newest staged message', () => {
    const folded = foldObservations([
      obs({ summary: 'first', next_step: 'send deck' }),
      obs({ summary: 'second' }),
      obs({ stage: 'founder_meeting', evidence_date: '2026-09-02' }),
    ]);
    expect(folded.summary).toBe('second');
    expect(folded.next_step).toBeUndefined();
    expect(folded.next_step_decided).toBe(true);
  });

  it('honours a retraction only when it is the newest message', () => {
    expect(foldObservations([obs({ summary: 'x' }), obs({ retract: 'a fund' })]).retract).toBe(
      'a fund',
    );
    expect(
      foldObservations([obs({ retract: 'a fund' }), obs({ summary: 'back again' })]).retract,
    ).toBeUndefined();
  });
});

describe('matching', () => {
  const candidate = (extra: Partial<MatchCandidate>): MatchCandidate => ({
    id: 'd1',
    name: 'ZZ Quill',
    normalizedName: matchName('ZZ Quill'),
    domain: null,
    archived: false,
    keys: [],
    aka: [],
    ...extra,
  });

  it('matches by key, then domain, then name, then aka', () => {
    const index = new DealIndex();
    index.add(
      candidate({ id: 'by-key', name: 'Other', normalizedName: 'other', keys: ['zz-quill'] }),
    );
    index.add(
      candidate({
        id: 'by-domain',
        name: 'Else',
        normalizedName: 'else',
        domain: 'zzquill.example',
      }),
    );
    index.add(candidate({ id: 'by-name' }));
    const query = {
      keys: ['zz-quill'],
      name: 'ZZ Quill',
      aka: [],
      website: 'https://zzquill.example',
    };
    expect(index.match(query)?.candidate.id).toBe('by-key');
    expect(index.match({ ...query, keys: [] })?.candidate.id).toBe('by-domain');
    expect(index.match({ ...query, keys: [], website: null })?.candidate.id).toBe('by-name');
  });

  it('matches aliases in both directions', () => {
    const index = new DealIndex();
    index.add(
      candidate({
        id: 'lumenfield',
        name: 'ZZ Lumenfield',
        normalizedName: 'zz lumenfield',
        aka: ['ZZ Pricer'],
      }),
    );
    expect(index.match({ keys: [], name: 'ZZ Pricer', aka: [] })?.via).toBe('aka');
    expect(index.match({ keys: [], name: 'Unknown', aka: ['ZZ Lumenfield'] })?.candidate.id).toBe(
      'lumenfield',
    );
  });

  it('refuses a name match when both sides have different domains', () => {
    const index = new DealIndex();
    index.add(
      candidate({
        id: 'kite-one',
        name: 'Kite',
        normalizedName: 'kite',
        domain: 'kite-one.example',
      }),
    );
    expect(
      index.match({ keys: [], name: 'Kite', aka: [], website: 'kite-two.example' }),
    ).toBeNull();
    expect(index.match({ keys: [], name: 'Kite', aka: [] })?.candidate.id).toBe('kite-one');
  });

  it('ignores free-mail domains', () => {
    const index = new DealIndex();
    index.add(candidate({ id: 'gm', name: 'Other', normalizedName: 'other', domain: 'gmail.com' }));
    expect(index.match({ keys: [], name: 'ZZ Nothing', aka: [], website: 'gmail.com' })).toBeNull();
  });

  it('falls back to the lowercased name when normalizing empties it', () => {
    expect(matchName('AI Labs')).toBe('ai labs');
    const index = new DealIndex();
    index.add(candidate({ id: 'ai', name: 'AI Labs', normalizedName: '' }));
    expect(index.match({ keys: [], name: 'ai labs', aka: [] })?.candidate.id).toBe('ai');
  });

  it('prefers a live deal but still reports an archived match', () => {
    const index = new DealIndex();
    index.add(candidate({ id: 'old', archived: true }));
    expect(index.match({ keys: [], name: 'ZZ Quill', aka: [] })?.candidate.archived).toBe(true);
    index.add(candidate({ id: 'live' }));
    expect(index.match({ keys: [], name: 'ZZ Quill', aka: [] })?.candidate.id).toBe('live');
  });
});

describe('the move matrix (for a stage the routine owns)', () => {
  const view = (stage: string, evidence_date = '2026-09-10') => ({ stage, evidence_date });
  const move = (
    current: string,
    stage: string,
    stageEvidenceDate: string | null = null,
    date?: string,
  ) => planRoutineMove({ current, view: view(stage, date), thesisKeys: KEYS, stageEvidenceDate });

  it('never moves to new', () => {
    expect(move('reviewing', 'new')).toBeNull();
  });

  it('moves to reviewing only from new', () => {
    expect(move('new', 'reviewing')).toBe('reviewing');
    expect(move('diligence', 'reviewing')).toBeNull();
    expect(move('passed', 'reviewing')).toBeNull();
  });

  it('never moves out of invested', () => {
    for (const stage of ['passed', 'monitoring', 'diligence', 'new']) {
      expect(move('invested', stage)).toBeNull();
    }
  });

  it('never sets invested; a deal short of IC review goes to ic_review instead', () => {
    expect(move('diligence', 'invested')).toBe('ic_review');
    expect(move('new', 'invested')).toBe('ic_review');
    expect(move('ic_review', 'invested')).toBeNull();
  });

  it('moves on evidence at least as new as the current stage’s', () => {
    expect(move('founder_meeting', 'diligence', '2026-09-01', '2026-09-10')).toBe('diligence');
    expect(move('founder_meeting', 'diligence', '2026-09-10', '2026-09-10')).toBe('diligence');
    expect(move('diligence', 'passed', '2026-09-12', '2026-09-10')).toBeNull();
  });

  it('only views a stage the thesis does not have, and ignores no-ops', () => {
    expect(
      planRoutineMove({
        current: 'new',
        view: view('diligence'),
        thesisKeys: ['new', 'passed'],
        stageEvidenceDate: null,
      }),
    ).toBeNull();
    expect(move('diligence', 'diligence')).toBeNull();
    expect(
      planRoutineMove({ current: 'new', view: null, thesisKeys: KEYS, stageEvidenceDate: null }),
    ).toBeNull();
  });
});

describe('stage ownership', () => {
  it('holds while the stage is what the routine set and no person has acted since', () => {
    const s = sidecar({ stage_set: 'diligence' });
    expect(
      routineOwnsStage({ dealStage: 'diligence', sidecar: s, latestHumanStageEventAt: null }),
    ).toBe(true);
    expect(
      routineOwnsStage({
        dealStage: 'diligence',
        sidecar: s,
        latestHumanStageEventAt: '2026-09-01T00:00:00+00:00',
      }),
    ).toBe(true);
  });

  it('is lost to a person’s later stage event, even one that restored the same stage', () => {
    const s = sidecar({ stage_set: 'diligence' });
    expect(
      routineOwnsStage({
        dealStage: 'diligence',
        sidecar: s,
        latestHumanStageEventAt: '2026-09-10 10:00:01.5+00',
      }),
    ).toBe(false);
  });

  it('is lost the moment the stage differs, audit row or not', () => {
    expect(stageUntouched('passed', sidecar({ stage_set: 'diligence' }))).toBe(false);
    expect(
      routineOwnsStage({
        dealStage: 'passed',
        sidecar: sidecar({ stage_set: 'diligence' }),
        latestHumanStageEventAt: null,
      }),
    ).toBe(false);
  });

  it('covers a deal the routine never staged only while it is new and untouched', () => {
    expect(
      routineOwnsStage({ dealStage: 'new', sidecar: null, latestHumanStageEventAt: null }),
    ).toBe(true);
    expect(
      routineOwnsStage({
        dealStage: 'new',
        sidecar: null,
        latestHumanStageEventAt: '2026-01-01T00:00:00Z',
      }),
    ).toBe(false);
    expect(
      routineOwnsStage({ dealStage: 'reviewing', sidecar: null, latestHumanStageEventAt: null }),
    ).toBe(false);
  });
});

describe('column ownership by equality', () => {
  it('fills a blank column and remembers it', () => {
    const result = planColumnWrites({ vertical: null }, { vertical: 'Legal' }, {});
    expect(result.patch).toEqual({ vertical: 'Legal' });
    expect(result.wrote).toEqual({ vertical: 'Legal' });
  });

  it('updates a column it wrote that nobody has changed', () => {
    const result = planColumnWrites(
      { vertical: 'Legal' },
      { vertical: 'Legal ops' },
      { vertical: 'Legal' },
    );
    expect(result.patch).toEqual({ vertical: 'Legal ops' });
  });

  it('never touches a column a person or an extraction changed, and forgets it', () => {
    const result = planColumnWrites(
      { vertical: 'Corrected by hand', product_summary: 'extracted' },
      { vertical: 'Legal ops', product_summary: 'routine summary' },
      { vertical: 'Legal' },
    );
    expect(result.patch).toEqual({});
    expect(result.wrote).toEqual({});
  });

  it('writes nothing when the value is already there', () => {
    const result = planColumnWrites(
      { vertical: 'Legal' },
      { vertical: 'Legal' },
      { vertical: 'Legal' },
    );
    expect(result.patch).toEqual({});
    expect(result.wrote).toEqual({ vertical: 'Legal' });
  });

  it('proposes an outcome only for a deal that ends up passed with a reason', () => {
    const passed = foldObservations([
      obs({ stage: 'passed', evidence_date: '2026-09-01', pass_reason: 'consumer hardware' }),
    ]);
    expect(routineColumnValues(passed, 'passed').outcome).toBe('Passed — consumer hardware');
    expect(routineColumnValues(passed, 'diligence').outcome).toBeUndefined();
  });
});

describe('content hash', () => {
  it('ignores message order, batch and alias case', () => {
    const a = foldObservations([
      obs({ aka: ['Quill CPQ'], summary: 's' }, 'batch-1'),
      obs({ threads: [{ id: 'abcdef0123' }] }, 'batch-1'),
    ]);
    const b = foldObservations([
      obs({ threads: [{ id: 'abcdef0123' }] }, 'batch-2'),
      obs({ aka: ['quill cpq'], summary: 's' }, 'batch-2'),
    ]);
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes when the content does', () => {
    const a = foldObservations([obs({ summary: 's' })]);
    const b = foldObservations([obs({ summary: 't' })]);
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

describe('merging with the sidecar', () => {
  it('keeps a newer stored view and what has aged out of the window', () => {
    const entry = foldObservations([
      obs({ stage: 'reviewing', evidence_date: '2026-08-01', aka: ['New alias'] }),
    ]);
    const merged = mergeWithSidecar(
      entry,
      sidecar({
        view: { stage: 'diligence', evidence_date: '2026-09-01' },
        aka: ['Old alias'],
        first_seen: '2026-06-01',
        threads: [{ id: 'abcdef0123' }],
        fit: 'likely',
        next_step: 'call references',
      }),
    );
    expect(merged.view?.stage).toBe('diligence');
    expect(merged.aka).toEqual(['New alias', 'Old alias']);
    expect(merged.first_seen).toBe('2026-06-01');
    expect(merged.threads.map((t) => t.id)).toEqual(['abcdef0123']);
    expect(merged.fit).toBe('likely');
    // A staged message decided next_step (by leaving it out), so it stays cleared.
    expect(merged.next_step).toBeUndefined();
  });

  it('round-trips through the stored form', () => {
    const s = sidecar({ view: { stage: 'passed', evidence_date: '2026-09-01', pass_reason: 'x' } });
    expect(parseSidecar(JSON.stringify(s))).toEqual(s);
    expect(parseSidecar('not json')).toBeNull();
    expect(parseSidecar(null)).toBeNull();
  });
});

describe('retraction', () => {
  const base = {
    createdByRoutine: true,
    ownsStage: true,
    decisions: 0,
    notes: 0,
    tasks: 0,
    humanRestores: 0,
  };
  it('archives only an untouched deal the routine created', () => {
    expect(canArchiveOnRetract(base)).toBe(true);
    expect(canArchiveOnRetract({ ...base, createdByRoutine: false })).toBe(false);
    expect(canArchiveOnRetract({ ...base, ownsStage: false })).toBe(false);
    expect(canArchiveOnRetract({ ...base, notes: 1 })).toBe(false);
    expect(canArchiveOnRetract({ ...base, decisions: 1 })).toBe(false);
    expect(canArchiveOnRetract({ ...base, tasks: 1 })).toBe(false);
    expect(canArchiveOnRetract({ ...base, humanRestores: 1 })).toBe(false);
  });
});
