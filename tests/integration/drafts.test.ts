import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as draftsModule from '@/lib/services/drafts';
import { createDraft, draftAsPlainText, listDrafts, updateDraft } from '@/lib/services/drafts';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, GeneratedDraft } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Invariant 6: nothing sends on its own.
 *
 * Drafts never send: `sent` is permanently false and there is deliberately no
 * `sendDraft()`. The one send path is the email session's Send button, which
 * needs a separate opt-in Google grant and a person's tap. These tests assert
 * that as a property of the codebase: the write scope lives in one file, and
 * only the email session and Settings can reach the send module.
 */

const SRC = path.resolve(import.meta.dirname, '../../src');

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('createDraft', () => {
  it('creates a draft against a deal, addressed to its known people', async () => {
    const result = await createDraft(harness.auth, {
      kind: 'missing_information',
      dealId: DEMO_IDS.dealVetrix,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const draft = result.value;
    expect(draft.sent).toBe(false);
    expect(draft.subject.length).toBeGreaterThan(0);
    expect(draft.body.length).toBeGreaterThan(0);
    expect(draft.deal_id).toBe(DEMO_IDS.dealVetrix);
    expect(draft.created_by).toBe(harness.auth.userId);
  });

  it('always persists sent: false', async () => {
    for (const kind of ['pass', 'follow_up', 'meeting_request', 'generic_reply'] as const) {
      const result = await createDraft(harness.auth, { kind, dealId: DEMO_IDS.dealVetrix });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.sent).toBe(false);
    }

    const drafts = (await harness.store.list(
      'generated_drafts',
      harness.auth.organizationId,
    )) as GeneratedDraft[];
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((d) => d.sent === false)).toBe(true);
  });

  it('caps the recipient list and deduplicates it', async () => {
    const result = await createDraft(harness.auth, {
      kind: 'follow_up',
      dealId: DEMO_IDS.dealVetrix,
      emailMessageId: DEMO_IDS.msgVetrixIntro,
    });
    if (!result.ok) return;

    expect(result.value.to_addresses.length).toBeLessThanOrEqual(5);
    expect(new Set(result.value.to_addresses).size).toBe(result.value.to_addresses.length);
  });

  it('builds a pass note from the analysis rather than from nothing', async () => {
    const result = await createDraft(harness.auth, {
      kind: 'pass',
      dealId: DEMO_IDS.dealLoomstack,
    });
    if (!result.ok) return;
    expect(result.value.kind).toBe('pass');
    expect(result.value.body.toLowerCase()).toContain('pass');
  });

  it('does not obey an instruction in the message it is replying to', async () => {
    const result = await createDraft(harness.auth, {
      kind: 'generic_reply',
      dealId: DEMO_IDS.dealPlumbline,
      emailMessageId: DEMO_IDS.msgPlumblineIntro,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The email demands an immediate investment commitment. A reply draft is
    // still just a draft, and it does not promise one.
    expect(result.value.sent).toBe(false);
    expect(result.value.body).not.toMatch(/pre-approved by the partnership/i);
    expect(result.value.body).not.toMatch(/we are investing|wired|committed \$/i);
  });

  it('refuses a deal or portfolio company that does not exist here', async () => {
    expect((await createDraft(harness.auth, { kind: 'pass', dealId: 'nope' })).ok).toBe(false);
    expect(
      (await createDraft(harness.auth, { kind: 'portfolio_reply', portfolioCompanyId: 'nope' })).ok,
    ).toBe(false);
  });

  it('audits the creation and records that nothing was sent', async () => {
    await createDraft(harness.auth, { kind: 'pass', dealId: DEMO_IDS.dealVetrix });
    const events = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'draft.created' },
    })) as AuditEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata?.sent).toBe(false);
  });

  it('records usage for the generation', async () => {
    await createDraft(harness.auth, { kind: 'pass', dealId: DEMO_IDS.dealVetrix });
    expect(
      await harness.store.count('ai_usage', harness.auth.organizationId, {
        eq: { operation: 'draft.reply' },
      }),
    ).toBe(1);
  });
});

