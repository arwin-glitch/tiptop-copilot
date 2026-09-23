import { describe, expect, it } from 'vitest';
import { describeDealSorterStatus, type SorterStatusInput } from '@/lib/deals/sorter-status';
import { gmailThreadUrl, httpUrl, websiteHref } from '@/lib/deals/links';

const NOW = new Date('2026-09-23T15:00:00.000Z');

function input(extra: Partial<SorterStatusInput> = {}): SorterStatusInput {
  return {
    isDemo: false,
    state: 'ok',
    missing: [],
    needed: null,
    lastRun: {
      ts: '2026-09-23T13:00:00.000Z',
      backfillDone: ['a1', 'a2', 'a3', 'b1', 'b2', 'c'],
      posted: 14,
    },
    dealCount: 40,
    routineDealCount: 38,
    lastChange: {
      at: '2026-09-23T14:30:00.000Z',
      counts: {
        created: 1,
        updated: 2,
        moved: 1,
        skipped_portfolio: 3,
        skipped_archived: 0,
        retract_flagged: 0,
        failed: 0,
        mirrored: 0,
      },
    },
    rejected: 0,
    now: NOW,
    timezone: 'America/Chicago',
    ...extra,
  };
}

describe('describeDealSorterStatus', () => {
  it('reports a healthy run with its age and what it posted', () => {
    const view = describeDealSorterStatus(input());
    expect(view.tone).toBe('ok');
    expect(view.message).toBe('Kept current by the deal-sorter · last run 2h ago · 14 updated');
    expect(view.detail).toBe(
      'Last change 30m ago: 1 created · 2 updated · 1 moved · 3 skipped (portfolio) · 0 rejected',
    );
  });

  it('keeps reporting the newest change, and names archived skips, flags and failures', () => {
    const view = describeDealSorterStatus(
      input({
        lastChange: {
          at: '2026-09-23T14:55:00.000Z',
          counts: {
            created: 0,
            updated: 1,
            moved: 0,
            skipped_portfolio: 0,
            skipped_archived: 2,
            retract_flagged: 1,
            failed: 1,
            mirrored: 0,
          },
        },
        rejected: 3,
      }),
    );
    expect(view.detail).toBe(
      'Last change 5m ago: 0 created · 1 updated · 0 moved · 0 skipped (portfolio) · 2 skipped (archived) · 1 flagged as not a deal · 1 failed · 3 rejected',
    );
  });

  it('says when saving failed, and when the feed belongs to another workspace', () => {
    expect(describeDealSorterStatus(input({ state: 'save_failed' })).message).toMatch(
      /couldn't save/,
    );
    const other = describeDealSorterStatus(input({ state: 'other_workspace' }));
    expect(other.message).toMatch(/only workspace/);
    expect(other.detail).toBeNull();
  });

  it('shows backfill progress until all six phases are done', () => {
    const view = describeDealSorterStatus(
      input({
        lastRun: {
          ts: '2026-09-23T13:00:00.000Z',
          backfillDone: ['a1', 'a2', 'a3', 'zz'],
          posted: 5,
        },
      }),
    );
    expect(view.message).toMatch(/^Importing your pipeline: 3 of 6 steps done/);
  });

  it('warns when the last run is more than 36 hours old', () => {
    const view = describeDealSorterStatus(
      input({ lastRun: { ts: '2026-09-21T09:50:00.000Z', backfillDone: [], posted: 0 } }),
    );
    expect(view.tone).toBe('warn');
    expect(view.message).toMatch(/last ran 2d ago/);
  });

  it('waits for the first run, in local time, when nothing has run yet', () => {
    const view = describeDealSorterStatus(input({ lastRun: null, routineDealCount: 0 }));
    expect(view.message).toBe(
      "Connected. Waiting for the deal-sorter's first run (09:50 and 20:50 UTC, 4:50 AM and 3:50 PM your time).",
    );
  });

  it('says a run happened and posted nothing', () => {
    const view = describeDealSorterStatus(input({ routineDealCount: 0, dealCount: 2 }));
    expect(view.message).toBe('The deal-sorter ran 2h ago and has not posted any deals yet.');
  });

  it('names the one fix for each setup state', () => {
    expect(
      describeDealSorterStatus(
        input({ state: 'not_configured', missing: ['ASK_RELAY_SLACK_TOKEN'] }),
      ).message,
    ).toMatch(/isn't connected yet: ASK_RELAY_SLACK_TOKEN\.$/);
    expect(describeDealSorterStatus(input({ state: 'bot_not_in_channel' })).message).toMatch(
      /Invite the Copilot Slack app to #deal-relay \(\/invite\)/,
    );
    expect(
      describeDealSorterStatus(input({ state: 'missing_scope', needed: 'groups:history' })).message,
    ).toMatch(/needs groups:history to read a private channel/);
    expect(describeDealSorterStatus(input({ state: 'bad_token' })).configLink).toBe(true);
    expect(describeDealSorterStatus(input({ isDemo: true })).message).toMatch(
      /^Demo workspace: sample deals\./,
    );
  });
});

describe('links built from stored identifiers', () => {
  it('opens a Gmail thread in the connected account, or falls back to the first account', () => {
    expect(gmailThreadUrl('18f3a2b4c5d6e7f0', 'partner@zz-fund.example')).toBe(
      'https://mail.google.com/mail/?authuser=partner%40zz-fund.example#all/18f3a2b4c5d6e7f0',
    );
    expect(gmailThreadUrl('18f3a2b4c5d6e7f0', null)).toBe(
      'https://mail.google.com/mail/u/0/#all/18f3a2b4c5d6e7f0',
    );
    expect(gmailThreadUrl('javascript:alert(1)', null)).toBeNull();
  });

  it('only links websites that are domains, and only http(s) URLs', () => {
    expect(websiteHref('zzquill.example/about')).toBe('https://zzquill.example');
    expect(websiteHref('not a site')).toBeNull();
    // Only a plain hostname: never an address, or a host smuggled after an @.
    expect(websiteHref('jane@zz-a.example')).toBeNull();
    expect(websiteHref('good.example@evil.example')).toBeNull();
    expect(websiteHref('https://good.example@evil.example/')).toBeNull();
    expect(websiteHref('zz quill.example')).toBeNull();
    expect(websiteHref('HTTPS://WWW.ZZ-Quill.example')).toBe('https://zz-quill.example');
    expect(httpUrl('https://zz.example/deck')).toBe('https://zz.example/deck');
    expect(httpUrl('javascript:alert(1)')).toBeNull();
  });
});
