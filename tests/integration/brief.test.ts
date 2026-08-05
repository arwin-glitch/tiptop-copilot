import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gatherTodayData,
  generateDailyBrief,
  getTodaysBrief,
  hasAnythingToday,
} from '@/lib/services/brief';
import { resetEnvCache } from '@/lib/config/env';
import { resetRuntime } from '@/lib/runtime';
import type { BriefItem, DailyBrief } from '@/lib/types/domain';
import { todayWindow } from '@/lib/util/time';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The daily outlook.
 *
 * The candidate set is assembled deterministically from stored records; the
 * model narrows and phrases. That is why an item that does not correspond to a
 * record cannot appear, and why an item without a citation must be labelled a
 * suggestion rather than presented as fact.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
  delete process.env.RESEARCH_PROVIDER;
  resetEnvCache();
  resetRuntime();
});

function allItems(brief: DailyBrief): BriefItem[] {
  return [...brief.priorities, ...Object.values(brief.sections).flat()];
}

describe('gatherTodayData', () => {
  it('assembles today from real records in the user’s timezone', async () => {
    const data = await gatherTodayData(harness.auth);

    expect(data.timezone).toBe(harness.auth.profile.timezone);
    expect(data.dateKey).toBe(todayWindow(harness.auth.profile.timezone).dateKey);
    expect(data.meetings.length).toBeGreaterThan(0);
    expect(hasAnythingToday(data)).toBe(true);
  });

  it('only includes events that fall inside today’s local window', async () => {
    const data = await gatherTodayData(harness.auth);
    const window = todayWindow(harness.auth.profile.timezone);

    for (const event of data.meetings) {
      const at = Date.parse(event.starts_at);
      expect(at).toBeGreaterThanOrEqual(window.start.getTime());
      expect(at).toBeLessThan(window.end.getTime());
    }
  });

  it('surfaces overdue follow-ups separately from those due today', async () => {
    const data = await gatherTodayData(harness.auth);
    const now = Date.now();

    expect(data.overdueTasks.length).toBeGreaterThan(0);
    for (const task of data.overdueTasks) {
      expect(Date.parse(task.due_at ?? '')).toBeLessThan(now);
    }
    for (const task of data.dueTodayTasks) {
      expect(Date.parse(task.due_at ?? '')).toBeGreaterThanOrEqual(now);
    }
  });

  it('keeps newsletters and personal mail out of the important-email list', async () => {
    const data = await gatherTodayData(harness.auth);
    for (const email of data.importantEmails) {
      expect(email.category).not.toBe('newsletter_or_market');
      expect(email.category).not.toBe('personal_or_unrelated');
    }
  });

  it('links a meeting to a deal only by an attendee domain already in the pipeline', async () => {
    const data = await gatherTodayData(harness.auth);

    for (const prep of data.meetingPrep) {
      if (!prep.relatedDeal) continue;
      const domains = prep.event.attendees.map((a) => a.email.split('@')[1]?.toLowerCase());
      expect(domains).toContain(prep.relatedDeal.domain);
    }
  });

  it('says plainly when a private meeting has nothing to prepare from', async () => {
    const data = await gatherTodayData(harness.auth);
    const unlinked = data.meetingPrep.filter((p) => !p.relatedDeal && !p.relatedPortfolio);

    for (const prep of unlinked) {
      expect(prep.suggestedPrep).toMatch(/No linked company record|No company in the pipeline/);
    }
  });

  it('reports that research is unavailable rather than leaving it ambiguous', async () => {
    const data = await gatherTodayData(harness.auth);
    expect(data.researchAvailable).toBe(false);
    expect(data.researchUnavailableReason).toBeTruthy();
  });
});

describe('generateDailyBrief', () => {
  it('writes one brief for today, keyed on the local date', async () => {
    const result = await generateDailyBrief(harness.auth);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.date_key).toBe(todayWindow(harness.auth.profile.timezone).dateKey);
    expect(result.value.outlook.length).toBeGreaterThan(0);

    const fetched = await getTodaysBrief(harness.auth);
    expect(fetched?.id).toBe(result.value.id);
  });

  it('returns the stored brief on a second call instead of regenerating', async () => {
    const first = await generateDailyBrief(harness.auth);
    const second = await generateDailyBrief(harness.auth);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
  });

  it('replaces rather than accumulates when forced', async () => {
    await generateDailyBrief(harness.auth);
    const regenerated = await generateDailyBrief(harness.auth, { force: true });
    expect(regenerated.ok).toBe(true);

    const briefs = await harness.store.count('daily_briefs', harness.auth.organizationId, {
      eq: {
        user_id: harness.auth.userId,
        date_key: todayWindow(harness.auth.profile.timezone).dateKey,
      },
    });
    expect(briefs).toBe(1);
  });

  it('cites only sources the brief actually assembled', async () => {
    const result = await generateDailyBrief(harness.auth);
    if (!result.ok) return;

    const known = new Set(result.value.citations.map((c) => c.id));
    for (const item of allItems(result.value)) {
      for (const id of item.citation_ids) expect(known.has(id)).toBe(true);
    }
  });

  it('labels an uncited item as a suggestion rather than presenting it as a record', async () => {
    const result = await generateDailyBrief(harness.auth);
    if (!result.ok) return;

    for (const item of allItems(result.value)) {
      if (item.citation_ids.length === 0) expect(item.is_suggestion).toBe(true);
    }
  });

  it('contains no item that does not correspond to a stored record', async () => {
    const data = await gatherTodayData(harness.auth);
    const result = await generateDailyBrief(harness.auth, { force: true });
    if (!result.ok) return;

    const realTitles = new Set([
      ...data.meetings.map((m) => m.title),
      ...data.newDeals.map((d) => d.company_name),
      ...data.overdueTasks.map((t) => t.title),
      ...data.dueTodayTasks.map((t) => t.title),
    ]);

    for (const item of result.value.sections.meetings) {
      expect(realTitles.has(item.title)).toBe(true);
    }
    for (const item of result.value.sections.new_deals) {
      expect(realTitles.has(item.title)).toBe(true);
    }
  });

  it('returns an empty market-signals section when research is off', async () => {
    const result = await generateDailyBrief(harness.auth);
    if (!result.ok) return;
    expect(result.value.sections.market_signals).toEqual([]);
  });

  it('records the model and prompt version it was produced with', async () => {
    const result = await generateDailyBrief(harness.auth);
    if (!result.ok) return;
    expect(result.value.model).toBeTruthy();
    expect(result.value.prompt_version).toBeTruthy();
  });

  it('audits generation', async () => {
    await generateDailyBrief(harness.auth, { force: true });
    const events = await harness.store.count('audit_events', harness.auth.organizationId, {
      eq: { action: 'brief.generated' },
    });
    expect(events).toBeGreaterThan(0);
  });

  it('keys the brief to the day the caller asked about, not the server’s day', async () => {
    // 01:30 UTC is still the previous day in Chicago.
    const lateUtc = new Date('2026-08-02T01:30:00.000Z');
    const result = await generateDailyBrief(harness.auth, { force: true, now: lateUtc });
    if (!result.ok) return;
    expect(result.value.date_key).toBe('2026-08-01');
  });
});