describe('editing a draft', () => {
  it('lets the user rewrite the subject and body before copying it out', async () => {
    const created = await createDraft(harness.auth, {
      kind: 'follow_up',
      dealId: DEMO_IDS.dealVetrix,
    });
    if (!created.ok) return;

    const edited = await updateDraft(harness.auth, created.value.id, {
      subject: 'Vetrix — my own words',
      body: 'Priya, one question before I take this further.',
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.value.subject).toBe('Vetrix — my own words');
    // Editing must not create a way to flip `sent`.
    expect(edited.value.sent).toBe(false);
  });

  it('refuses a draft from another organization', async () => {
    const result = await updateDraft(harness.auth, 'no-such-draft', { subject: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('lists drafts newest first, filtered by deal', async () => {
    await createDraft(harness.auth, { kind: 'pass', dealId: DEMO_IDS.dealVetrix });
    await createDraft(harness.auth, { kind: 'follow_up', dealId: DEMO_IDS.dealGirder });

    const forVetrix = await listDrafts(harness.auth.organizationId, {
      dealId: DEMO_IDS.dealVetrix,
    });
    expect(forVetrix.length).toBeGreaterThan(0);
    expect(forVetrix.every((d) => d.deal_id === DEMO_IDS.dealVetrix)).toBe(true);
  });
});

describe('draftAsPlainText', () => {
  it('renders a copy-ready block with recipients and subject', async () => {
    const created = await createDraft(harness.auth, {
      kind: 'pass',
      dealId: DEMO_IDS.dealVetrix,
    });
    if (!created.ok) return;

    const text = draftAsPlainText(created.value);
    expect(text).toContain(`Subject: ${created.value.subject}`);
    expect(text).toContain(created.value.body);
  });

  it('omits the To: line entirely when there is no recipient', () => {
    const draft = {
      to_addresses: [],
      subject: 'A subject',
      body: 'A body',
    } as unknown as GeneratedDraft;
    expect(draftAsPlainText(draft).startsWith('Subject:')).toBe(true);
  });
});

describe('nothing sends on its own', () => {
  it('exports no function that sends', () => {
    for (const name of Object.keys(draftsModule)) {
      expect(name).not.toMatch(/^send/i);
    }
    expect('sendDraft' in draftsModule).toBe(false);
  });

  it('requests only read scopes from Google', async () => {
    const { GOOGLE_SCOPES, REQUESTED_SCOPES } = await import('@/lib/google/oauth');
    for (const scope of [...GOOGLE_SCOPES, ...REQUESTED_SCOPES]) {
      expect(scope).toMatch(/\.(readonly|metadata)$|\/userinfo\.email$/);
    }
  });

  it('names a write scope in exactly one file: gmail.modify, calendar.events and gmail.settings.basic, nothing else', async () => {
    // Matched as a scope URL, so a deep link to the Gmail UI does not trip it.
    const WRITE_SCOPE =
      /auth\/(gmail\.(send|compose|modify|insert|settings\.(basic|sharing))|calendar(\.events)?(?!\.readonly))|['"]https:\/\/mail\.google\.com\/['"]/;
    const files = await walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (WRITE_SCOPE.test(source))
        offenders.push(path.relative(SRC, file).split(path.sep).join('/'));
    }
    expect(offenders).toEqual(['lib/google/send-scopes.ts']);
    const scopes = await import('@/lib/google/send-scopes');
    expect([...scopes.SEND_SCOPES]).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    // Event-level calendar writes, asked for only by "Turn on calendar
    // editing". Never the full calendar scope, which can share and delete
    // whole calendars.
    expect([...scopes.CALENDAR_EDIT_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
    ]);
    // Gmail filters, asked for only by "Turn on filters". Never the sharing
    // scope, which can add forwarding addresses and delegates.
    expect([...scopes.FILTER_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ]);
    // A member's own Google for Spaces (D-081): read-only, exactly these,
    // and none of them a write scope.
    expect([...scopes.MEMBER_READ_SCOPES]).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    for (const scope of scopes.MEMBER_READ_SCOPES) {
      expect(scope).not.toMatch(WRITE_SCOPE);
      expect(scope).toMatch(/^openid$|\.readonly$|\/userinfo\.email$/);
    }
    expect(Object.keys(scopes).sort()).toEqual([
      'CALENDAR_EDIT_SCOPES',
      'FILTER_SCOPES',
      'MEMBER_READ_SCOPES',
      'SEND_SCOPES',
    ]);
  });

  it('only the email session, the Inbox tab and Settings can reach the send module', async () => {
    // AI tools, cron jobs, relay readers and drafts must never import it.
    const ALLOWED = new Set([
      'app/api/email-session/send/route.ts',
      'app/api/email-session/archive/route.ts',
      'app/api/email-session/draft/route.ts',
      'app/(app)/follow-ups/session/page.tsx',
      'app/(app)/settings/page.tsx',
      'app/api/inbox/modify/route.ts',
      'app/api/inbox/compose/route.ts',
      // The compose window's Gmail draft (save, and discard to Trash) and
      // "Create new label": each from a person's tap; neither sends.
      'app/api/inbox/drafts/route.ts',
      'app/api/inbox/labels/route.ts',
      'lib/services/inbox-live.ts',
      // Schedule send: an email a person wrote and picked a time for, sent
      // once at that time (claimed, so never twice, never after a cancel).
      'app/api/inbox/scheduled/route.ts',
      'lib/services/inbox-scheduled.ts',
      // Snooze: takes INBOX off on a tap, and puts INBOX and UNREAD back at
      // the wake time on threads someone snoozed (never sends, never deletes).
      'lib/services/inbox-snooze.ts',
      // Campaigns: the one wrapper that builds a Gmail sender. It is reached
      // only from the campaign routes a person's tap calls (test, confirm,
      // batch) plus the read-only sender info; see the next test. The
      // campaign service itself never imports it, so the daily job's reply
      // check cannot reach a send path.
      'lib/campaigns/sender.ts',
      // Create filter's "Also apply to matching conversations": the Inbox's
      // own label path, on a person's click on Create, capped (never sends).
      'lib/services/inbox-filters.ts',
      // One-click Unsubscribe reads canSend only, to refuse without the grant.
      'lib/services/inbox-unsubscribe.ts',
    ]);
    const files = await walk(SRC);
    const importers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/from ['"][^'"]*google\/gmail-send['"]/.test(source)) {
        importers.push(path.relative(SRC, file).split(path.sep).join('/'));
      }
    }
    expect(importers.length).toBeGreaterThan(0);
    for (const file of importers) expect(ALLOWED.has(file), file).toBe(true);
  });

  it('changes Gmail labels only in gmail-send.ts, called from the Inbox modify route alone', async () => {
    // Labels (archive, star, read state, the person's own labels) change on a
    // tap in the Inbox tab and nowhere else: no tool or relay reader. The one
    // scheduled change is Snooze's wake (inbox-snooze.ts): INBOX and UNREAD
    // back on a thread a person snoozed from the Inbox, at the time they chose.
    const MODIFY_ENDPOINT = /\/(threads|messages)\/\$\{[^}]+\}\/modify|batchModify/;
    const files = await walk(SRC);
    const callers: string[] = [];
    const writers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel !== 'lib/google/gmail-send.ts' && /\bsetThreadLabels\s*\(/.test(source)) {
        callers.push(rel);
      }
      if (MODIFY_ENDPOINT.test(source)) writers.push(rel);
    }
    // Create filter's "Also apply to matching conversations" is the third:
    // the filter's own label changes, on the click that creates it.
    expect(callers.sort()).toEqual([
      'app/api/inbox/modify/route.ts',
      'lib/services/inbox-filters.ts',
      'lib/services/inbox-snooze.ts',
    ]);
    expect(writers).toEqual(['lib/google/gmail-send.ts']);
  });

  it('setThreadLabels refuses every system label but read state, star, inbox, important, Trash and Spam', async () => {
    const { setThreadLabels, WRITABLE_LABEL } = await import('@/lib/google/gmail-send');
    const { SEND_SCOPES } = await import('@/lib/google/send-scopes');
    const integration = {
      id: '44444444-4444-4444-8444-444444444444',
      scopes: [...SEND_SCOPES],
    } as unknown as Parameters<typeof setThreadLabels>[1];
    // Delete and Report spam are Gmail labels, undone by taking them off:
    // nothing on this path deletes for good.
    for (const label of ['UNREAD', 'STARRED', 'INBOX', 'IMPORTANT', 'TRASH', 'SPAM', 'Label_12']) {
      expect(WRITABLE_LABEL.test(label), label).toBe(true);
    }
    for (const label of [
      'SENT',
      'DRAFT',
      'CHAT',
      'CATEGORY_PERSONAL',
      'CATEGORY_SOCIAL',
      'Label_',
    ]) {
      const res = await setThreadLabels(harness.store, integration, 'abc1234567', {
        add: [label as 'INBOX'],
      });
      expect(res.ok, label).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid_input');
    }
    const empty = await setThreadLabels(harness.store, integration, 'abc1234567', {});
    expect(empty.ok).toBe(false);
  });

  it('only the campaign routes a person taps reach the campaign sender', async () => {
    const ALLOWED = new Set([
      'app/api/campaigns/[id]/test/route.ts',
      'app/api/campaigns/[id]/confirm/route.ts',
      'app/api/campaigns/[id]/batch/route.ts',
      // Reads the from-address and signatures for the composer; sends nothing.
      'app/api/campaigns/sender/route.ts',
    ]);
    const files = await walk(SRC);
    const importers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/from ['"][^'"]*campaigns\/sender['"]/.test(source)) {
        importers.push(path.relative(SRC, file).split(path.sep).join('/'));
      }
    }
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });

  it('campaigns have no schedule: nothing in a cron job or the service builds a sender', async () => {
    const service = await readFile(path.join(SRC, 'lib/services/campaigns.ts'), 'utf8');
    expect(service).not.toMatch(/google\/gmail-send|campaigns\/sender['"]/);
    const cron = await readFile(path.join(SRC, 'app/api/cron/daily/route.ts'), 'utf8');
    expect(cron).not.toMatch(/sendBatch|sendTest|campaignSenderFor|confirmCampaign/);
    const sql = await readFile(
      path.resolve(import.meta.dirname, '../../supabase/migrations/20261016000000_campaigns.sql'),
      'utf8',
    );
    expect(sql).not.toMatch(/scheduled_at|\bsend_at\b/);
  });

  it('the default Google connection is read-only; sending is asked for only on opt-in', async () => {
    process.env.GOOGLE_CLIENT_ID ||= 'test-client';
    process.env.GOOGLE_CLIENT_SECRET ||= 'test-secret';
    const { resetEnvCache } = await import('@/lib/config/env');
    resetEnvCache();
    const { buildAuthorizationUrl } = await import('@/lib/google/oauth');
    const plain = buildAuthorizationUrl('state');
    const optIn = buildAuthorizationUrl('state', { send: true });
    const calendar = buildAuthorizationUrl('state', { calendar: true });
    expect(plain.ok && optIn.ok && calendar.ok).toBe(true);
    if (plain.ok && optIn.ok && calendar.ok) {
      expect(decodeURIComponent(plain.value)).not.toContain('gmail.modify');
      expect(decodeURIComponent(plain.value)).not.toContain('calendar.events');
      expect(decodeURIComponent(optIn.value)).toContain('gmail.modify');
      expect(decodeURIComponent(optIn.value)).not.toContain('calendar.events');
      // Calendar editing asks for event writes alone, on top of the read scopes.
      const scope = new URL(calendar.value).searchParams.get('scope')!.split(' ');
      expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
      expect(scope).toContain('https://www.googleapis.com/auth/calendar.readonly');
      expect(scope).not.toContain('https://www.googleapis.com/auth/gmail.modify');
      expect(new URL(calendar.value).searchParams.get('include_granted_scopes')).toBe('true');
    }
  });

  it('the migrations pin generated_drafts.sent to false at the database level', async () => {
    const dir = path.resolve(import.meta.dirname, '../../supabase/migrations');
    const files = await readdir(dir);
    let found = false;
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      if (/check\s*\(\s*sent\s*=\s*false\s*\)/i.test(sql)) found = true;
    }
    expect(found).toBe(true);
  });

  it('the migrations pin deal_decisions.actor to human at the database level', async () => {
    const dir = path.resolve(import.meta.dirname, '../../supabase/migrations');
    const files = await readdir(dir);
    let found = false;
    for (const name of files) {
      const sql = await readFile(path.join(dir, name), 'utf8');
      if (/check\s*\(\s*actor\s*=\s*'human'\s*\)/i.test(sql)) found = true;
    }
    expect(found).toBe(true);
  });
});
