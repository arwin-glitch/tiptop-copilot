import { describe, expect, it } from 'vitest';
import {
  buildReaders,
  documentKind,
  matchLp,
  parseDocSendSubject,
  type DocSendView,
} from '@/lib/services/docsend';
import { computeDueAlerts } from '@/lib/services/push-alerts';
import type { FollowUpsSnapshot, LpItem } from '@/lib/services/follow-ups';

const NOW = new Date('2026-10-13T16:00:00Z'); // 11am in Chicago

const lp = (who: string, firm: string | null, stage: LpItem['stage'] = 'contacted'): LpItem => ({
  who,
  firm,
  kind: 'individual',
  stage,
  last_touch_at: null,
  next_step: null,
  thread_id: null,
  note: null,
});

let n = 0;
const view = (
  viewer: string,
  document: string,
  hoursAgo: number,
  downloaded = false,
): DocSendView => {
  n += 1;
  const id = `abc${n.toString(16).padStart(13, '0')}`;
  return {
    messageId: id,
    threadId: id,
    viewer,
    document,
    downloaded,
    at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  };
};

const PROSPECT = 'Acme Ventures — LP Update #12 [Prospective Partner Version]';

describe('DocSend subjects', () => {
  it('reads the viewer, document and download from the subject', () => {
    expect(
      parseDocSendSubject(`jane@harbor.example viewed and downloaded the document ${PROSPECT}`),
    ).toEqual({ viewer: 'jane@harbor.example', document: PROSPECT, downloaded: true });
    expect(parseDocSendSubject('Tiptop weekly activity report')).toBeNull();
  });

  it('tells fundraising material from the LP update', () => {
    expect(documentKind(PROSPECT)).toBe('fundraise');
    expect(documentKind('Acme VC Fund I Deck Final Live')).toBe('fundraise');
    expect(documentKind('LP Update #12 - Summer 2026 [Acme Ventures]')).toBe('lp_update');
    expect(documentKind('Board notes')).toBe('other');
  });
});

describe('matching a viewer to the LP pipeline', () => {
  const lps = [lp('Asya Moss', 'Moses Capital', 'meeting'), lp('Cal McGrath', null, 'committed')];

  it('matches by firm domain and by name on personal mail', () => {
    expect(matchLp('david@mosescapital.example', lps)?.who).toBe('Asya Moss');
    expect(matchLp('calmcgrath@gmail.com', lps)?.who).toBe('Cal McGrath');
    expect(matchLp('someone@gmail.com', lps)).toBeNull();
  });
});

describe('readers', () => {
  it('groups by viewer, drops TipTop, and puts hot prospects first', () => {
    const readers = buildReaders(
      [
        view('old@quiet.example', PROSPECT, 24 * 40),
        view('jane@harbor.example', PROSPECT, 2),
        view('jane@harbor.example', PROSPECT, 30, true),
        view('nick@acme.vc', PROSPECT, 1),
        view('lp@gmail.com', 'LP Update #12 - Summer 2026 [Acme Ventures]', 5),
      ],
      { ownDomain: 'acme.vc', lps: [], now: NOW },
    );
    expect(readers.map((r) => r.email)).toEqual([
      'jane@harbor.example',
      'lp@gmail.com',
      'old@quiet.example',
    ]);
    const jane = readers[0]!;
    expect(jane).toMatchObject({ kind: 'prospect', views: 2, downloaded: true, hot: true });
    expect(jane.domain).toBe('harbor.example');
    expect(readers[1]!.kind).toBe('lp');
    expect(readers[2]!.hot).toBe(false);
  });
});

describe('phone alert', () => {
  const empty = {} as FollowUpsSnapshot;
  const readers = buildReaders(
    [view('jane.doe@harbor.example', PROSPECT, 3), view('lp@gmail.com', 'LP Update #1', 3)],
    { ownDomain: 'acme.vc', lps: [], now: NOW },
  );

  it('pings once when someone outside opens fund materials, never for LP-update reads', () => {
    const alerts = computeDueAlerts(empty, new Set(), NOW, 'America/Chicago', readers);
    const ds = alerts.filter((a) => a.tag === 'docsend');
    expect(ds).toHaveLength(1);
    expect(ds[0]!.title).toBe('Jane Doe (harbor.example) opened your fund materials');
    expect(ds[0]!.url).toBe('/fund-ii');

    const again = computeDueAlerts(empty, new Set(ds[0]!.keys), NOW, 'America/Chicago', readers);
    expect(again.filter((a) => a.tag === 'docsend')).toHaveLength(0);
  });

  it('stays quiet at night', () => {
    const night = new Date('2026-10-13T04:00:00Z');
    expect(computeDueAlerts(empty, new Set(), night, 'America/Chicago', readers)).toEqual([]);
  });
});
