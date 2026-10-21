import { describe, expect, it } from 'vitest';
import {
  AFFINITY_EXIT_TOOLS_MAX,
  affinityDailySyncState,
  affinityExitCountdown,
  affinityExitTodayLine,
  applyAffinityExitChange,
  daysLeftLabel,
  daysUntil,
  emptyAffinityExitSettings,
  isAffinityExitDate,
  noticeDateLabel,
  parseAffinityExitSettings,
  type AffinityExitSettings,
} from '@/lib/crm/affinity-exit';
import { affinityImportView, AFFINITY_EXIT_HREF } from '@/lib/records-tabs';

/**
 * The Affinity exit checklist's rules, pure: the date is whatever the
 * workspace typed (nothing is assumed), the countdown and Today's line follow
 * it in the reader's time zone, and "Cancelled" ends both. Every name here is
 * invented.
 */

const TZ = 'America/Chicago';
const at = (iso: string) => new Date(iso);
let ids = 0;
const context = (now = at('2030-03-01T15:00:00Z')) => ({ now, id: () => `tool-${++ids}` });

function apply(
  settings: AffinityExitSettings,
  ...changes: Parameters<typeof applyAffinityExitChange>[1][]
) {
  let current = settings;
  for (const change of changes) {
    const result = applyAffinityExitChange(current, change, context());
    if (!result.ok) throw new Error(result.message);
    current = result.settings;
  }
  return current;
}

describe('the notice date', () => {
  it('is empty until someone sets it', () => {
    const settings = emptyAffinityExitSettings();
    expect(settings).toEqual({ noticeDate: null, cancelled: false, cancelledAt: null, tools: [] });
    expect(affinityExitCountdown(settings, at('2030-03-01T15:00:00Z'), TZ)).toBeNull();
    expect(affinityExitTodayLine(settings, at('2030-03-01T15:00:00Z'), TZ)).toBeNull();
  });

  it('takes only real calendar days', () => {
    expect(isAffinityExitDate('2030-03-15')).toBe(true);
    expect(isAffinityExitDate('2030-02-30')).toBe(false);
    expect(isAffinityExitDate('2030-3-15')).toBe(false);
    expect(isAffinityExitDate('1990-01-01')).toBe(false);
    expect(isAffinityExitDate(20300315)).toBe(false);
    const bad = applyAffinityExitChange(
      emptyAffinityExitSettings(),
      { op: 'date', date: '2030-13-01' },
      context(),
    );
    expect(bad.ok).toBe(false);
  });

  it('counts whole days in the reader’s time zone, not the server’s', () => {
    // 03:00 UTC on Mar 2 is still Mar 1 in Chicago.
    expect(daysUntil('2030-03-15', at('2030-03-02T03:00:00Z'), TZ)).toBe(14);
    expect(daysUntil('2030-03-15', at('2030-03-02T03:00:00Z'), 'UTC')).toBe(13);
    expect(daysUntil('2030-03-15', at('2030-03-15T20:00:00Z'), TZ)).toBe(0);
    expect(daysUntil('2030-03-15', at('2030-03-18T20:00:00Z'), TZ)).toBe(-3);
  });

  it('labels the countdown in plain words', () => {
    expect(daysLeftLabel(0)).toBe('today');
    expect(daysLeftLabel(1)).toBe('tomorrow');
    expect(daysLeftLabel(9)).toBe('in 9 days');
    expect(daysLeftLabel(-1)).toBe('yesterday');
    expect(daysLeftLabel(-4)).toBe('4 days ago');
    expect(noticeDateLabel('2030-03-15')).toBe('Fri, Mar 15');
    expect(noticeDateLabel('2030-03-15', true)).toBe('Fri, Mar 15, 2030');
  });
});

describe("Today's line", () => {
  const set = apply(emptyAffinityExitSettings(), { op: 'date', date: '2030-03-15' });

  it('shows only in the last two weeks and on the day itself', () => {
    expect(affinityExitTodayLine(set, at('2030-02-28T15:00:00Z'), TZ)).toBeNull(); // 15 days
    expect(affinityExitTodayLine(set, at('2030-03-01T15:00:00Z'), TZ)).toEqual({
      dateKey: '2030-03-15',
      daysLeft: 14,
    });
    expect(affinityExitTodayLine(set, at('2030-03-15T15:00:00Z'), TZ)?.daysLeft).toBe(0);
    expect(affinityExitTodayLine(set, at('2030-03-16T15:00:00Z'), TZ)).toBeNull();
  });

  it('is gone once Affinity is marked cancelled, and back if that is undone', () => {
    const cancelled = apply(set, { op: 'cancelled', cancelled: true });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.cancelledAt).toBe('2030-03-01T15:00:00.000Z');
    expect(affinityExitTodayLine(cancelled, at('2030-03-10T15:00:00Z'), TZ)).toBeNull();
    expect(affinityExitCountdown(cancelled, at('2030-03-10T15:00:00Z'), TZ)).toBeNull();

    const undone = apply(cancelled, { op: 'cancelled', cancelled: false });
    expect(undone.cancelledAt).toBeNull();
    expect(affinityExitTodayLine(undone, at('2030-03-10T15:00:00Z'), TZ)?.daysLeft).toBe(5);
  });

  it('keeps the first time it was marked cancelled when marked again', () => {
    const first = apply(set, { op: 'cancelled', cancelled: true });
    const again = applyAffinityExitChange(
      first,
      { op: 'cancelled', cancelled: true },
      context(at('2030-03-09T15:00:00Z')),
    );
    expect(again.ok && again.settings.cancelledAt).toBe(first.cancelledAt);
  });
});

