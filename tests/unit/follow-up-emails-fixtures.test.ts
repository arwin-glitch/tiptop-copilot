import { describe, expect, it } from 'vitest';
import { isLongText, splitQuoted, reflow } from '@/components/inbox/message-view';
import { DEMO_USER } from '@/lib/demo/fixtures';
import { demoFollowUps } from '@/lib/demo/follow-ups-fixtures';
import { demoFollowUpThread, demoFollowUpThreadIds } from '@/lib/demo/follow-up-emails-fixtures';

/**
 * The demo's full emails: one for every follow-up and email session item the
 * demo shows, on `.demo` addresses and links only, never dated ahead of now,
 * and between them every case the panel draws (clamped or not, an
 * attachment, quoted text, a single message).
 */

const NOW = new Date('2026-10-19T03:30:00Z');
const snapshot = demoFollowUps(NOW);
const bare = (s: string) => s.replace(/^\s*(re|fwd?)\s*:\s*/i, '').trim();

/** Every address in a From/To/Cc header, which may list several. */
const addresses = (header: string) =>
  header
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

describe('demo full emails', () => {
  const waiting = snapshot.waiting?.items ?? [];
  const onYou = (snapshot.relationships?.waiting ?? []).filter((w) => w.thread_id);
  const queue = snapshot.emailQueue?.items ?? [];

  it('has a thread for every id the list and the session show', () => {
    const ids = [
      ...waiting.map((w) => w.thread_id),
      ...snapshot.scheduling.map((s) => s.thread_id),
      ...onYou.map((w) => w.thread_id!),
      ...queue.map((q) => q.id),
    ];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(demoFollowUpThread(id, NOW)?.messages.length ?? 0, id).toBeGreaterThan(0);
    }
  });

  it('has none for the meeting recap, a draft the reader leaves out', () => {
    for (const m of snapshot.meetings) {
      if (m.thread_id) expect(demoFollowUpThread(m.thread_id, NOW)).toBeNull();
    }
  });

  it('matches the subjects of the rows that show one', () => {
    for (const row of [...waiting, ...snapshot.scheduling]) {
      expect(bare(demoFollowUpThread(row.thread_id, NOW)!.subject)).toBe(row.subject);
    }
  });

  it("puts Nick's own email last on the threads he is waiting on, at the time the row says", () => {
    for (const row of waiting) {
      const last = demoFollowUpThread(row.thread_id, NOW)!.messages.at(-1)!;
      expect(last.from).toContain(DEMO_USER.email);
      expect(last.date).toBe(row.last_sent_at);
    }
  });

  it('uses .demo addresses and links only, in order and never ahead of now', () => {
    for (const id of demoFollowUpThreadIds(NOW)) {
      const thread = demoFollowUpThread(id, NOW)!;
      let previous = 0;
      for (const m of thread.messages) {
        for (const header of [m.from, m.to, m.cc]) {
          for (const address of addresses(header)) {
            expect(address, id).toMatch(/@[a-z0-9-]+(\.[a-z0-9-]+)*\.demo>?$/i);
          }
        }
        for (const at of m.text.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
          expect(at, id).toMatch(/\.demo$/);
        }
        for (const url of m.text.match(/https?:\/\/[^\s<>()"]+/g) ?? []) {
          expect(new URL(url).hostname, id).toMatch(/\.demo$/);
        }
        const at = Date.parse(m.date ?? '');
        expect(at, id).toBeLessThanOrEqual(NOW.getTime());
        expect(at, id).toBeGreaterThanOrEqual(previous);
        previous = at;
      }
    }
  });

  it('covers every case the panel draws', () => {
    const all = demoFollowUpThreadIds(NOW).map((id) => demoFollowUpThread(id, NOW)!);
    const newest = all.map((t) => t.messages.at(-1)!);
    const main = (text: string) => splitQuoted(reflow(text)).main;
    expect(newest.some((m) => isLongText(main(m.text)))).toBe(true);
    expect(newest.some((m) => !isLongText(main(m.text)))).toBe(true);
    expect(newest.some((m) => m.attachments.length > 0)).toBe(true);
    expect(newest.some((m) => splitQuoted(reflow(m.text)).quoted)).toBe(true);
    expect(all.some((t) => t.messages.length === 1)).toBe(true);
    expect(all.some((t) => t.messages.some((m) => m.cc))).toBe(true);
  });

  it('gives demo attachments no id, so nothing tries to fetch one', () => {
    for (const id of demoFollowUpThreadIds(NOW)) {
      for (const m of demoFollowUpThread(id, NOW)!.messages) {
        for (const a of m.attachments) expect(a.id).toBe('');
      }
    }
  });
});
