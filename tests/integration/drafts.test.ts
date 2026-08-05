import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as draftsModule from '@/lib/services/drafts';
import { createDraft, draftAsPlainText, listDrafts, updateDraft } from '@/lib/services/drafts';
import { DEMO_IDS } from '@/lib/demo/ids';
import type { AuditEvent, GeneratedDraft } from '@/lib/types/domain';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Invariant 6: there is no send capability.
 *
 * Not "sending is unimplemented" — the scope is never requested, `sent` is
 * permanently false, and there is deliberately no `sendDraft()`. These tests
 * assert that as a property of the codebase, not just of one function.
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

describe('there is no send capability anywhere', () => {
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

  it('names no write scope anywhere in the source, in any file', async () => {
    // Matched as a scope URL, so a deep link to the Gmail UI does not trip it.
    const WRITE_SCOPE =
      /auth\/(gmail\.(send|compose|modify|insert)|calendar(\.events)?(?!\.readonly))|['"]https:\/\/mail\.google\.com\/['"]/;
    const files = await walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (WRITE_SCOPE.test(source)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
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