describe('the outside tools', () => {
  it('are added, ticked and removed one change at a time', () => {
    let s = apply(
      emptyAffinityExitSettings(),
      { op: 'add-tool', label: '  Example   notes bridge ' },
      { op: 'add-tool', label: 'Sample enrichment feed' },
    );
    expect(s.tools.map((t) => t.label)).toEqual(['Example notes bridge', 'Sample enrichment feed']);
    const [first, second] = s.tools;
    s = apply(s, { op: 'tick-tool', id: first!.id, done: true });
    expect(s.tools.map((t) => t.done)).toEqual([true, false]);
    s = apply(s, { op: 'remove-tool', id: second!.id });
    expect(s.tools).toEqual([{ id: first!.id, label: 'Example notes bridge', done: true }]);
  });

  it('refuses an empty name or one already listed, whatever its case', () => {
    const s = apply(emptyAffinityExitSettings(), { op: 'add-tool', label: 'Demo Sync' });
    const blank = applyAffinityExitChange(s, { op: 'add-tool', label: '   ' }, context());
    const twice = applyAffinityExitChange(s, { op: 'add-tool', label: 'demo sync' }, context());
    expect(blank.ok).toBe(false);
    expect(!twice.ok && twice.message).toContain('already on the list');
  });

  it('holds a bounded list', () => {
    let s = emptyAffinityExitSettings();
    for (let i = 0; i < AFFINITY_EXIT_TOOLS_MAX; i++) {
      s = apply(s, { op: 'add-tool', label: `Fictional tool ${i}` });
    }
    const over = applyAffinityExitChange(s, { op: 'add-tool', label: 'One more' }, context());
    expect(over.ok).toBe(false);
  });

  it('treats ticking or removing a tool someone else removed as done', () => {
    const s = apply(emptyAffinityExitSettings(), { op: 'add-tool', label: 'Placeholder app' });
    const tick = applyAffinityExitChange(s, { op: 'tick-tool', id: 'gone', done: true }, context());
    expect(tick.ok && tick.settings).toEqual(s);
  });
});

describe('saved settings', () => {
  it('are read defensively: anything malformed is dropped, never thrown', () => {
    expect(parseAffinityExitSettings(null)).toEqual(emptyAffinityExitSettings());
    expect(parseAffinityExitSettings('nope')).toEqual(emptyAffinityExitSettings());
    expect(
      parseAffinityExitSettings({
        noticeDate: 'soon',
        cancelled: 'yes',
        cancelledAt: '2030-01-01T00:00:00Z',
        tools: [
          { id: 'a', label: 'Kept tool', done: true },
          { id: 'a', label: 'Same id again' },
          { id: 'b', label: '   ' },
          { label: 'No id' },
          'text',
        ],
      }),
    ).toEqual({
      noticeDate: null,
      cancelled: false,
      cancelledAt: null,
      tools: [{ id: 'a', label: 'Kept tool', done: true }],
    });
  });
});

describe('the daily sync row', () => {
  it('says running, syncing, stopped or no key', () => {
    expect(affinityDailySyncState({ configured: false, running: false })).toBe('key_missing');
    expect(affinityDailySyncState({ configured: true, running: false, stopped: { at: 'x' } })).toBe(
      'stopped',
    );
    expect(affinityDailySyncState({ configured: true, running: true, stopped: null })).toBe(
      'syncing',
    );
    expect(affinityDailySyncState({ configured: true, running: false, stopped: null })).toBe(
      'running',
    );
  });
});

describe('the Affinity import views', () => {
  it('opens the checklist only on ?view=exit, the import otherwise', () => {
    expect(affinityImportView({ tab: 'import', view: 'exit' })).toBe('exit');
    expect(affinityImportView({ tab: 'import' })).toBe('import');
    expect(affinityImportView({ tab: 'import', view: ['exit', 'x'] })).toBe('exit');
    expect(affinityImportView({ tab: 'import', view: 'zzz' })).toBe('import');
    expect(AFFINITY_EXIT_HREF).toBe('/knowledge?tab=import&view=exit');
  });
});
